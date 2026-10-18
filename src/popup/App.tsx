import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AudioLines, Cpu, Download, Drum, LoaderCircle, Mic, MicOff, Music, RefreshCw, RotateCcw, Settings2, SlidersVertical, Timer, TriangleAlert, Volume2 } from 'lucide-react';
import type { ContentStatus, GetStatus, GetTabSettings, SetTabSettings } from '../shared/messages';
import { clampDelayS, clampOthersPct, clampPct, masterPctAt, masterPosOf, MASTER_POS_MAX, normalizeSettings, type MixerSettings, type Mode } from '../shared/settings';
import { separationView, type SepView } from '../shared/separation-view';
import { MAX_DELAY_S, MIN_DELAY_S } from '../ml/rof-plan';
import type { MlModel } from '../worklet/protocol';
import { installModel, useModels, type ModelLine } from './models';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Blocked, Btn, Card, Collapse, Disclosure, Rise, Select, Slider, SliderRow, Switch, fade, slide, useGlide, type Choice } from './ui';

type Update = (patch: Partial<MixerSettings>) => void;

const LOADING_POLL_MS = 500;
/** One click on "Raise delay limit" adds this many seconds. */
const DELAY_STEP_S = 4;
// The Advanced section stays open between popup openings, and opens by itself when a non-default model is in use.
const ADVANCED_KEY = 'advancedOpen';

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
      if (latest.current.mlModel !== 'mdx' || latest.current.splitInstrumental) setAdvancedOpen(true);
      if (latest.current.splitInstrumental) setSplitOpen(true);
      setReady(true);
      await refresh();
    })();
  }, [refresh]);

  const view = separationView(settings.mode, loaded?.s);
  const warming = view.kind === 'warming';
  // While the separator starts or ML warms up, poll so the banner moves on by itself.
  useEffect(() => {
    if (!warming) return;
    const t = setTimeout(() => void refresh(), LOADING_POLL_MS);
    return () => clearTimeout(t);
  }, [warming, loaded, refresh]);

  // Stopped, too slow: off and on again is the retry the content script understands.
  const retry = async () => {
    if (tabId.current === null) return;
    const off: SetTabSettings = { type: 'set-tab-settings', tabId: tabId.current, settings: { ...latest.current, mode: 'default' } };
    await chrome.runtime.sendMessage(off);
    update({ mode: 'separate' });
  };

  const noContent = loaded !== null && !loaded.s;
  const separate = settings.mode === 'separate' && !noContent;
  const note = noteText(blocked, settings, loaded);

  return (
    <MotionConfig reducedMotion="user">
    <Blocked.Provider value={blocked}>
      <main className="flex flex-col gap-3.5">
        <header className="flex items-center gap-2.5 text-[17px] font-extrabold tracking-tight">
          <span className="grid size-8 place-items-center rounded-[10px] bg-brand text-white"><SlidersVertical size={18} aria-hidden /></span>
          All Mixer!
        </header>
        {!noContent && <Tabs mode={separate ? 'separate' : 'default'} onMode={(mode) => update({ mode })} />}
        <AnimatePresence mode="wait" custom={separate ? 1 : -1}>
        {separate ? (
          <motion.div key="separate" id="panel-separate" custom={1} variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.2 }} className="flex flex-col gap-3.5">
            <AnimatePresence mode="wait" initial={false}>
              {view.kind !== 'off' && <Banner key="banner" view={view} settings={settings} update={update} retry={retry} />}
            </AnimatePresence>
            <SeparateControls settings={settings} update={update} ready={ready} advancedOpen={advancedOpen} setAdvancedOpen={setAdvancedOpen} splitOpen={splitOpen} setSplitOpen={setSplitOpen} />
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
        <p id="status" role="status" className="m-0 text-[13px] leading-snug text-muted empty:hidden">{note}</p>
      </main>
    </Blocked.Provider>
    </MotionConfig>
  );
}

