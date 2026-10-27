// The export engine records the playing video in real time, cuts the recording in chunks of at most
// MAX_CHUNK_S, separates / mixes / encodes each chunk, and assembles the file. Loaded on demand by src/content/export-run.ts
// as a module of its own (it carries the encoders), never as part of the content script.
import type { LyricLine } from '../lyrics/types';
import {
  EXPORT_SAMPLE_RATE,
  clock,
  needsSeparation,
  safeFileName,
  tracksOf,
  type ExportOptions,
  type ExportProgress,
  type ExportStage,
} from '../shared/export';
import { openCapture, planar, watchPicture, FrameStore, type Capture } from './capture';
import { VIDEO_FPS, mp3Sink, mp4Sink, pictureSize, type ExportFile, type Sink } from './encode';
import { drawKaraoke, karaokeRows } from './karaoke-render';
import { mixSlice, type StemSlice } from './mix';
import { openMlSession, type MlSession, type OpenMlSession } from './ml-session';
import { chunkAt, planChunks } from './plan';
import { Resampler } from './resample';

export type { ExportFile } from './encode';

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
/** The picture of a moment is drawn this long after it was heard, so its frame has arrived. */
const PICTURE_LAG_S = 0.15;
/** Without a sample from the player for this long while it should play, the export fails. */
const STALL_MS = 20_000;
/** The video waits while the picture is this far behind the sound (the frame store holds about a second of frames). */
const MAX_RENDER_LAG_S = 0.6;
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

export async function runExport(d: ExportDeps): Promise<ExportFile> {
  const { video: v, options: o } = d;
  const dur = v.duration;
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('This video has no fixed length (a live stream cannot be exported)');
  const plan = planChunks(dur);
  const tracks = tracksOf(o);
  const name = safeFileName(d.title);
  const mp4 = o.format === 'mp4';
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
  let processed = 0; // chunks
  let lastReport = 0;
  const report = (force = false): void => {
    const now = performance.now();
    if (!force && now - lastReport < 250) return;
    lastReport = now;
    const t = Math.min(dur, recorded / rate);
    const percent = stage === 'recording' ? Math.min(98, (100 * recorded) / plan.total) : stage === 'finishing' ? 99 : 0;
    const chunk = chunkAt(plan, Math.min(recorded, plan.total - 1));
    const detail =
      stage === 'model'
        ? note
        : stage === 'recording'
          ? mp4 && document.hidden
            ? 'Paused: bring this tab to the front to go on (the picture needs a visible tab)'
            : `Chunk ${chunk}/${plan.count} · ${clock(t)} / ${clock(dur)} · ${processed} of ${plan.count} processed`
          : stage === 'finishing'
            ? processed < plan.count
              ? `Processing the last chunks (${processed} of ${plan.count} done)…`
              : 'Writing the file…'
            : 'Getting ready…';
    d.report({ state: 'running', stage, chunk: stage === 'recording' ? chunk : 0, chunks: plan.count, percent, detail });
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
  let session: MlSession | null = null;
  let sink: Sink | null = null;
  let capture: Capture | null = null;
  let frames: FrameStore | null = null;
  let stopPicture: (() => void) | null = null;
  let onVisible: (() => void) | null = null;
  let onChanged: () => void = () => {};
  const ticker = setInterval(() => report(), 500);
  try {
    // ---- 1. the model, only when the stems matter
    at('preparing');
    if (needsSeparation(o)) {
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
    const size = pictureSize(v.videoWidth, v.videoHeight, o.height);
    sink = mp4 ? await mp4Sink(tracks, name, size) : await mp3Sink(tracks, name);
    check();

    // ---- 3. record from the start, muted, at normal speed
    v.pause();
    v.muted = true;
    v.playbackRate = 1;
    await seekToStart(v);
    check();
    capture = openCapture(v);
    frames = mp4 ? new FrameStore() : null;
    stopPicture = frames ? watchPicture(v, frames, size.w, size.h) : null;
    const cap = capture;
    const out = sink;
    const store = frames;
    onChanged = () => stop(new Error('The video changed during the export'));
    v.addEventListener('emptied', onChanged, { once: true });
    await v.play();
    at('recording');

    const fail = (e: unknown) => stop(e instanceof Error ? e : new Error(String(e)));
    const queue: Job[] = [];
    let pausedByUs = false;
    let rendered = 0; // seconds of picture written
    const renderLag = (): number => (mp4 ? recorded / rate - rendered : 0);
    // The video waits when the model / encoder is behind, and goes on when they have caught up.
    // The picture of a hidden tab is not produced (requestVideoFrameCallback stops): the MP4 waits for the tab.
    const hiddenForPicture = (): boolean => mp4 && document.hidden;
    const holdOrResume = (): void => {
      if (!pausedByUs && !recordingDone && (queue.length >= MAX_QUEUE || renderLag() > MAX_RENDER_LAG_S || hiddenForPicture())) {
        pausedByUs = true;
        v.pause();
      } else if (pausedByUs && queue.length <= 1 && renderLag() < MAX_RENDER_LAG_S / 3 && !hiddenForPicture()) {
        pausedByUs = false;
        void v.play().catch(() => {});
      }
    };
    let recordingDone = false;
    const newAudio = new Wake();
    const newJob = new Wake();
    onVisible = () => holdOrResume();
    document.addEventListener('visibilitychange', onVisible);
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

    // audio: read, resample, cut in chunks
    const audioLoop = async (): Promise<void> => {
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
      stopPicture?.(); // the frames in the store are enough for the rest
    };

    // picture, at a constant rate: frame `k` is the newest source frame at k / fps, plus the karaoke text of that moment
    const renderLoop = async (): Promise<void> => {
      if (!out.canvas || !out.addFrame || !store) return;
      const ctx = out.canvas.getContext('2d')!;
      const { width: W, height: H } = out.canvas;
      const dt = 1 / VIDEO_FPS;
      for (let k = 0; ; ) {
        check();
        const t = k * dt;
        const heard = recordingDone ? Infinity : recorded / rate - PICTURE_LAG_S;
        if (t >= dur) return;
        if (t >= heard) {
          await newAudio.wait();
          continue;
        }
        const frame = store.at(t);
        if (frame) ctx.drawImage(frame, 0, 0, W, H);
        else {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W, H);
        }
        if (d.lyrics) drawKaraoke(ctx, W, H, karaokeRows(d.lyrics.lines, t - d.lyrics.offsetMs / 1000, o.text.karaokeLines), o.text);
        await out.addFrame(t, dt);
        rendered = t + dt;
        holdOrResume();
        k++;
      }
    };

    // chunks: separate, mix, encode, in order
    const write = async (s: StemSlice): Promise<void> => {
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
    await Promise.all([run(audioLoop), run(renderLoop), run(chunkLoop)]);
    check();

    // ---- 4. assemble
    at('finishing');
    const file = await sink.finish();
    sink = null;
    return file;
  } catch (e) {
    throw stopped ?? e;
  } finally {
    clearInterval(ticker);
    v.removeEventListener('emptied', onChanged);
    if (onVisible) document.removeEventListener('visibilitychange', onVisible);
    d.signal.removeEventListener('abort', onCancel);
    capture?.stop();
    stopPicture?.();
    frames?.close();
    session?.dispose();
    await sink?.cancel();
    // Back to what the user had, unless the player moved on to another video.
    if (v.currentSrc === saved.src) {
      v.pause();
      v.muted = saved.muted;
      v.playbackRate = saved.rate;
      v.currentTime = saved.time;
      if (!saved.paused) void v.play().catch(() => {});
    }
  }
}
