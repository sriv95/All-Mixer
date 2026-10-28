import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AudioLines, AudioWaveform, Cpu, Drum, Guitar, HardDriveDownload, LoaderCircle, Maximize2, Mic, Minimize2, MicOff, Music, Piano, RefreshCw, RotateCcw, Settings2, Timer, TriangleAlert, Undo2, Volume2, Waves, Zap } from 'lucide-react';
import type { ContentStatus, ExportAnswer, ExportCancel, ExportStart, GetStatus, GetTabSettings, PreloadCancel, PreloadStart, SetTabSettings } from '../shared/messages';
import type { ExportOptions } from '../shared/export';
import { clampDelayS, clampOthersPct, clampPct, clampPitch, masterPctAt, masterPosOf, MASTER_POS_MAX, normalizeSettings, PITCH_MAX, type MixerSettings, type Mode } from '../shared/settings';
import { separationView, type SepView } from '../shared/separation-view';
import { MAX_DELAY_S, MIN_DELAY_S } from '../ml/rof-plan';
import type { MlModel } from '../worklet/protocol';
import { gpuOptions, gpuSelected, hasShaderF16, probeGpuNames, type GpuNames } from '../shared/gpu';
import { useModels } from './models';
import { MODEL_CHOICES, ModelRow } from './model-row';
import { ExportSection, type ExportApi } from './ExportSection';
import { PreloadBanner, ProcessingRow, type PreloadApi } from './PreloadUi';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Blocked, Btn, Card, Collapse, Disclosure, PitchStepper, Rise, Roll, Select, Skeleton, Slider, SliderRow, Switch, Tip, fade, slide, useGlide } from './ui';

type Update = (patch: Partial<MixerSettings>) => void;

const LOADING_POLL_MS = 500;
const LIVE_POLL_MS = 2000;
/** While an export runs the popup reads its progress this often. */
const EXPORT_POLL_MS = 500;
/** One click on "Raise delay limit" adds this many seconds. */
const DELAY_STEP_S = 4;
// The Advanced section stays open between popup openings, and opens by itself when a non-default model is in use.
const ADVANCED_KEY = 'advancedOpen';

// The compact view (no presets, no banner text) is remembered too.
const COMPACT_KEY = 'compact';

const REPO_URL = 'https://github.com/sriv95/All-Mixer';

// lucide-react has no brand icons: the GitHub mark (Octicons mark-github, 16 px).
function GithubMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function readCompact(): boolean {
  try {
    return localStorage.getItem(COMPACT_KEY) === '1';
  } catch {
    return false;
  }
}

function readAdvanced(): boolean {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1';
  } catch {
    return false; // storage blocked: stays closed
  }
}

function noteText(blocked: boolean, settings: MixerSettings, loaded: { s: ContentStatus | undefined } | null): string {
  if (blocked) return 'Open a web page to use All Mixer!.';
  if (!loaded) return '';
  const s = loaded.s;
  // No content script yet (extension just installed or updated): Separate mode cannot work until the tab is reloaded.
  if (!s) return 'Reload this tab to start All Mixer! and show Separate mode.';
  if (s.audio === 'error') return `Audio error: ${s.error ?? 'unknown'}`;
  if (!s.videoFound && settings.masterPct !== 100) return 'No video player on this page yet.';
  return s.audio === 'waiting-for-gesture' ? 'Click anywhere on the page once to enable the boost.' : '';
}

