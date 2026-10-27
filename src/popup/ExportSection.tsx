import { useEffect, useRef, useState } from 'react';
import { AudioLines, Download, Drum, FileAudio, Guitar, Mic, Music, Piano, Square, TriangleAlert, Video, Volume2, Waves } from 'lucide-react';
import { motion } from 'motion/react';
import { drawKaraoke } from '../export/karaoke-render';
import { EXPORT_HEIGHTS, LONG_EXPORT_S, clock, defaultExportOptions, partsOf, stemsOf, TRACK_LABEL, type ExportFormat, type ExportOptions, type ExportProgress, type ExportText } from '../shared/export';
import { DEFAULT_LYRICS_PREFS, KARAOKE_BACKGROUNDS, KARAOKE_FONTS, KARAOKE_OUTLINES, loadLyricsPrefs, type LyricsPrefs } from '../shared/lyrics-prefs';
import { clampOthersPct, clampPct, masterPctAt, masterPosOf, MASTER_POS_MAX, MASTER_STEPS, type MixerSettings } from '../shared/settings';
import { KARAOKE_SIZES, POSITION_PRESETS } from '../content/lyrics/karaoke-presets';
import type { KaraokeSlot } from '../lyrics/karaoke-lines';
import { hasShaderF16 } from '../shared/gpu';
import { useModels } from './models';
import { MODEL_CHOICES, ModelRow } from './model-row';
import { Btn, Collapse, Disclosure, Select, SliderRow, Slider, Switch, type Choice } from './ui';

const EXPORT_KEY = 'exportOpen';
const readOpen = (): boolean => {
  try {
    return localStorage.getItem(EXPORT_KEY) === '1';
  } catch {
    return false;
  }
};

export interface ExportApi {
  /** The settings of the tab right now: where the export options start. */
  settings: MixerSettings;
  ready: boolean;
  /** Frame that plays the video and what it reports (absent: no content script, reload the tab). */
  status: { site: 'youtube' | 'ytmusic' | 'generic'; videoFound: boolean; duration?: number; lyricsSynced?: boolean; progress?: ExportProgress } | undefined;
  /** Starts the export; resolves to the reason when it could not start. */
  start(options: ExportOptions): Promise<string | undefined>;
  cancel(): void;
}

const bytes = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

const FONT_CHOICES: readonly Choice<(typeof KARAOKE_FONTS)[number]>[] = [
  { value: 'default', label: 'YouTube' },
  { value: 'sans', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Mono' },
];
const OUTLINE_CHOICES: readonly Choice<(typeof KARAOKE_OUTLINES)[number]>[] = [
  { value: 'none', label: 'None' },
  { value: 'thin', label: 'Thin' },
  { value: 'normal', label: 'Normal' },
  { value: 'thick', label: 'Thick' },
];
const BG_CHOICES: readonly Choice<`${(typeof KARAOKE_BACKGROUNDS)[number]}`>[] = KARAOKE_BACKGROUNDS.map((b) => ({ value: `${b}` as const, label: b ? `${b}% dark box` : 'No box' }));
const SIZE_CHOICES: readonly Choice<`${number}`>[] = KARAOKE_SIZES.map((n) => ({ value: `${n}` as const, label: `${n}%` }));
const LINES_CHOICES: readonly Choice<'1' | '2'>[] = [{ value: '1', label: '1 line' }, { value: '2', label: '2 lines' }];
const HEIGHT_CHOICES: readonly Choice<`${number}`>[] = EXPORT_HEIGHTS.map((h) => ({ value: `${h}` as const, label: `${h}p` }));
const nearest = (list: readonly number[], v: number): number => list.reduce((best, n) => (Math.abs(n - v) < Math.abs(best - v) ? n : best));

/** The place of the text as a choice: Top, Middle, Bottom, or what the video's own setting is when it is none of them. */
function placeChoices(pos: ExportText['karaokePosition']): { choices: Choice<string>[]; value: string } {
  const hit = POSITION_PRESETS.find((p) => Math.abs(pos.x - 0.5) < 0.01 && Math.abs(pos.y - p.y) < 0.01);
  const choices: Choice<string>[] = POSITION_PRESETS.map((p) => ({ value: p.id, label: p.label }));
  if (!hit) choices.push({ value: 'custom', label: 'As on the video', hint: 'You dragged the text' });
  return { choices, value: hit?.id ?? 'custom' };
}

const SAMPLE_ROWS: KaraokeSlot[] = [
  { index: 0, row: 0, text: 'This is how the lyrics will look', state: 'current' },
  { index: 1, row: 1, text: 'and the next line comes below', state: 'upcoming' },
];

/** The karaoke text on a 16:9 frame, drawn by the export's own renderer, so what the preview shows is what the video gets. */
function Preview({ text }: { text: ExportText }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const g = ctx.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, '#3b4a6b');
    g.addColorStop(1, '#1c1f2e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    drawKaraoke(ctx, c.width, c.height, SAMPLE_ROWS.slice(0, text.karaokeLines), text);
  }, [text]);
  // 1280 × 720 like a 720p export: the same sizes, scaled down by the page.
  return <canvas id="export-preview" ref={ref} width={1280} height={720} aria-label="Preview of the karaoke text" className="aspect-video w-full rounded-xl shadow-pressed" />;
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-bold">{label}</label>
      {children}
    </div>
  );
}

