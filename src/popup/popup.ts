import type { ContentStatus, GetStatus, GetTabSettings, SetTabSettings } from '../shared/messages';
import { clampDelayS, clampPct, normalizeSettings, type MixerSettings, type Mode } from '../shared/settings';
import type { MlModel } from '../worklet/protocol';
import { detectSite } from '../content/youtube-dom';
import { MODEL_IDS, MODEL_LABEL, keyInstalled, keyProgress, keyRemote, mb, modelState, type InstalledModel, type ModelId, type ModelState, type Progress, type RemoteRecord } from '../shared/model-store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const master = $<HTMLInputElement>('master');
const masterValue = $<HTMLOutputElement>('master-value');
const vocal = $<HTMLInputElement>('vocal');
const vocalValue = $<HTMLOutputElement>('vocal-value');
const instrumental = $<HTMLInputElement>('instrumental');
const instrumentalValue = $<HTMLOutputElement>('instrumental-value');
const mlModel = $<HTMLSelectElement>('ml-model');
const mlDelay = $<HTMLInputElement>('ml-delay');
const mlDelayValue = $<HTMLOutputElement>('ml-delay-value');
const mlDelayApply = $<HTMLButtonElement>('ml-delay-apply');
const modelRow = $<HTMLParagraphElement>('model-row');
const modelText = $<HTMLSpanElement>('model-text');
const modelBtn = $<HTMLButtonElement>('model-btn');
const advanced = $<HTMLDetailsElement>('advanced');
const presets = [...document.querySelectorAll<HTMLButtonElement>('.presets button')];
const status = $<HTMLParagraphElement>('status');

let tabId: number | null = null;
let settings: MixerSettings = normalizeSettings({});

function render(): void {
  for (const tab of tabs) {
    const selected = tab.dataset.mode === settings.mode;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')!).hidden = !selected;
  }
  master.value = String(settings.masterPct);
  masterValue.value = `${settings.masterPct}%`;
  vocal.value = String(settings.vocalPct);
  vocalValue.value = `${settings.vocalPct}%`;
  instrumental.value = String(settings.instrumentalPct);
  instrumentalValue.value = `${settings.instrumentalPct}%`;
  mlModel.value = settings.mlModel;
  mlDelay.value = String(settings.mlDelayS);
  mlDelayValue.value = `${settings.mlDelayS} s`;
  mlDelayApply.disabled = true;
  renderModel();
  for (const b of presets) {
    const on = Number(b.dataset.vocal) === settings.vocalPct && Number(b.dataset.instrumental) === settings.instrumentalPct;
    b.setAttribute('aria-pressed', String(on));
  }
}

let pending = false;
function save(): void {
  render();
  // Coalesce slider drags to one message per frame.
  if (pending || tabId === null) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const msg: SetTabSettings = { type: 'set-tab-settings', tabId: tabId!, settings };
    void chrome.runtime.sendMessage(msg).then(refreshStatus);
  });
}

function setMode(mode: Mode): void {
  settings = { ...settings, mode };
  if (mode !== 'separate') {
    // Do not wait for refreshStatus: drop the stale separation text and the warming poll now.
    clearTimeout(pollTimer);
    status.textContent = '';
  }
  save();
}

const STATUS_TEXT: Record<ContentStatus['audio'], string> = {
  idle: '',
  'waiting-for-gesture': 'Click anywhere on the YouTube page once to enable the boost.',
  active: '',
  error: 'Audio error',
};

function separationText(s: ContentStatus): string {
  const sep = s.separation;
  if (settings.mode !== 'separate' || !sep) return '';
  if (sep.state === 'loading') return 'Starting separation…';
  if (sep.state === 'on') {
    const choice = sep.choice;
    switch (choice?.state) {
      case 'warming':
        return 'Separation warming up… Playing the original mix.';
      case 'unavailable':
        return `Separation unavailable: ${choice.cause ?? 'unknown'}. Playing the original mix.`;
      case 'stopped':
        return 'Separation stopped: this device is too slow (ML missed its deadline). Playing the original mix. Switch to Default and back to retry.';
      default:
        return `Separation on · ${Math.round(sep.latency.processingMs)} ms delay`;
    }
  }
  if (sep.state === 'error') return `Separation unavailable: ${sep.error ?? 'unknown'}. Playing the original mix.`;
  return '';
}

// While the separator starts or ML warms up, poll so the popup moves on from "Starting separation…" by itself.
const LOADING_POLL_MS = 500;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

async function refreshStatus(): Promise<void> {
  if (tabId === null) return;
  clearTimeout(pollTimer);
  const req: GetStatus = { type: 'get-status' };
  const s: ContentStatus | undefined = await chrome.tabs.sendMessage(tabId, req).catch(() => undefined);
  if (!s) {
    status.textContent = 'Reload this YouTube tab to start All Mixer!.';
  } else if (s.audio === 'error') {
    status.textContent = `${STATUS_TEXT.error}: ${s.error ?? 'unknown'}`;
  } else if (!s.videoFound && settings.masterPct !== 100) {
    status.textContent = 'No video player on this page yet.';
  } else {
    status.textContent = separationText(s) || STATUS_TEXT[s.audio];
  }
  const warming = s?.separation?.state === 'loading' || s?.separation?.choice?.state === 'warming';
  if (warming && settings.mode === 'separate') {
    pollTimer = setTimeout(() => void refreshStatus(), LOADING_POLL_MS);
  }
}

// The RoFormer models are separate downloads (background/model-manager.ts); their state lives in chrome.storage.local.
interface ModelRecords {
  installed?: InstalledModel;
  remote?: RemoteRecord;
  progress?: Progress;
}
const records: Record<ModelId, ModelRecords> = { roformer: {}, deux: {} };
let modelTimer: ReturnType<typeof setTimeout> | undefined;