export function App() {
  const [blocked, setBlocked] = useState(false);
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<MixerSettings>(() => normalizeSettings({}));
  const [loaded, setLoaded] = useState<{ s: ContentStatus | undefined } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(readAdvanced);
  const [compact, setCompact] = useState(readCompact);
  const [splitOpen, setSplitOpen] = useState(false);
  const tabId = useRef<number | null>(null);
  const latest = useRef(settings);
  const pending = useRef(false);

  const refresh = useCallback(async () => {
    if (tabId.current === null) return;
    const req: GetStatus = { type: 'get-status' };
    const s: ContentStatus | undefined = await chrome.tabs.sendMessage(tabId.current, req).catch(() => undefined);
    setLoaded({ s });
  }, []);

  const update = useCallback<Update>(
    (patch) => {
      latest.current = { ...latest.current, ...patch };
      setSettings(latest.current);
      // Coalesce slider drags to one message per frame.
      if (pending.current || tabId.current === null) return;
      pending.current = true;
      requestAnimationFrame(() => {
        pending.current = false;
        const msg: SetTabSettings = { type: 'set-tab-settings', tabId: tabId.current!, settings: latest.current };
        void chrome.runtime.sendMessage(msg).then(refresh);
      });
    },
    [refresh],
  );

  useEffect(() => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      // The content script runs on web pages only (not chrome:// or the web store).
      if (tab?.id === undefined || !tab.url?.startsWith('http')) return setBlocked(true);
      tabId.current = tab.id;
      const req: GetTabSettings = { type: 'get-tab-settings', tabId: tab.id };
      latest.current = normalizeSettings(await chrome.runtime.sendMessage(req));
      setSettings(latest.current);
      const split = latest.current.splitInstrumental || latest.current.splitGuitar;
      if (latest.current.mlModel !== 'mdx' || split) setAdvancedOpen(true);
      if (split) setSplitOpen(true);
      setReady(true);
      await refresh();
    })();
  }, [refresh]);

  const view = separationView(settings.mode, loaded?.s);
  // While the separator starts or ML warms up, poll so the banner moves on by itself; while live, slowly, to catch a stop.
  const exporting = loaded?.s?.export?.state === 'running' || loaded?.s?.preload?.state === 'loading';
  // Preload mode: the state of the cache can change under the popup (an ad, another video).
  const preloadMode = settings.mode === 'separate' && settings.preload;
  const pollMs = exporting ? EXPORT_POLL_MS : view.kind === 'warming' ? LOADING_POLL_MS : view.kind === 'live' || preloadMode ? LIVE_POLL_MS : null;
  useEffect(() => {
    if (pollMs === null) return;
    const t = setTimeout(() => void refresh(), pollMs);
    return () => clearTimeout(t);
  }, [pollMs, loaded, refresh]);

  // Stopped, too slow: off and on again is the retry the content script understands.
  const retry = async () => {
    if (tabId.current === null) return;
    const off: SetTabSettings = { type: 'set-tab-settings', tabId: tabId.current, settings: { ...latest.current, mode: 'default' } };
    await chrome.runtime.sendMessage(off);
    update({ mode: 'separate' });
  };

  // Export: the options live in the section; the tab does the work and reports the progress through `get-status`.
  const exportApi: ExportApi = {
    settings,
    ready,
    status: loaded?.s && { site: loaded.s.site, videoFound: loaded.s.videoFound, duration: loaded.s.duration, lyricsSynced: loaded.s.lyricsSynced, progress: loaded.s.export },
    async start(options: ExportOptions) {
      if (tabId.current === null) return 'Open a video page first.';
      const req: ExportStart = { type: 'export-start', options };
      const answer: ExportAnswer | undefined = await chrome.tabs.sendMessage(tabId.current, req).catch(() => undefined);
      await refresh();
      return answer?.ok ? undefined : (answer?.error ?? 'Reload this tab, then try again.');
    },
    cancel() {
      if (tabId.current === null) return;
      const req: ExportCancel = { type: 'export-cancel' };
      void chrome.tabs.sendMessage(tabId.current, req).catch(() => undefined).then(refresh);
    },
  };

  // Preload Audio: the tab does the work (src/content/preload-run.ts) and reports it through `get-status`.
  const preloadApi: PreloadApi = {
    status: loaded?.s?.preload,
    async start() {
      if (tabId.current === null) return 'Open a video page first.';
      const req: PreloadStart = { type: 'preload-start' };
      const answer: ExportAnswer | undefined = await chrome.tabs.sendMessage(tabId.current, req).catch(() => undefined);
      await refresh();
      return answer?.ok ? undefined : (answer?.error ?? 'Reload this tab, then try again.');
    },
    cancel() {
      if (tabId.current === null) return;
      const req: PreloadCancel = { type: 'preload-cancel' };
      void chrome.tabs.sendMessage(tabId.current, req).catch(() => undefined).then(refresh);
    },
  };

  // Until the tab's settings are read the popup would show the defaults, then jump to the real ones.
  const loading = !blocked && !ready;
  const noContent = loaded !== null && !loaded.s;
  const separate = settings.mode === 'separate' && !noContent;
  const note = noteText(blocked, settings, loaded);

  return (
    <MotionConfig reducedMotion="user">
    <Blocked.Provider value={blocked}>
      <main className="flex flex-col gap-3.5">
        <header className="flex items-center justify-between gap-2.5">
          <span className="flex items-center gap-2.5 text-[17px] font-extrabold tracking-tight">
            <img src="/icons/icon-128.png" alt="" className="size-8 rounded-[10px]" />
            All Mixer!
          </span>
          {!noContent && (
            <Tip text={compact ? 'Show everything' : 'Compact view'} side="bottom" align="end">
              <Btn id="compact-toggle" tone="small" aria-label="Compact view" aria-pressed={compact} className="aria-pressed:text-brand-dark aria-pressed:shadow-pressed"
                onClick={() => {
                  const next = !compact;
                  setCompact(next);
                  try {
                    localStorage.setItem(COMPACT_KEY, next ? '1' : '0');
                  } catch {
                    /* storage blocked */
                  }
                }}>
                {compact ? <Maximize2 size={14} aria-hidden /> : <Minimize2 size={14} aria-hidden />}
              </Btn>
            </Tip>
          )}
        </header>
        {loading ? (
          <div aria-busy="true" className="flex flex-col gap-3.5">
            <Skeleton className="h-10 rounded-full" />
            <Skeleton className="h-[148px]" />
            <Skeleton className="h-[84px]" />
          </div>
        ) : (
          <>
        {!noContent && <Tabs mode={separate ? 'separate' : 'default'} onMode={(mode) => update({ mode })} />}
        <AnimatePresence mode="wait" custom={separate ? 1 : -1}>
        {separate ? (
          <motion.div key="separate" id="panel-separate" custom={1} variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.2 }} className="flex flex-col gap-3.5">
            <AnimatePresence mode="wait" initial={false}>
              {preloadMode ? <PreloadBanner key="preload-banner" api={preloadApi} settings={settings} update={update} compact={compact} /> : view.kind !== 'off' && <Banner key="banner" compact={compact} view={view} settings={settings} update={update} retry={retry} />}
            </AnimatePresence>
            <SeparateControls settings={settings} update={update} ready={ready} compact={compact} advancedOpen={advancedOpen} setAdvancedOpen={setAdvancedOpen} splitOpen={splitOpen} setSplitOpen={setSplitOpen} exportApi={exportApi} />
          </motion.div>
        ) : (
          <motion.div key="default" custom={-1} variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.2 }} className="flex flex-col gap-3.5">
            <Rise i={0}><Master settings={settings} update={update} /></Rise>
            {!noContent && (
              <Rise i={1}>
                <Card>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <label htmlFor="separate-mode" className="text-sm font-bold">Separate mode</label>
                      <p className="mt-0.5 text-xs leading-snug text-muted">Split vocals and music live and mix them yourself.</p>
                    </div>
                    <Switch id="separate-mode" checked={false} onChange={() => update({ mode: 'separate' })} />
                  </div>
                </Card>
              </Rise>
            )}
          </motion.div>
        )}
        </AnimatePresence>
          </>
        )}
        <p id="status" role="status" className="m-0 text-[13px] leading-snug text-muted empty:hidden">{note}</p>
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-1.5 text-xs text-muted underline">
          <GithubMark />sriv95/All-Mixer
        </a>
      </main>
    </Blocked.Provider>
    </MotionConfig>
  );
}