export function ExportSection({ api }: { api: ExportApi }) {
  const { settings, status } = api;
  const progress = status?.progress;
  const running = progress?.state === 'running';
  const [open, setOpen] = useState(readOpen);
  const [audioOpen, setAudioOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [prefs, setPrefs] = useState<LyricsPrefs>(DEFAULT_LYRICS_PREFS);
  const [options, setOptions] = useState<ExportOptions>(() => defaultExportOptions(settings, DEFAULT_LYRICS_PREFS));
  // Until the user changes an export control, the options follow the live settings; after that they are the user's own.
  const touched = useRef(false);
  const [startError, setStartError] = useState<string>();

  useEffect(() => {
    void loadLyricsPrefs(chrome.storage.local).then(setPrefs, () => {});
  }, []);
  useEffect(() => {
    if (!touched.current) setOptions((o) => ({ ...defaultExportOptions(settings, prefs, o.format), tracks: o.tracks, height: o.height }));
  }, [settings, prefs]);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  const change = (patch: Partial<ExportOptions>) => {
    touched.current = true;
    setOptions((o) => ({ ...o, ...patch }));
  };
  const audio = (patch: Partial<MixerSettings>) => {
    touched.current = true;
    setOptions((o) => ({ ...o, audio: { ...o.audio, ...patch } }));
  };
  const text = (patch: Partial<ExportText>) => {
    touched.current = true;
    setOptions((o) => ({ ...o, text: { ...o.text, ...patch } }));
  };
  const match = () => {
    touched.current = false;
    setOptions((o) => ({ ...defaultExportOptions(settings, prefs, o.format), tracks: o.tracks, height: o.height }));
  };

  const a = options.audio;
  const all = a.mlModel === 'sw';
  const parts = partsOf(a);
  // A GPU without shader-f16 runs only the fp32 Default model (its own download): the model row says so, as in Advanced.
  const [noF16, setNoF16] = useState(false);
  useEffect(() => {
    void hasShaderF16(a.gpu).then((ok) => setNoF16(!ok));
  }, [a.gpu]);
  const models = useModels(a.mlModel, { drums: a.splitInstrumental && !all, guitar: a.splitGuitar && !all }, api.ready && open, noF16);
  const mp4 = options.format === 'mp4';
  const separate = options.tracks === 'separate';
  const duration = status?.duration;
  const longVideo = duration !== undefined && Number.isFinite(duration) && duration > LONG_EXPORT_S;
  const noVideo = !status || !status.videoFound;
  const place = placeChoices(options.text.karaokePosition);
  const stems = stemsOf(a).map((s) => TRACK_LABEL[s].toLowerCase()).join(', ');

  const trackNote = {
    mp3: separate
      ? `A .zip with one MP3 per track: the mix, ${stems}. An MP3 file holds one track only, so the stems come as separate files; put them at 0:00 in your editor.`
      : 'One MP3 file with the mix.',
    mp4: separate
      ? `One MP4 with several audio streams: the mix first (what a player plays), then ${stems}. VLC, mpv and DaVinci Resolve show every stream; many editors and players read only the first one.`
      : 'One MP4 file with the mixed sound.',
  }[options.format];

  const start = async () => {
    setStartError(undefined);
    setStartError(await api.start(options));
  };

  const formatBtn = (f: ExportFormat, label: string, icon: React.ReactNode) => (
    <Btn id={`export-format-${f}`} tone="preset" aria-pressed={options.format === f} disabled={running} onClick={() => change({ format: f })}>
      {icon}
      {label}
    </Btn>
  );
  const tracksBtn = (t: ExportOptions['tracks'], label: string) => (
    <Btn id={`export-tracks-${t}`} tone="preset" aria-pressed={options.tracks === t} disabled={running} onClick={() => change({ tracks: t })}>
      {label}
    </Btn>
  );

  const masterPos = masterPosOf(a.masterPct);
  const lyricsNote =
    status?.site === 'generic' ? 'Lyrics show on YouTube only: this MP4 will have no text.' : status && !status.lyricsSynced ? 'No synced lyrics are on screen for this video: the MP4 will have no text.' : undefined;

  return (
    <Disclosure id="export" open={open} onOpen={(o) => {
      setOpen(o);
      try {
        localStorage.setItem(EXPORT_KEY, o ? '1' : '0');
      } catch {
        /* storage blocked */
      }
    }} className="rounded-[20px] bg-card" buttonClassName="p-4"
      title={<span className="flex items-center gap-1.5"><Download size={15} className="text-brand" aria-hidden />Export <span className="font-medium text-muted">(MP3, MP4)</span></span>}>
      <div className="flex flex-col gap-3.5 px-4 pb-4">
        <div className="grid grid-cols-2 gap-2.5" role="group" aria-label="Format">
          {formatBtn('mp3', 'MP3 audio', <FileAudio size={15} aria-hidden />)}
          {formatBtn('mp4', 'MP4 + text', <Video size={15} aria-hidden />)}
        </div>

        <Disclosure id="export-audio" open={audioOpen} onOpen={setAudioOpen} className="rounded-2xl bg-surface/70" buttonClassName="p-3"
          title={<span className="flex items-center gap-1.5"><AudioLines size={15} className="text-brand" aria-hidden />Audio options <span className="font-medium text-muted">(this export only)</span></span>}>
          <div className="flex flex-col gap-3 px-3 pb-3">
            <div className="flex items-center justify-between gap-3">
              <p className="m-0 text-xs leading-snug text-muted">Starts from your current settings. Changing it here does not change what you hear.</p>
              <Btn id="export-match" tone="small" className="shrink-0 whitespace-nowrap" onClick={match}>Match live</Btn>
            </div>
            <Field id="export-model" label="Model">
              <Select id="export-model" value={a.mlModel} options={MODEL_CHOICES} onValue={(mlModel) => audio({ mlModel })} />
            </Field>
            <Collapse show={!!models.model}>{models.model && <ModelRow idPrefix="export-model" line={models.model} />}</Collapse>
            <Collapse show={!all}>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="export-split-drums" className="flex items-center gap-1.5 text-[13px] font-bold"><Drum size={14} className="text-brand" aria-hidden />Split drums</label>
                  <Switch id="export-split-drums" checked={a.splitInstrumental} onChange={(splitInstrumental) => audio({ splitInstrumental })} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="export-split-guitar" className="flex items-center gap-1.5 text-[13px] font-bold"><Guitar size={14} className="text-brand" aria-hidden />Split guitar</label>
                  <Switch id="export-split-guitar" checked={a.splitGuitar} onChange={(splitGuitar) => audio({ splitGuitar })} />
                </div>
                <Collapse show={!!models.drums}>{models.drums && <ModelRow idPrefix="export-drums" line={models.drums} />}</Collapse>
                <Collapse show={!!models.guitar}>{models.guitar && <ModelRow idPrefix="export-guitar" line={models.guitar} />}</Collapse>
              </div>
            </Collapse>
            <div className="mx-row flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-2">
                <label htmlFor="export-master" className="flex items-center gap-1.5 text-[13px] font-bold"><Volume2 size={15} className="text-brand" aria-hidden />Global volume</label>
                <output id="export-master-value" htmlFor="export-master" className="text-[15px] font-extrabold tabular-nums">{a.masterPct}%</output>
              </div>
              <Slider id="export-master" value={masterPos} min={0} max={MASTER_POS_MAX} step={1} onValue={(p) => audio({ masterPct: masterPctAt(p, a.masterPct) })} />
              <div className="flex justify-between text-xs text-muted"><span>{MASTER_STEPS[0]}%</span><span>Boost up to 600%</span></div>
            </div>
            <SliderRow id="export-vocal" icon={<Mic size={15} />} label="Vocal" unit="%" value={a.vocalPct} min={0} max={100} step={5} onValue={(v) => audio({ vocalPct: clampPct(v) })} />
            <SliderRow id="export-instrumental" icon={<Music size={15} />} label="Instrumental" unit="%" value={a.instrumentalPct} min={0} max={100} step={5} onValue={(v) => audio({ instrumentalPct: clampPct(v) })} />
            {parts.includes('drums') && <SliderRow id="export-drums" icon={<Drum size={15} />} label="Drums" hint="in the instrumental" unit="%" value={a.drumsPct} min={0} max={100} step={5} onValue={(v) => audio({ drumsPct: clampPct(v) })} />}
            {parts.includes('guitar') && <SliderRow id="export-guitar" icon={<Guitar size={15} />} label="Guitar" hint="in the instrumental" unit="%" value={a.guitarPct} min={0} max={100} step={5} onValue={(v) => audio({ guitarPct: clampPct(v) })} />}
            {parts.includes('bass') && <SliderRow id="export-bass" icon={<Waves size={15} />} label="Bass" hint="in the instrumental" unit="%" value={a.bassPct} min={0} max={100} step={5} onValue={(v) => audio({ bassPct: clampPct(v) })} />}
            {parts.includes('piano') && <SliderRow id="export-piano" icon={<Piano size={15} />} label="Piano" hint="in the instrumental" unit="%" value={a.pianoPct} min={0} max={100} step={5} onValue={(v) => audio({ pianoPct: clampPct(v) })} />}
            {parts.length > 0 && <SliderRow id="export-others" icon={<AudioLines size={15} />} label="Others" hint="in the instrumental" unit="%" value={a.othersPct} min={0} max={100} step={5} onValue={(v) => audio({ othersPct: clampOthersPct(v) })} />}
          </div>
        </Disclosure>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-bold">Output</span>
          <div className="grid grid-cols-2 gap-2.5" role="group" aria-label="Output">
            {tracksBtn('single', 'Single track')}
            {tracksBtn('separate', 'Separate tracks')}
          </div>
          <p id="export-track-note" className="m-0 text-xs leading-snug text-muted">{trackNote}{separate && ' The mix has your levels; the other tracks are the raw stems, for mixing in an editor.'}</p>
        </div>

        <Collapse show={mp4}>
          <Disclosure id="export-text" open={textOpen} onOpen={setTextOpen} className="rounded-2xl bg-surface/70" buttonClassName="p-3"
            title={<span className="flex items-center gap-1.5"><Music size={15} className="text-brand" aria-hidden />Karaoke text</span>}>
            <div className="flex flex-col gap-3 px-3 pb-3">
              <Preview text={options.text} />
              <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">
                <Field id="export-color" label="Colour">
                  <input id="export-color" type="color" value={options.text.karaokeColor} onChange={(e) => text({ karaokeColor: e.currentTarget.value })} className="h-[42px] w-full cursor-pointer rounded-xl border-0 bg-well p-1 shadow-pressed" />
                </Field>
                <Field id="export-size" label="Size"><Select id="export-size" value={`${nearest(KARAOKE_SIZES, options.text.karaokeFontSize)}`} options={SIZE_CHOICES} onValue={(v) => text({ karaokeFontSize: Number(v) })} /></Field>
                <Field id="export-font" label="Font"><Select id="export-font" value={options.text.karaokeFont} options={FONT_CHOICES} onValue={(karaokeFont) => text({ karaokeFont })} /></Field>
                <Field id="export-outline" label="Outline"><Select id="export-outline" value={options.text.karaokeOutline} options={OUTLINE_CHOICES} onValue={(karaokeOutline) => text({ karaokeOutline })} /></Field>
                <Field id="export-background" label="Background"><Select id="export-background" value={`${options.text.karaokeBackground}` as `${(typeof KARAOKE_BACKGROUNDS)[number]}`} options={BG_CHOICES} onValue={(v) => text({ karaokeBackground: Number(v) as (typeof KARAOKE_BACKGROUNDS)[number] })} /></Field>
                <Field id="export-lines" label="Lines"><Select id="export-lines" value={`${options.text.karaokeLines}` as '1' | '2'} options={LINES_CHOICES} onValue={(v) => text({ karaokeLines: Number(v) as 1 | 2 })} /></Field>
                <Field id="export-position" label="Position">
                  <Select id="export-position" value={place.value} options={place.choices} onValue={(id) => { const p = POSITION_PRESETS.find((x) => x.id === id); if (p) text({ karaokePosition: { x: 0.5, y: p.y } }); }} />
                </Field>
                <Field id="export-height" label="Picture size"><Select id="export-height" value={`${options.height}`} options={HEIGHT_CHOICES} onValue={(v) => change({ height: Number(v) })} /></Field>
              </div>
              {lyricsNote && <p id="export-lyrics-note" className="m-0 text-xs leading-snug text-muted">{lyricsNote}</p>}
            </div>
          </Disclosure>
        </Collapse>

        {!running && (
          <>
            <p id="export-time-note" className="m-0 text-xs leading-snug text-muted">
              The video is recorded while it plays (muted, from the start){duration && Number.isFinite(duration) ? `, so this takes about ${clock(duration)}` : ''}. {mp4 ? 'Keep this tab open and in front: the picture needs it.' : 'Keep this tab open; it is fastest in front.'} Your place in the video comes back afterwards.
            </p>
            {longVideo && <p id="export-long-note" className="m-0 text-xs leading-snug text-muted">This video is long: the file is built in memory, so a long export may fail.</p>}
            <Btn id="export-start" tone="primary" disabled={noVideo} onClick={() => void start()}>
              <Download size={16} aria-hidden />
              Export {mp4 ? 'MP4' : 'MP3'}
            </Btn>
          </>
        )}
        {startError && <p id="export-error" role="alert" className="m-0 flex items-start gap-1.5 text-xs leading-snug text-brand-dark"><TriangleAlert size={14} className="mt-px shrink-0" aria-hidden />{startError}</p>}

        {progress && <ProgressBlock progress={progress} cancel={api.cancel} />}
      </div>
    </Disclosure>
  );
}

function ProgressBlock({ progress: p, cancel }: { progress: ExportProgress; cancel: () => void }) {
  const running = p.state === 'running';
  const done = p.state === 'done';
  return (
    <div id="export-progress-block" data-state={p.state} className="flex flex-col gap-2">
      {running && (
        <div id="export-progress" role="progressbar" aria-label="Export" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(p.percent)} className="h-2 overflow-hidden rounded-full bg-well shadow-pressed">
          {p.stage === 'model' || p.stage === 'preparing' ? (
            <motion.span animate={{ x: ['-100%', '300%'] }} transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }} className="block h-full w-1/3 rounded-full bg-brand" />
          ) : (
            <motion.div initial={false} animate={{ width: `${p.percent}%` }} transition={{ duration: 0.4, ease: 'easeOut' }} className="h-full rounded-full bg-linear-to-r from-[#f2505a] to-[#d3101c]" />
          )}
        </div>
      )}
      <p id="export-detail" role="status" className="m-0 flex items-start justify-between gap-3 text-xs leading-snug text-muted">
        <span>{running && p.stage === 'recording' ? `${Math.floor(p.percent)}% · ` : ''}{p.detail}{done && p.file ? ` (${bytes(p.file.bytes)})` : ''}</span>
      </p>
      {p.state === 'error' && p.error && <p id="export-failure" role="alert" className="m-0 flex items-start gap-1.5 text-xs leading-snug text-brand-dark"><TriangleAlert size={14} className="mt-px shrink-0" aria-hidden />{p.error}</p>}
      {running && (
        <Btn id="export-cancel" onClick={cancel}>
          <Square size={14} aria-hidden />
          Cancel
        </Btn>
      )}
    </div>
  );
}