function Tabs({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  const blocked = useContext(Blocked);
  const tab = (m: Mode, label: string, icon: ReactNode) => (
    <button id={`tab-${m}`} type="button" role="tab" aria-selected={mode === m} disabled={blocked} onClick={() => onMode(m)}
      className="relative flex flex-1 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent py-2 text-[13px] font-bold text-muted transition-colors duration-200 aria-selected:text-white disabled:opacity-45">
      {mode === m && <motion.span layoutId="tab-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} className="absolute inset-0 rounded-full bg-brand shadow-[0_3px_8px_rgb(225_29_46/0.4)]" />}
      <span className="relative z-10 flex items-center gap-1.5">
        {icon}
        {label}
      </span>
    </button>
  );
  return (
    <div role="tablist" className="flex rounded-full bg-[#f4f0f0] p-1 shadow-[inset_2px_2px_5px_#e2dadb,inset_-2px_-2px_5px_#fff]">
      {tab('default', 'Default', <Volume2 size={15} aria-hidden />)}
      {tab('separate', 'Separate', <AudioLines size={15} aria-hidden />)}
    </div>
  );
}

/** Global volume: a big number on the Default tab, a compact row on the Separate tab. */
function Master({ settings, update, compact }: { settings: MixerSettings; update: Update; compact?: boolean }) {
  // Reset and the other non-drag changes glide: the number and the thumb together.
  const num = useGlide(settings.masterPct);
  const pos = useGlide(masterPosOf(settings.masterPct));
  const pct = `${Math.round(num.shown)}%`;
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="master" className="flex items-center gap-1.5 text-[13px] font-bold"><Volume2 size={15} className="text-brand" aria-hidden />Global volume</label>
        <div className="flex items-center gap-2">
          {compact && <output id="master-value" htmlFor="master" className="text-[15px] font-extrabold tabular-nums">{pct}</output>}
          <Btn id="master-reset" tone="small" onClick={() => update({ masterPct: 100 })}><RotateCcw size={13} aria-hidden />Reset</Btn>
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

function Banner({ view, settings, update, retry }: { view: SepView; settings: MixerSettings; update: Update; retry: () => Promise<void> }) {
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
      <div id="separation-banner" role="status" data-kind={view.kind} className={`flex items-start gap-3 rounded-[20px] p-3.5 transition-colors duration-300 ${stopped ? 'bg-ink text-white' : 'bg-brand-tint'}`}>
        <motion.span key={`icon-${view.kind}`} initial={{ scale: 0.4, opacity: 0, rotate: -30 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 22 }} className="shrink-0">{icon}</motion.span>
        <motion.div key={`text-${view.kind}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="min-w-0 flex-1">
          <h2 className="m-0 text-sm font-extrabold">{title}</h2>
          <p className={`m-0 mt-0.5 text-[12.5px] leading-snug ${stopped ? 'text-[#ddd0d2]' : 'text-[#4c4047]'}`}>{text}</p>
          {/* No progress to report during the 10 to 40 s warm-up: a bar that sweeps shows it is alive. */}
          {view.kind === 'warming' && (
            <span aria-hidden className="mt-2.5 block h-1.5 overflow-hidden rounded-full bg-white">
              <motion.span animate={{ x: ['-100%', '300%'] }} transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }} className="block h-full w-1/3 rounded-full bg-brand" />
            </span>
          )}
        </motion.div>
      </div>
      <Collapse show={tooSlow}>
        <div className="flex flex-col gap-2.5 pt-0.5">
          {settings.mlModel !== 'mdx' && <Btn tone="primary" id="act-default-model" onClick={() => update({ mlModel: 'mdx' as MlModel })}><Cpu size={16} aria-hidden />Switch to Default model</Btn>}
          {settings.mlDelayS < MAX_DELAY_S && <Btn id="act-raise-delay" onClick={() => update({ mlDelayS: nextDelay })}><Timer size={16} aria-hidden />Raise delay limit to {nextDelay} s</Btn>}
          <Btn id="act-retry" onClick={() => void retry()}><RefreshCw size={16} aria-hidden />Try again</Btn>
        </div>
      </Collapse>
    </motion.div>
  );
}

const MODEL_CHOICES: readonly Choice<MlModel>[] = [
  { value: 'mdx', label: 'Default' },
  { value: 'roformer', label: 'High quality', hint: 'Optional download' },
  { value: 'deux', label: 'Best quality', hint: 'Needs a good GPU, optional download' },
];

const PRESETS = [
  { id: 'preset-karaoke', label: 'Karaoke', vocal: 0, instrumental: 100, icon: <MicOff size={15} aria-hidden /> },
  { id: 'preset-half-karaoke', label: 'Half karaoke', vocal: 50, instrumental: 100, icon: <AudioLines size={15} aria-hidden /> },
  { id: 'preset-acappella', label: 'A cappella', vocal: 100, instrumental: 0, icon: <Mic size={15} aria-hidden /> },
  { id: 'preset-reset', label: 'Reset', vocal: 100, instrumental: 100, icon: <RotateCcw size={15} aria-hidden /> },
];

function SeparateControls({ settings, update, ready, advancedOpen, setAdvancedOpen, splitOpen, setSplitOpen }: {
  settings: MixerSettings;
  update: Update;
  ready: boolean;
  advancedOpen: boolean;
  setAdvancedOpen: (open: boolean) => void;
  splitOpen: boolean;
  setSplitOpen: (open: boolean) => void;
}) {
  const models = useModels(settings.mlModel, settings.splitInstrumental, ready);
  const [delayDraft, setDelayDraft] = useState(settings.mlDelayS);
  // The preset that was pressed last (n counts presses, so pressing it again replays the ring).
  const [ripple, setRipple] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => setDelayDraft(settings.mlDelayS), [settings.mlDelayS]);

  return (
    <>
      <Rise i={0}><Master settings={settings} update={update} compact /></Rise>
      <Rise i={1}>
      <Card>
        <SliderRow id="vocal" icon={<Mic size={15} />} label="Vocal" unit="%" value={settings.vocalPct} min={0} max={100} step={5} onValue={(v) => update({ vocalPct: clampPct(v) })} />
        <SliderRow id="instrumental" icon={<Music size={15} />} label="Instrumental" unit="%" value={settings.instrumentalPct} min={0} max={100} step={5} onValue={(v) => update({ instrumentalPct: clampPct(v) })} />
        <Collapse show={settings.splitInstrumental}>
          <div id="split-mix" className="flex flex-col gap-3.5 border-t border-well pt-3.5">
            <SliderRow id="drums" icon={<Drum size={15} />} label="Drums" hint="in the instrumental" unit="%" value={settings.drumsPct} min={0} max={100} step={5} onValue={(v) => update({ drumsPct: clampPct(v) })} />
            <SliderRow id="others" icon={<AudioLines size={15} />} label="Others" hint="in the instrumental" unit="%" value={settings.othersPct} min={0} max={100} step={5} onValue={(v) => update({ othersPct: clampOthersPct(v) })} />
          </div>
        </Collapse>
      </Card>
      </Rise>
      <Rise i={2}>
      <div className="presets grid grid-cols-2 gap-2.5" role="group" aria-label="Presets">
        {PRESETS.map((p) => {
          const pressed = p.vocal === settings.vocalPct && p.instrumental === settings.instrumentalPct;
          return (
            <Btn key={p.id} id={p.id} tone="preset" aria-pressed={pressed}
              onClick={() => {
                setRipple((r) => ({ id: p.id, n: (r?.n ?? 0) + 1 }));
                update({ vocalPct: p.vocal, instrumentalPct: p.instrumental, ...(p.id === 'preset-reset' ? { drumsPct: 100, othersPct: 100 } : {}) });
              }}>
              {/* A ring spreads from the preset that was just chosen (not on opening the popup). */}
              {pressed && ripple?.id === p.id && <motion.span key={ripple.n} aria-hidden initial={{ opacity: 0.55, scale: 0.92 }} animate={{ opacity: 0, scale: 1.18 }} transition={{ duration: 0.55, ease: 'easeOut' }} className="pointer-events-none absolute inset-0 rounded-[14px] ring-2 ring-brand" />}
              {p.icon}
              {p.label}
            </Btn>
          );
        })}
      </div>
      </Rise>
      <Rise i={3}>
      <Disclosure id="advanced" open={advancedOpen} onOpen={(open) => persistAdvanced(open, setAdvancedOpen)} className="rounded-[20px] bg-card" buttonClassName="p-4"
        title={<span className="flex items-center gap-1.5"><Settings2 size={15} className="text-brand" aria-hidden />Advanced <span className="font-medium text-muted">(model, delay)</span></span>}>
        <div className="flex flex-col gap-3.5 px-4 pb-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ml-model" className="text-[13px] font-bold">Model</label>
            <Select id="ml-model" value={settings.mlModel} options={MODEL_CHOICES} onValue={(mlModel) => update({ mlModel })} />
          </div>
          <Collapse show={!!models.model}>{models.model && <ModelRow idPrefix="model" line={models.model} />}</Collapse>
          <div id="chunk-row" className="flex flex-col gap-3">
            <SliderRow id="ml-delay" icon={<Timer size={15} />} label="Delay limit" unit=" s" value={delayDraft} min={MIN_DELAY_S} max={MAX_DELAY_S} step={1} onValue={(v) => setDelayDraft(clampDelayS(v))} />
            <div className="flex items-center justify-between gap-3">
              <p className="m-0 text-xs leading-snug text-muted">More audio delay gives more quality but uses more GPU.</p>
              <Btn id="ml-delay-apply" tone="small" disabled={delayDraft === settings.mlDelayS} onClick={() => update({ mlDelayS: clampDelayS(delayDraft) })}>Apply</Btn>
            </div>
          </div>
          <Disclosure id="split" open={splitOpen} onOpen={setSplitOpen} className="rounded-2xl bg-white/70" buttonClassName="p-3"
            title={<span className="flex items-center gap-1.5"><Drum size={15} className="text-brand" aria-hidden />Split instrumental</span>}>
            <div className="flex flex-col gap-3 px-3 pb-3">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="split-on" className="text-[13px] font-bold">Drums</label>
                <Switch id="split-on" checked={settings.splitInstrumental} onChange={(on) => update({ splitInstrumental: on })} />
              </div>
              <p className="m-0 text-xs leading-snug text-muted">Splitting the instrumental adds more delay over the Delay limit.</p>
              <Collapse show={!!models.drums}>{models.drums && <ModelRow idPrefix="drums" line={models.drums} />}</Collapse>
            </div>
          </Disclosure>
        </div>
      </Disclosure>
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

function ModelRow({ idPrefix, line }: { idPrefix: 'model' | 'drums'; line: ModelLine }) {
  return (
    <div id={`${idPrefix}-row`} className="flex flex-col gap-2">
      <p className="m-0 flex items-center justify-between gap-3 text-xs leading-snug text-muted">
        <span id={`${idPrefix}-text`}>{line.text}</span>
        {line.button && (
          <Btn id={`${idPrefix}-btn`} tone="small" onClick={() => installModel(line.id)}>
            {line.button === 'Update' ? <RefreshCw size={13} aria-hidden /> : <Download size={13} aria-hidden />}
            {line.button}
          </Btn>
        )}
      </p>
      {line.progress !== undefined && (
        <div role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(line.progress)} className="h-2 overflow-hidden rounded-full bg-well shadow-pressed">
          <motion.div initial={false} animate={{ width: `${line.progress}%` }} transition={{ duration: 0.4, ease: 'easeOut' }} className="h-full rounded-full bg-linear-to-r from-[#f2505a] to-[#d3101c]" />
        </div>
      )}
    </div>
  );
}