const isModelId = (m: string): m is ModelId => (MODEL_IDS as readonly string[]).includes(m);

function modelLine(id: ModelId, s: ModelState): { text: string; button?: string } {
  const label = MODEL_LABEL[id];
  switch (s.kind) {
    case 'missing':
      return { text: `${label} is a one-time download${s.size ? ` (${mb(s.size)})` : ''}.`, button: 'Download' };
    case 'downloading':
      return { text: `Downloading… ${Math.floor((100 * s.done) / s.total)}% (${mb(s.done)} of ${mb(s.total)})` };
    case 'error':
      return { text: `Download failed: ${s.message}`, button: 'Try again' };
    case 'update':
      return { text: `Update available: ${label} model v${s.version} (${mb(s.size)}).`, button: 'Update' };
    case 'incompatible':
      return { text: `The ${label} model needs a newer version of All Mixer!.` };
    case 'ready':
      return { text: `${label} model v${s.version} installed.` };
  }
}

function renderModel(): void {
  clearTimeout(modelTimer);
  const now = Date.now();
  const states = Object.fromEntries(MODEL_IDS.map((id) => [id, modelState(records[id].installed, records[id].remote, records[id].progress, now)])) as Record<ModelId, ModelState>;
  // Shown for the selected downloadable model, and for any model with an update on offer or a download running.
  const id = isModelId(settings.mlModel) ? settings.mlModel : MODEL_IDS.find((m) => states[m].kind === 'update' || states[m].kind === 'downloading');
  modelRow.hidden = !id;
  if (id) {
    const line = modelLine(id, states[id]);
    modelText.textContent = line.text;
    modelBtn.hidden = !line.button;
    modelBtn.textContent = line.button ?? '';
    modelBtn.dataset.id = id;
  }
  // A download whose worker was stopped goes stale after STALL_MS: look again then.
  if (MODEL_IDS.some((m) => states[m].kind === 'downloading')) modelTimer = setTimeout(renderModel, 5000);
}

async function initModel(): Promise<void> {
  const o = await chrome.storage.local.get(MODEL_IDS.flatMap((id) => [keyInstalled(id), keyRemote(id), keyProgress(id)]));
  for (const id of MODEL_IDS) {
    records[id] = { installed: o[keyInstalled(id)] as InstalledModel | undefined, remote: o[keyRemote(id)] as RemoteRecord | undefined, progress: o[keyProgress(id)] as Progress | undefined };
  }
  renderModel();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const id of MODEL_IDS) {
      if (keyInstalled(id) in changes) records[id].installed = changes[keyInstalled(id)].newValue as InstalledModel | undefined;
      if (keyRemote(id) in changes) records[id].remote = changes[keyRemote(id)].newValue as RemoteRecord | undefined;
      if (keyProgress(id) in changes) records[id].progress = changes[keyProgress(id)].newValue as Progress | undefined;
    }
    renderModel();
  });
  void chrome.runtime.sendMessage({ type: 'model-check' }); // a newer model shows up through the storage change
}

modelBtn.addEventListener('click', () => void chrome.runtime.sendMessage({ type: 'model-install', id: modelBtn.dataset.id }));

function disableAll(message: string): void {
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')) {
    el.disabled = true;
  }
  status.textContent = message;
}

// The Advanced section stays open between popup openings, and opens by itself when a non-default model is in use.
const ADVANCED_KEY = 'advancedOpen';
try {
  advanced.open = localStorage.getItem(ADVANCED_KEY) === '1';
} catch {
  /* storage blocked: stays closed */
}
advanced.addEventListener('toggle', () => {
  try {
    localStorage.setItem(ADVANCED_KEY, advanced.open ? '1' : '0');
  } catch {
    /* storage blocked */
  }
});

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // `tab.url` is only visible for our host permissions, i.e. YouTube / YT Music.
  if (tab?.id === undefined || !tab.url || !detectSite(new URL(tab.url).hostname)) {
    render();
    disableAll('Open a youtube.com or music.youtube.com tab to use All Mixer!.');
    return;
  }
  tabId = tab.id;
  const req: GetTabSettings = { type: 'get-tab-settings', tabId };
  settings = normalizeSettings(await chrome.runtime.sendMessage(req));
  if (settings.mlModel !== 'mdx') advanced.open = true;
  render();
  void initModel();
  await refreshStatus();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode as Mode));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    setMode(next.dataset.mode as Mode);
  });
}

master.addEventListener('input', () => {
  settings = { ...settings, masterPct: clampPct(master.value) };
  save();
});

vocal.addEventListener('input', () => {
  settings = { ...settings, vocalPct: clampPct(vocal.value) };
  save();
});

instrumental.addEventListener('input', () => {
  settings = { ...settings, instrumentalPct: clampPct(instrumental.value) };
  save();
});

// Moving the slider only changes the label; Apply re-plans the chunk (a new warm-up).
mlDelay.addEventListener('input', () => {
  const s = clampDelayS(mlDelay.value);
  mlDelayValue.value = `${s} s`;
  mlDelayApply.disabled = s === settings.mlDelayS;
});
mlDelayApply.addEventListener('click', () => {
  settings = { ...settings, mlDelayS: clampDelayS(mlDelay.value) };
  save();
});

mlModel.addEventListener('change', () => {
  settings = { ...settings, mlModel: mlModel.value as MlModel };
  save();
});

for (const b of presets) {
  b.addEventListener('click', () => {
    settings = { ...settings, vocalPct: Number(b.dataset.vocal), instrumentalPct: Number(b.dataset.instrumental) };
    save();
  });
}

$<HTMLButtonElement>('master-reset').addEventListener('click', () => {
  settings = { ...settings, masterPct: 100 };
  save();
});

void init();
