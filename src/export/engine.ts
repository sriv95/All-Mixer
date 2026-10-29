// The export engine gets the sound of the video (the audio the player already downloaded, else a real-time recording), cuts it in
// chunks of at most MAX_CHUNK_S, separates / mixes / encodes each chunk, and assembles the file. An MP4 is the karaoke text drawn
// on a plain background, with or without that sound: the picture of the video is never recorded. Loaded on demand by src/content/export-run.ts
// as a module of its own (it carries the encoders), never as part of the content script.
import type { LyricLine } from '../lyrics/types';
import {
  EXPORT_SAMPLE_RATE,
  clock,
  hasAudio,
  needsSeparation,
  safeFileName,
  tracksOf,
  type ExportOptions,
  type ExportProgress,
  type ExportStage,
} from '../shared/export';
import { openCapture, planar, type Capture } from './capture';
import { VIDEO_FPS, breathe, mp3Sink, mp4Sink, pictureSize, type ExportFile, type Sink } from './encode';
import { drawKaraoke, karaokeRows } from './karaoke-render';
import { mixSlice, type StemSlice } from './mix';
import { openMlSession, type MlSession, type OpenMlSession } from './ml-session';
import { fastAudio, type AudioTap, type Pcm } from './fast-audio';
import { chunkAt, planChunks } from './plan';
import { Resampler } from './resample';

export type { ExportFile } from './encode';
export type { AudioTap } from './fast-audio';
export { stemsOfSlice } from './mix';

export interface ExportDeps {
  video: HTMLVideoElement;
  options: ExportOptions;
  /** Synced lyrics for the karaoke text of the MP4 (offset in ms: positive shows the lyrics later); null = no text. */
  lyrics: { lines: LyricLine[]; offsetMs: number } | null;
  title: string;
  signal: AbortSignal;
  report(p: ExportProgress): void;
  /** Called while recording: a message when the recording went wrong (an ad, another video). */
  problem?: () => string | null;
  /** The audio the player already downloaded (src/page/audio-tap.ts): when it holds all of it, MP3 and preload skip the real-time recording. */
  tap?: AudioTap;
  /** Tests. */
  openSession?: OpenMlSession;
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
  }
}

/** Chunks waiting for the model / encoder before the video is paused (the memory of a chunk is 5 MB). */
const MAX_QUEUE = 3;
/** Without a sample from the player for this long while it should play, the export fails. */
const STALL_MS = 20_000;
const POLL_MS = 400;
const SEEK_TIMEOUT_MS = 15_000;
/** The recording ends this close to the end of the video: stopping before `ended` keeps YouTube from starting the next video. */
const END_MARGIN_S = 0.05;

/** A wait that ends at `notify()`, or after `ms` as a safety net: a hidden tab runs timers once a second, so loops must not poll. */
class Wake {
  private done: (() => void) | null = null;
  wait(ms = 1000): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.done = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.done = finish;
    });
  }
  notify(): void {
    this.done?.();
  }
}

/** A reader whose wait can time out without losing the value that arrives later. */
class Puller<T> {
  private pending: Promise<ReadableStreamReadResult<T>> | null = null;
  constructor(private readonly reader: ReadableStreamDefaultReader<T>) {}
  async next(ms: number): Promise<ReadableStreamReadResult<T> | 'timeout'> {
    this.pending ??= this.reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), ms)));
    const got = await Promise.race([this.pending, timeout]);
    clearTimeout(timer);
    if (got !== 'timeout') this.pending = null;
    return got;
  }
}

async function seekToStart(v: HTMLVideoElement): Promise<void> {
  if (v.currentTime < 0.01 && !v.seeking) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The video did not go back to the start')), SEEK_TIMEOUT_MS);
    v.addEventListener('seeked', () => (clearTimeout(t), resolve()), { once: true });
    v.currentTime = 0;
  });
}

interface Job {
  l: Float32Array;
  r: Float32Array;
  start: number;
  last: boolean;
}

/** Receives the stems of every piece of the recording, in order (Preload Audio: they are kept in memory instead of being encoded). */
export type SliceSink = (s: StemSlice) => void | Promise<void>;