function Tabs({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  const blocked = useContext(Blocked);
  const tab = (m: Mode, label: string, icon: ReactNode, tip: string) => (
    <Tip text={tip} side="bottom" align={m === 'default' ? 'start' : 'end'} className="flex-1">
    <button id={`tab-${m}`} type="button" role="tab" aria-selected={mode === m} disabled={blocked} onClick={() => onMode(m)}
      className="relative flex flex-1 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent py-2 text-[13px] font-bold text-muted transition-colors duration-200 aria-selected:text-white disabled:opacity-45">
      {mode === m && <motion.span layoutId="tab-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} className="absolute inset-0 rounded-full bg-brand shadow-[0_3px_8px_rgb(225_29_46/0.4)]" />}
      <span className="relative z-10 flex items-center gap-1.5">
        {icon}
        {label}
      </span>
    </button>
    </Tip>
  );
  return (
    <div role="tablist" className="flex rounded-full bg-tab p-1 shadow-tab">
      {tab('default', 'Default', <Volume2 size={15} aria-hidden />, 'Volume boost only')}
      {tab('separate', 'Separate', <AudioLines size={15} aria-hidden />, 'Split vocals and music live')}
    </div>
  );
}

/** Global volume: a big number on the Default tab, a compact row on the Separate tab. */
function Master({ settings, update, compact }: { settings: MixerSettings; update: Update; compact?: boolean }) {
  // Reset and the other non-drag changes glide: the number and the thumb together.
  const num = useGlide(settings.masterPct);
  const pos = useGlide(masterPosOf(settings.masterPct));
  const pct = <Roll text={`${Math.round(num.shown)}%`} still={num.gliding} />;
  return (
    <Card className={compact ? 'mx-row' : 'mx-row mx-row-left'}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="master" className="flex items-center gap-1.5 text-[13px] font-bold"><Volume2 size={15} className="text-brand" aria-hidden />Global volume</label>
        <div className="flex items-center gap-2">
          {compact && <output id="master-value" htmlFor="master" className="text-[15px] font-extrabold tabular-nums">{pct}</output>}
          <Tip text="Back to 100%" align="end"><Btn id="master-reset" tone="small" onClick={() => update({ masterPct: 100 })}><RotateCcw size={13} aria-hidden />Reset</Btn></Tip>
        </div>
      </div>
      {!compact && <output id="master-value" htmlFor="master" className="text-[44px] leading-none font-extrabold tracking-tight tabular-nums">{pct}</output>}
      <Slider id="master" value={masterPosOf(settings.masterPct)} shown={pos.shown} min={0} max={MASTER_POS_MAX} step={1}
        onValue={(p) => {
          const next = masterPctAt(p, settings.masterPct);
          num.mine(next);
          pos.mine(masterPosOf(next));
          update({ masterPct: next });
        }} />
      {!compact && (
        <div className="flex justify-between text-xs text-muted"><span>0%</span><span>Boost up to 600%</span></div>
      )}
      {/* The stems have their own pitch while "Change pitch separately" is on (Separate tab). */}
      <div className="flex items-center justify-between gap-2">
        <span id="pitch-label" className="flex items-center gap-1.5 text-[13px] font-bold"><AudioWaveform size={15} className="text-brand" aria-hidden />Pitch</span>
        <PitchStepper id="pitch" label="Pitch" value={settings.pitch} min={-PITCH_MAX} max={PITCH_MAX} disabled={compact && settings.pitchSplit} onValue={(v) => update({ pitch: clampPitch(v) })} />
      </div>
    </Card>
  );
}

/** Five bars that rise and fall out of step: the sound being split. */
function WaveBars() {
  return (
    <span aria-hidden className="flex h-5 items-center gap-[3px]">
      {[0, 1, 2, 3, 4].map((i) => (
        <motion.span key={i} animate={{ scaleY: [0.3, 1, 0.45, 0.85, 0.3] }} transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut', delay: i * 0.13 }} className="h-full w-[3px] rounded-full bg-white" />
      ))}
    </span>
  );
}

const bannerIcon = 'grid size-9 shrink-0 place-items-center rounded-full';

function Banner({ view, settings, update, retry, compact }: { compact: boolean; view: SepView; settings: MixerSettings; update: Update; retry: () => Promise<void> }) {
  const [gpuNames, setGpuNames] = useState<GpuNames>({});
  useEffect(() => { void probeGpuNames().then(setGpuNames); }, []);
  if (view.kind === 'off') return null;
  const stopped = view.kind === 'stopped' || view.kind === 'error' || view.kind === 'unavailable';
  const tooSlow = view.kind === 'stopped' || (view.kind === 'unavailable' && /too slow/.test(view.cause));
  const nextDelay = Math.min(MAX_DELAY_S, settings.mlDelayS + DELAY_STEP_S);
  let icon: ReactNode;
  let title: string;
  let text: string;
  switch (view.kind) {
    case 'warming':
      icon = <span className={`${bannerIcon} bg-white text-brand`}><motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, ease: 'linear', duration: 1 }} className="grid"><LoaderCircle size={20} aria-hidden /></motion.span></span>;
      title = 'Warming up';
      text = 'Testing your GPU speed. The original mix keeps playing until it is ready.';
      break;
    case 'live':
      icon = (
        <motion.span animate={{ scale: [1, 1.06, 1], boxShadow: ['0 0 0 0 rgb(225 29 46 / 0.5)', '0 0 0 12px rgb(225 29 46 / 0)', '0 0 0 0 rgb(225 29 46 / 0)'] }} transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }} className={`${bannerIcon} bg-brand text-white`}>
          <WaveBars />
        </motion.span>
      );
      title = 'Separating live';
      text = `${view.delayS} s audio delay.`;
      break;
    case 'stopped':
      icon = <span className={`${bannerIcon} bg-brand text-white`}><TriangleAlert size={20} aria-hidden /></span>;
      title = 'Separation stopped';
      text = `This device is too slow to separate in real time (${view.cause}). The original mix is playing.`;
      break;
    default:
      icon = <span className={`${bannerIcon} bg-brand text-white`}><TriangleAlert size={20} aria-hidden /></span>;
      title = 'Separation unavailable';
      text = `${view.cause}. The original mix is playing.`;
  }
  return (
    <motion.div {...fade} className="flex flex-col gap-3.5">
      {/* The banner stays while its state changes: the colour fades, the icon pops in, the text slides in. */}
      <div id="separation-banner" role="status" data-kind={view.kind} className={`flex items-start gap-3 rounded-[20px] p-3.5 transition-colors duration-300 ${stopped ? 'bg-stop text-white' : 'bg-brand-tint'}`}>
        <motion.span key={`icon-${view.kind}`} initial={{ scale: 0.4, opacity: 0, rotate: -30 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 22 }} className="shrink-0">{icon}</motion.span>
        <motion.div key={`text-${view.kind}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="min-w-0 flex-1">
          <h2 className="m-0 text-sm font-extrabold">{title}</h2>
          <Collapse show={!compact}><p className={`m-0 mt-0.5 text-[12.5px] leading-snug ${stopped ? 'text-[#ddd0d2]' : 'text-banner'}`}>{text}</p></Collapse>
          {/* No progress to report during the 10 to 40 s warm-up: a bar that sweeps shows it is alive. */}
          {view.kind === 'warming' && (
            <span aria-hidden className="mt-2.5 block h-1.5 overflow-hidden rounded-full bg-surface">
              <motion.span animate={{ x: ['-100%', '300%'] }} transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }} className="block h-full w-1/3 rounded-full bg-brand" />
            </span>
          )}
        </motion.div>
      </div>
      <Collapse show={tooSlow}>
        <div className="flex flex-col gap-2.5 pt-0.5">
          <Btn tone="primary" id="act-preload" onClick={() => update({ preload: true })}><HardDriveDownload size={16} aria-hidden />Switch to Preload Audio</Btn>
          {settings.mlModel !== 'mdx' && <Btn tone="primary" id="act-default-model" onClick={() => update({ mlModel: 'mdx' as MlModel })}><Cpu size={16} aria-hidden />Switch to Default model</Btn>}
          {settings.mlDelayS < MAX_DELAY_S && <Btn id="act-raise-delay" onClick={() => update({ mlDelayS: nextDelay })}><Timer size={16} aria-hidden />Raise delay limit to {nextDelay} s</Btn>}
          {gpuSelected(gpuNames, settings.gpu) !== 'high-performance' && <Btn id="act-fast-gpu" onClick={() => update({ gpu: 'high-performance' })}><Zap size={16} aria-hidden />Try the high performance GPU</Btn>}
          <Btn id="act-retry" onClick={() => void retry()}><RefreshCw size={16} aria-hidden />Try again</Btn>
        </div>
      </Collapse>
    </motion.div>
  );
}

type Levels = Pick<MixerSettings, 'vocalPct' | 'instrumentalPct' | 'drumsPct' | 'guitarPct' | 'bassPct' | 'pianoPct' | 'othersPct'>;
const LEVEL_KEYS: readonly (keyof Levels)[] = ['vocalPct', 'instrumentalPct', 'drumsPct', 'guitarPct', 'bassPct', 'pianoPct', 'othersPct'];
const levelsOf = (s: MixerSettings): Levels => Object.fromEntries(LEVEL_KEYS.map((k) => [k, s[k]])) as Levels;
const sameLevels = (a: Levels, b: Levels) => LEVEL_KEYS.every((k) => a[k] === b[k]);
/** How long "Undo" stays after a preset. */
const UNDO_MS = 5000;

const PRESETS = [
  { id: 'preset-karaoke', label: 'Karaoke', tip: 'Vocal 0%, instrumental 100%', vocal: 0, instrumental: 100, icon: <MicOff size={15} aria-hidden /> },
  { id: 'preset-half-karaoke', label: 'Half karaoke', tip: 'Vocal 50%, instrumental 100%', vocal: 50, instrumental: 100, icon: <AudioLines size={15} aria-hidden /> },
  { id: 'preset-acappella', label: 'A cappella', tip: 'Vocal 100%, instrumental 0%', vocal: 100, instrumental: 0, icon: <Mic size={15} aria-hidden /> },
  { id: 'preset-reset', label: 'Reset', tip: 'Vocal, instrumental and the split levels back to 100%', vocal: 100, instrumental: 100, icon: <RotateCcw size={15} aria-hidden /> },
];

function SeparateControls({ settings, update, ready, compact, advancedOpen, setAdvancedOpen, splitOpen, setSplitOpen, exportApi }: {
  settings: MixerSettings;
  update: Update;
  ready: boolean;
  compact: boolean;
  advancedOpen: boolean;
  setAdvancedOpen: (open: boolean) => void;
  splitOpen: boolean;
  setSplitOpen: (open: boolean) => void;
  exportApi: ExportApi;
}) {
  // The all-stems model splits the drums, guitar, bass and piano itself: the split switches (and their models) are not available then.
  const all = settings.mlModel === 'sw';
  const [noF16, setNoF16] = useState(false);
  useEffect(() => { void hasShaderF16(settings.gpu).then((ok) => setNoF16(!ok)); }, [settings.gpu]);
  const models = useModels(settings.mlModel, { drums: settings.splitInstrumental && !all, guitar: settings.splitGuitar && !all }, ready, noF16);
  const [gpuNames, setGpuNames] = useState<GpuNames>({});
  useEffect(() => { void probeGpuNames().then(setGpuNames); }, []);
  const [delayDraft, setDelayDraft] = useState(settings.mlDelayS);
  // The preset that was pressed last (n counts presses, so pressing it again replays the ring).
  const [ripple, setRipple] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => setDelayDraft(settings.mlDelayS), [settings.mlDelayS]);
  // After a preset: the levels it replaced, for a few seconds, until something else moves them.
  const [undo, setUndo] = useState<{ before: Levels; after: Levels } | null>(null);
  useEffect(() => {
    if (!undo) return;
    if (!sameLevels(levelsOf(settings), undo.after)) return setUndo(null);
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo, settings]);

  const stemPitch = (id: string, label: string, value: number, onValue: (v: number) => void) =>
    settings.pitchSplit ? <PitchStepper id={id} label={label} value={value} min={-PITCH_MAX} max={PITCH_MAX} onValue={onValue} /> : undefined;

  return (
    <>
      <Rise i={0}><Master settings={settings} update={update} compact /></Rise>
      <Rise i={1}>
      <Card className="mx-rows">
        <SliderRow id="vocal" icon={<Mic size={15} />} label="Vocal" unit="%" pitch={stemPitch('vocal-pitch', 'Vocal pitch', settings.vocalPitch, (v) => update({ vocalPitch: clampPitch(v) }))} value={settings.vocalPct} min={0} max={100} step={5} onValue={(v) => update({ vocalPct: clampPct(v) })} />
        <SliderRow id="instrumental" icon={<Music size={15} />} label="Instrumental" unit="%" pitch={stemPitch('instrumental-pitch', 'Instrumental pitch', settings.instrPitch, (v) => update({ instrPitch: clampPitch(v) }))} value={settings.instrumentalPct} min={0} max={100} step={5} onValue={(v) => update({ instrumentalPct: clampPct(v) })} />
        <Collapse show={all || settings.splitInstrumental || settings.splitGuitar}>
          <div id="split-mix" className="flex flex-col gap-3.5 border-t border-well pt-3.5">
            <Collapse show={all || settings.splitInstrumental}>
              <SliderRow id="drums" icon={<Drum size={15} />} label="Drums" hint="in the instrumental" unit="%" value={settings.drumsPct} min={0} max={100} step={5} onValue={(v) => update({ drumsPct: clampPct(v) })} />
            </Collapse>
            <Collapse show={all || settings.splitGuitar}>
              <SliderRow id="guitar" icon={<Guitar size={15} />} label="Guitar" hint="in the instrumental" unit="%" value={settings.guitarPct} min={0} max={100} step={5} onValue={(v) => update({ guitarPct: clampPct(v) })} />
            </Collapse>
            <Collapse show={all}>
              <SliderRow id="bass" icon={<Waves size={15} />} label="Bass" hint="in the instrumental" unit="%" value={settings.bassPct} min={0} max={100} step={5} onValue={(v) => update({ bassPct: clampPct(v) })} />
            </Collapse>
            <Collapse show={all}>
              <SliderRow id="piano" icon={<Piano size={15} />} label="Piano" hint="in the instrumental" unit="%" value={settings.pianoPct} min={0} max={100} step={5} onValue={(v) => update({ pianoPct: clampPct(v) })} />
            </Collapse>
            <SliderRow id="others" icon={<AudioLines size={15} />} label="Others" hint="in the instrumental" unit="%" value={settings.othersPct} min={0} max={100} step={5} onValue={(v) => update({ othersPct: clampOthersPct(v) })} />
          </div>
        </Collapse>
      </Card>
      </Rise>
      <Collapse show={!compact}>
      <Rise i={2}>
      <div className="presets grid grid-cols-2 gap-2.5" role="group" aria-label="Presets">
        {PRESETS.map((p, i) => {
          const pressed = p.vocal === settings.vocalPct && p.instrumental === settings.instrumentalPct;
          return (
            <Tip key={p.id} text={p.tip} align={i % 2 === 0 ? 'start' : 'end'}>
            <Btn id={p.id} tone="preset" aria-pressed={pressed}
              onClick={() => {
                setRipple((r) => ({ id: p.id, n: (r?.n ?? 0) + 1 }));
                const patch = { vocalPct: p.vocal, instrumentalPct: p.instrumental, ...(p.id === 'preset-reset' ? { drumsPct: 100, guitarPct: 100, bassPct: 100, pianoPct: 100, othersPct: 100 } : {}) };
                const before = levelsOf(settings);
                const after = levelsOf({ ...settings, ...patch });
                if (!sameLevels(before, after)) setUndo({ before, after });
                update(patch);
              }}>
              {/* A ring spreads from the preset that was just chosen (not on opening the popup). */}
              {pressed && ripple?.id === p.id && <motion.span key={ripple.n} aria-hidden initial={{ opacity: 0.55, scale: 0.92 }} animate={{ opacity: 0, scale: 1.18 }} transition={{ duration: 0.55, ease: 'easeOut' }} className="pointer-events-none absolute inset-0 rounded-[14px] ring-2 ring-brand" />}
              {p.icon}
              {p.label}
            </Btn>
            </Tip>
          );
        })}
      </div>
      </Rise>
      </Collapse>
      <Collapse show={!!undo}>
        <div className="flex items-center justify-between gap-3 px-1 text-xs text-muted">
          <span>Levels changed.</span>
          <Btn id="preset-undo" tone="small" onClick={() => { if (undo) update(undo.before); setUndo(null); }}><Undo2 size={13} aria-hidden />Undo</Btn>
        </div>
      </Collapse>
      <Rise i={3}>
      <Disclosure id="advanced" open={advancedOpen} onOpen={(open) => persistAdvanced(open, setAdvancedOpen)} className="rounded-[20px] bg-card" buttonClassName="p-4"
        title={<span className="flex items-center gap-1.5"><Settings2 size={15} className="text-brand" aria-hidden />Advanced <span className="font-medium text-muted">(model, delay, pitch)</span></span>}>
        <div className="flex flex-col gap-3.5 px-4 pb-4">
          <ProcessingRow settings={settings} update={update} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ml-model" className="text-[13px] font-bold">Model</label>
            <Select id="ml-model" value={settings.mlModel} options={MODEL_CHOICES} onValue={(mlModel) => update({ mlModel })} />
          </div>
          <Collapse show={!!models.model}>{models.model && <ModelRow idPrefix="model" line={models.model} />}</Collapse>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ml-gpu" className="text-[13px] font-bold">GPU</label>
            <Select id="ml-gpu" value={gpuSelected(gpuNames, settings.gpu)} options={gpuOptions(gpuNames)} onValue={(gpu) => update({ gpu })} />
          </div>
          <div id="chunk-row" className="flex flex-col gap-3">
            <SliderRow id="ml-delay" icon={<Timer size={15} />} label="Delay limit" unit=" s" value={delayDraft} min={MIN_DELAY_S} max={MAX_DELAY_S} step={1} onValue={(v) => setDelayDraft(clampDelayS(v))} />
            <div className="flex items-center justify-between gap-3">
              <p className="m-0 text-xs leading-snug text-muted">More audio delay gives more quality but uses more GPU.</p>
              <Btn id="ml-delay-apply" tone="small" disabled={delayDraft === settings.mlDelayS} onClick={() => update({ mlDelayS: clampDelayS(delayDraft) })}>Apply</Btn>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="pitch-split" className="text-[13px] font-bold">Change pitch separately</label>
            {/* Turning it on starts both stems at the global pitch, so the sound does not jump. */}
            <Switch id="pitch-split" checked={settings.pitchSplit} onChange={(on) => update(on ? { pitchSplit: true, vocalPitch: settings.pitch, instrPitch: settings.pitch } : { pitchSplit: false })} />
          </div>
          <Disclosure id="split" open={splitOpen} onOpen={setSplitOpen} className="rounded-2xl bg-surface/70" buttonClassName="p-3"
            title={<span className="flex items-center gap-1.5"><Drum size={15} className="text-brand" aria-hidden />Split instrumental</span>}>
            <div className="flex flex-col gap-3 px-3 pb-3">
              {all ? (
                <p id="split-all" className="m-0 text-xs leading-snug text-muted">Focus Instrumental Splitting already splits the drums, guitar, bass and piano, each with its own level. Pick another model to use the switches here.</p>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="split-on" className="text-[13px] font-bold">Drums</label>
                    <Switch id="split-on" checked={settings.splitInstrumental} onChange={(on) => update({ splitInstrumental: on })} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="split-guitar" className="text-[13px] font-bold">Guitar</label>
                    <Switch id="split-guitar" checked={settings.splitGuitar} onChange={(on) => update({ splitGuitar: on })} />
                  </div>
                  <p className="m-0 text-xs leading-snug text-muted">Each extra split uses more GPU and adds more delay over the Delay limit.</p>
                  <Btn id="split-focus-model" onClick={() => update({ mlModel: 'sw' })}><Cpu size={16} aria-hidden />Focus Instrumental Model</Btn>
                  <Collapse show={!!models.drums}>{models.drums && <ModelRow idPrefix="drums" line={models.drums} />}</Collapse>
                  <Collapse show={!!models.guitar}>{models.guitar && <ModelRow idPrefix="guitar" line={models.guitar} />}</Collapse>
                </>
              )}
            </div>
          </Disclosure>
        </div>
      </Disclosure>
      </Rise>
      <Rise i={4}>
        <ExportSection api={exportApi} reveal={settings.preload} />
      </Rise>
    </>
  );
}

function persistAdvanced(open: boolean, set: (open: boolean) => void): void {
  set(open);
  try {
    localStorage.setItem(ADVANCED_KEY, open ? '1' : '0');
  } catch {
    /* storage blocked */
  }
}