export async function runExport(d: ExportDeps): Promise<ExportFile> {
  return (await record(d))!;
}

/** The recording and separation of an export, without the encoders: `onSlice` gets the stems. Resolves when the whole video was handed over. */
export async function runPreload(d: ExportDeps, onSlice: SliceSink): Promise<void> {
  await record(d, onSlice);
}

async function record(d: ExportDeps, onSlice?: SliceSink): Promise<ExportFile | null> {
  const { video: v, options: o } = d;
  const dur = v.duration;
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('This video has no fixed length (a live stream cannot be exported)');
  const plan = planChunks(dur);
  const tracks = tracksOf(o);
  const name = safeFileName(d.title);
  const mp4 = o.format === 'mp4';
  /** An MP4 without sound: only the text is drawn, nothing is recorded or separated. */
  const silent = mp4 && !hasAudio(o);
  const rate = EXPORT_SAMPLE_RATE;
  const ac = new AbortController();
  /** Why the run stopped, when it did not finish: a cancel from the popup is an ExportCancelled, anything else an error. */
  let stopped: Error | null = null;
  const stop = (e: Error): void => {
    stopped ??= e;
    ac.abort();
    capture?.stop(); // wakes the readers
  };
  const onCancel = () => stop(new ExportCancelled());
  if (d.signal.aborted) throw new ExportCancelled();
  d.signal.addEventListener('abort', onCancel);

  // ---- progress
  let stage: ExportStage = 'preparing';
  let note = '';
  let recorded = 0; // samples
  let rendered = 0; // seconds of picture written
  let fetched = 0; // 0–1 of the audio read from the player
  let processed = 0; // chunks
  let lastReport = 0;
  const report = (force = false): void => {
    const now = performance.now();
    if (!force && now - lastReport < 250) return;
    lastReport = now;
    const t = Math.min(dur, silent ? rendered : recorded / rate);
    const percent = stage === 'recording' ? Math.min(98, silent ? (100 * rendered) / dur : (100 * recorded) / plan.total) : stage === 'finishing' ? 99 : 0;
    const chunk = chunkAt(plan, Math.min(recorded, plan.total - 1));
    const detail =
      stage === 'model'
        ? note
        : stage === 'fetching'
          ? `Reading the audio from the player… ${Math.floor(100 * fetched)}%`
          : stage === 'recording'
            ? silent
              ? `Drawing the text · ${clock(t)} / ${clock(dur)}`
              : `Chunk ${chunk}/${plan.count} · ${clock(t)} / ${clock(dur)} · ${processed} of ${plan.count} processed`
          : stage === 'finishing'
            ? processed < plan.count
              ? `Processing the last chunks (${processed} of ${plan.count} done)…`
              : onSlice
                ? 'Finishing…'
                : 'Writing the file…'
            : 'Getting ready…';
    d.report({ state: 'running', stage, chunk: stage === 'recording' && !silent ? chunk : 0, chunks: silent ? 0 : plan.count, percent, detail });
  };
  const at = (s: ExportStage, n = ''): void => {
    stage = s;
    note = n;
    report(true);
  };
  const check = (): void => {
    if (ac.signal.aborted) throw stopped ?? new ExportCancelled();
  };

  const saved = { src: v.currentSrc, time: v.currentTime, paused: v.paused, muted: v.muted, rate: v.playbackRate };
  let restored = silent; // a silent MP4 does not touch the video
  /** Back to what the user had, unless the player moved on to another video. */
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (v.currentSrc !== saved.src) return;
    v.pause();
    v.muted = saved.muted;
    v.playbackRate = saved.rate;
    v.currentTime = saved.time;
    if (!saved.paused) void v.play().catch(() => {});
  };
  let session: MlSession | null = null;
  let sink: Sink | null = null;
  let capture: Capture | null = null;
  let onChanged: () => void = () => {};
  const ticker = setInterval(() => report(), 500);
  try {
    // ---- 1. the model, only when the stems matter
    at('preparing');
    if (!silent && needsSeparation(o)) {
      const t0 = performance.now();
      const warm = setInterval(() => at('model', `Starting the model on your GPU… ${Math.round((performance.now() - t0) / 1000)} s (10 to 40 s the first time)`), 1000);
      at('model', 'Starting the model on your GPU…');
      try {
        session = await (d.openSession ?? openMlSession)(o.audio, ac.signal);
      } finally {
        clearInterval(warm);
      }
      check();
    }

    // ---- 2. the encoders
    const size = pictureSize(o.height);
    if (!onSlice) sink = mp4 ? await mp4Sink(tracks, name, size) : await mp3Sink(tracks, name);
    check();

    // ---- 3. the sound (not for a silent MP4)
    let fast: Pcm | null = null;
    let cap: Capture | null = null;
    onChanged = () => stop(new Error('The video changed during the export'));
    if (!silent) {
      // 3a. the audio the player already downloaded
      if (d.tap) {
        at('fetching');
        v.addEventListener('emptied', onChanged, { once: true });
        v.playbackRate = 1;
        try {
          fast = await fastAudio({ video: v, tap: d.tap, signal: ac.signal, progress: (f) => ((fetched = f), report()), problem: d.problem });
        } finally {
          v.removeEventListener('emptied', onChanged);
        }
        check();
        // The video gets its place back now; a failed read falls through to the recording below.
        if (fast) restore();
      }
      // 3b. otherwise record from the start, muted, at normal speed
      if (!fast) {
        v.pause();
        v.muted = true;
        v.playbackRate = 1;
        await seekToStart(v);
        check();
        cap = capture = openCapture(v);
        v.addEventListener('emptied', onChanged, { once: true });
        await v.play();
      }
    }
    const out = sink;
    at('recording');

    const fail = (e: unknown) => stop(e instanceof Error ? e : new Error(String(e)));
    const queue: Job[] = [];
    let pausedByUs = false;
    // The video waits when the model / encoder is behind, and goes on when they have caught up.
    const holdOrResume = (): void => {
      if (fast) return room.notify(); // nothing plays: the feed waits for the model by itself
      if (!pausedByUs && !recordingDone && queue.length >= MAX_QUEUE) {
        pausedByUs = true;
        v.pause();
      } else if (pausedByUs && !recordingDone && queue.length <= 1) {
        pausedByUs = false;
        void v.play().catch(() => {});
      }
    };
    let recordingDone = silent;
    const room = new Wake();
    const newAudio = new Wake();
    const newJob = new Wake();
    let produced = 0; // samples handed to the queue
    let acc = new Float32Array(plan.samples);
    let accR = new Float32Array(plan.samples);
    let accN = 0;

    const enqueue = (last: boolean): void => {
      // The last chunk is padded with silence to the exact length of the video.
      const n = last ? plan.total - produced : accN;
      if (n <= 0 && !last) return;
      queue.push({ l: acc.slice(0, n), r: accR.slice(0, n), start: produced, last });
      newJob.notify();
      produced += n;
      accN = 0;
      acc = new Float32Array(plan.samples);
      accR = new Float32Array(plan.samples);
    };
    const append = (l: Float32Array, r: Float32Array): void => {
      for (let at = 0; at < l.length && recorded < plan.total; ) {
        const n = Math.min(l.length - at, plan.samples - accN, plan.total - recorded);
        acc.set(l.subarray(at, at + n), accN);
        accR.set(r.subarray(at, at + n), accN);
        accN += n;
        at += n;
        recorded += n;
        if (accN === plan.samples && recorded < plan.total) enqueue(false);
      }
    };

    // fast: the sound is all there; it is cut in chunks as fast as the model takes them
    const feedLoop = async (pcm: Pcm): Promise<void> => {
      const step = rate;
      for (let from = 0; from < Math.min(pcm.l.length, plan.total); from += step) {
        check();
        while (queue.length >= MAX_QUEUE) {
          await room.wait();
          check();
        }
        append(pcm.l.subarray(from, from + step), pcm.r.subarray(from, from + step));
        newAudio.notify();
      }
      enqueue(true);
      recordingDone = true;
      newAudio.notify();
      newJob.notify();
      stage = 'finishing';
      report(true);
    };

    // recording: read, resample, cut in chunks
    const audioLoop = async (): Promise<void> => {
      if (!cap) return;
      const audio = new Puller(cap.audio);
      let resampler: Resampler | null = null;
      let lastData = performance.now();
      for (;;) {
        check();
        const got = await audio.next(POLL_MS);
        if (got === 'timeout') {
          const problem = d.problem?.();
          if (problem) throw new Error(problem);
          if (v.ended) break;
          if (v.paused && !pausedByUs) void v.play().catch(() => {});
          if (v.paused) lastData = performance.now(); // paused by the backlog or the user: not a stall
          else if (performance.now() - lastData > STALL_MS) throw new Error('The video stopped playing');
          continue;
        }
        if (got.done) break;
        lastData = performance.now();
        const data = got.value;
        const sr = data.sampleRate;
        const [l, r] = planar(data);
        data.close();
        if (!resampler || resampler.inRate !== sr) resampler = new Resampler(sr, rate);
        const [rl, rr] = resampler.process(l, r);
        append(rl, rr);
        newAudio.notify();
        if (recorded >= plan.total - END_MARGIN_S * rate) {
          v.pause(); // before `ended`: the next video of the queue must not start
          break;
        }
        holdOrResume();
      }
      v.pause();
      check(); // a cancel ended the reads: not a finished recording
      enqueue(true);
      recordingDone = true;
      v.removeEventListener('emptied', onChanged); // the recording is complete: what the player does next does not matter
      newAudio.notify();
      newJob.notify();
      stage = 'finishing';
      report(true);
      cap.stop();
      // A video left at its end while the last chunks are processed would make the player start the next one (autoplay): it gets
      // its place back now, not after the encoders are done.
      restore();
    };

    // picture, at a constant rate: the karaoke text of each frame's moment on a black background, as fast as the encoder takes frames
    const renderLoop = async (): Promise<void> => {
      if (!out?.canvas || !out.addFrame) return;
      const ctx = out.canvas.getContext('2d')!;
      const { width: W, height: H } = out.canvas;
      const dt = 1 / VIDEO_FPS;
      for (let k = 0; k * dt < dur; k++) {
        check();
        const t = k * dt;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        if (d.lyrics) drawKaraoke(ctx, W, H, karaokeRows(d.lyrics.lines, t - d.lyrics.offsetMs / 1000, o.text.karaokeLines), o.text);
        await out.addFrame(t, dt);
        rendered = t + dt;
        if (k % 15 === 0) {
          report();
          await breathe(); // the page (and the tab's other work) gets its turn
        }
      }
    };

    // chunks: separate, mix, encode, in order
    const write = async (s: StemSlice): Promise<void> => {
      if (onSlice) return void (await onSlice(s));
      if (!out) return;
      const mixed = mixSlice(o, s);
      for (const id of tracks) await out.addAudio(id, mixed[id]![0], mixed[id]![1], s.start);
    };
    const chunkLoop = async (): Promise<void> => {
      for (;;) {
        check();
        const job = queue.shift();
        if (!job) {
          if (recordingDone) return;
          await newJob.wait();
          continue;
        }
        if (session) {
          const s = await session.separator.push(job.l, job.r);
          if (s) await write(s);
          if (job.last) {
            const tail = await session.separator.finish();
            if (tail) await write(tail);
          }
        } else {
          await write({ start: job.start, length: job.l.length, dry: [job.l, job.r] });
        }
        processed++;
        holdOrResume();
        report();
      }
    };

    const run = (f: () => Promise<void>) => f().catch(fail);
    await Promise.all([run(() => (silent ? Promise.resolve() : fast ? feedLoop(fast) : audioLoop())), run(renderLoop), run(chunkLoop)]);
    check();

    // ---- 4. assemble
    at('finishing');
    const file = sink ? await sink.finish() : null;
    sink = null;
    return file;
  } catch (e) {
    throw stopped ?? e;
  } finally {
    clearInterval(ticker);
    v.removeEventListener('emptied', onChanged);
    d.signal.removeEventListener('abort', onCancel);
    capture?.stop();
    session?.dispose();
    await sink?.cancel();
    restore();
  }
}
