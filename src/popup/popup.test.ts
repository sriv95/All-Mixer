import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentStatus } from '../shared/messages';
import { MODEL_FORMAT } from '../shared/model-store';

const html = readFileSync('src/popup/popup.html', 'utf8');
const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');

const YT = { id: 7, url: 'https://www.youtube.com/watch?v=abcdefghijk' };
const okStatus: ContentStatus = { site: 'youtube', videoFound: true, audio: 'active',
  gain: 1,
  videoDelay: { state: 'off', delayMs: 0 },
};

interface Opts {
  tab?: { id?: number; url?: string };
  stored?: unknown;
  status?: ContentStatus | 'reject';
  /** chrome.storage.local contents (model records) */
  local?: Record<string, unknown>;
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const has = (id: string) => document.getElementById(id) !== null;
const settle = () => new Promise((r) => setTimeout(r, 50));
const banner = () => document.getElementById('separation-banner');
/** A Disclosure (Advanced, Split instrumental) is open when its button says so. */
const isOpen = (id: string) => el(`${id}-toggle`).getAttribute('aria-expanded') === 'true';
const tabSeparate = () => el('tab-separate').click();
const tabDefault = () => el('tab-default').click();

/** React tracks the value it last set: write through the prototype setter so the event counts as a user change. */
function input(id: string, v: string): void {
  const e = el<HTMLInputElement>(id);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(e, v);
  e.dispatchEvent(new Event('input', { bubbles: true }));
}
/** Pick an option of a dropdown the way a user does: open it, click the option. */
function choose(id: string, v: string): void {
  el(id).click();
  el(`${id}-option-${v}`).click();
}

let sendMessage: ReturnType<typeof vi.fn>;

async function load(o: Opts = {}) {
  vi.resetModules();
  document.body.innerHTML = body;
  sendMessage = vi.fn((msg: { type: string }) =>
    Promise.resolve(msg.type === 'get-tab-settings' ? o.stored : undefined),
  );
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn().mockResolvedValue([o.tab ?? YT]),
      sendMessage: vi.fn(() =>
        o.status === 'reject' ? Promise.reject(new Error('no receiver')) : Promise.resolve(o.status ?? okStatus),
      ),
    },
    runtime: { sendMessage },
    storage: { local: { get: vi.fn().mockResolvedValue(o.local ?? {}) }, onChanged: { addListener: vi.fn() } },
  });
  // Animations finish at once, so panels that leave are gone after one settle.
  (await import('motion/react')).MotionGlobalConfig.skipAnimations = true;
  await import('./popup');
  // The popup reads the tab, its settings, the status and the model records one after another: wait for the first reads, then let the renders land (a busy parallel run needs more than one settle).
  if ((o.tab ?? YT).url?.startsWith('http')) await vi.waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalled(), { timeout: 2000 });
  await new Promise((r) => setTimeout(r, 150));
}

const sent = () =>
  sendMessage.mock.calls.map((c) => c[0]).filter((m: { type: string }) => m.type === 'set-tab-settings');

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});


describe('popup', () => {
  it('disables everything on a non-web tab', async () => {
    await load({ tab: { id: 1, url: 'chrome://extensions/' } });
    for (const e of document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) {
      expect(e.disabled).toBe(true);
    }
    expect(el('status').textContent).toMatch(/web page/);
  });

  it('shows a placeholder until the tab settings are read, not the defaults', async () => {
    vi.resetModules();
    document.body.innerHTML = body;
    let release!: (v: unknown) => void;
    const send = vi.fn((msg: { type: string }) => (msg.type === 'get-tab-settings' ? new Promise((r) => (release = r)) : Promise.resolve(undefined)));
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn().mockResolvedValue([YT]), sendMessage: vi.fn().mockResolvedValue(okStatus) },
      runtime: { sendMessage: send },
      storage: { local: { get: vi.fn().mockResolvedValue({}) }, onChanged: { addListener: vi.fn() } },
    });
    (await import('motion/react')).MotionGlobalConfig.skipAnimations = true;
    await import('./popup');
    await settle();
    expect(document.querySelector('[aria-busy=true]')).not.toBeNull();
    expect(has('master')).toBe(false);
    release({ mode: 'separate' });
    await new Promise((r) => setTimeout(r, 150));
    expect(document.querySelector('[aria-busy=true]')).toBeNull();
    expect(has('panel-separate')).toBe(true); // straight to the stored tab, no flash of Default
  });

  it('disables everything when the tab url is hidden', async () => {
    await load({ tab: { id: 1 } });
    expect(el<HTMLInputElement>('master').disabled).toBe(true);
  });

  it('renders stored settings', async () => {
    await load({ stored: { mode: 'separate', masterPct: 250 } });
    expect(el<HTMLInputElement>('master').value).toBe('18'); // 250 % snaps to the 200 % stop (position 18)
    expect(el<HTMLOutputElement>('master-value').value).toBe('250%');
    expect(el('tab-separate').getAttribute('aria-selected')).toBe('true');
    expect(has('panel-separate')).toBe(true);
  });

  it('the Separate tab and the Separate mode switch send the mode and show its settings, the Default tab hides them', async () => {
    await load({ stored: { mode: 'default', masterPct: 100 } });
    expect(has('panel-separate')).toBe(false);
    el('separate-mode').click();
    await settle();
    expect(has('panel-separate')).toBe(true);
    expect(sent().at(-1)).toMatchObject({ tabId: 7, settings: { mode: 'separate' } });
    tabDefault();
    await settle();
    expect(has('panel-separate')).toBe(false);
    expect(sent().at(-1).settings.mode).toBe('default');
    tabSeparate();
    await settle();
    expect(sent().at(-1).settings.mode).toBe('separate');
  });

  it('slider input sends a clamped masterPct', async () => {
    await load();
    input('master', '9999');
    await settle();
    expect(sent().at(-1).settings.masterPct).toBe(600);
    input('master', '-40');
    await settle();
    expect(sent().at(-1).settings.masterPct).toBe(0);
    expect(el<HTMLOutputElement>('master-value').value).toBe('0%');
  });

  it('slider has 100 % in the middle and uses 5/10/100 steps', async () => {
    await load();
    expect(el<HTMLInputElement>('master').value).toBe('15');
    const at = async (pos: number) => {
      input('master', String(pos));
      await settle();
      return sent().at(-1).settings.masterPct;
    };
    expect(await at(1)).toBe(5);
    expect(await at(10)).toBe(50);
    expect(await at(11)).toBe(60);
    expect(await at(15)).toBe(100);
    expect(await at(16)).toBe(200); // one arrow key above 100 % takes one stop
    expect(await at(17)).toBe(100); // and one back
    expect(await at(30)).toBe(600);
  });

  it('Global Volume Reset sends 100', async () => {
    await load({ stored: { masterPct: 400 } });
    el('master-reset').click();
    await settle();
    expect(sent().at(-1).settings.masterPct).toBe(100);
    expect(el<HTMLOutputElement>('master-value').value).toBe('100%');
  });

  describe('compact view', () => {
    it('hides the presets and the banner text, and is remembered', async () => {
      await load({ stored: { mode: 'separate' }, status: { ...okStatus, separation: { state: 'on', latency: { engine: 'ml', processingMs: 1949 }, choice: { state: 'on' } } } as unknown as ContentStatus });
      expect(has('preset-karaoke')).toBe(true);
      expect(banner()!.textContent).toMatch(/audio delay/);
      el('compact-toggle').click();
      await settle();
      expect(el('compact-toggle').getAttribute('aria-pressed')).toBe('true');
      expect(has('preset-karaoke')).toBe(false);
      expect(banner()!.textContent).toBe('Separating live'); // the title stays, the detail goes
      expect(has('vocal')).toBe(true); // the controls stay
      await load({ stored: { mode: 'separate' } });
      expect(has('preset-karaoke')).toBe(false);
      el('compact-toggle').click();
      await settle();
      expect(has('preset-karaoke')).toBe(true);
    });

    it('is not offered when the page has no All Mixer!', async () => {
      await load({ status: 'reject' });
      expect(has('compact-toggle')).toBe(false);
    });
  });

  it('Global Volume is on the Separate tab too', async () => {
    await load({ stored: { mode: 'separate', masterPct: 400 } });
    el('master-reset').click();
    await settle();
    expect(sent().at(-1).settings).toMatchObject({ mode: 'separate', masterPct: 100 });
  });

  it('has no separation-quality selector, only the ML model dropdown', async () => {
    await load({ stored: { mode: 'separate', separationQuality: 'light' } });
    expect(has('separation-quality')).toBe(false);
    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(document.querySelectorAll('[role=combobox]')).toHaveLength(2); // model and GPU
  });

  describe('model dropdown', () => {
    const trigger = () => el('ml-model');
    const values = () => [...document.querySelectorAll<HTMLElement>('#ml-model-list [role=option]')].map((o) => o.dataset.value);
    const key = (k: string) => trigger().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

    it('shows the stored model and sends a change', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'roformer' } });
      expect(trigger().textContent).toMatch(/High quality/);
      expect(values()).toEqual(['mdx', 'roformer', 'deux', 'sw']);
      expect(el('ml-model-option-roformer').getAttribute('aria-selected')).toBe('true');
      choose('ml-model', 'mdx');
      await settle();
      expect(sent().at(-1).settings.mlModel).toBe('mdx');
      expect(trigger().textContent).toMatch(/Default/);
      expect(trigger().getAttribute('aria-expanded')).toBe('false');
    });

    it('opens on click and closes on Escape, an outside press, or choosing the same model', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(trigger().getAttribute('aria-expanded')).toBe('false');
      trigger().click();
      await settle();
      expect(trigger().getAttribute('aria-expanded')).toBe('true');
      key('Escape');
      await settle();
      expect(trigger().getAttribute('aria-expanded')).toBe('false');
      trigger().click();
      await settle();
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await settle();
      expect(trigger().getAttribute('aria-expanded')).toBe('false');
      const before = sent().length;
      choose('ml-model', 'mdx'); // already the model: no message
      await settle();
      expect(sent()).toHaveLength(before);
      expect(trigger().getAttribute('aria-expanded')).toBe('false');
    });

    it('works from the keyboard: arrows move, Enter picks', async () => {
      await load({ stored: { mode: 'separate' } });
      key('ArrowDown'); // opens on the current model (Default)
      await settle();
      key('ArrowDown');
      await settle();
      expect(trigger().getAttribute('aria-activedescendant')).toBe('ml-model-option-roformer');
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      await settle();
      expect(sent().at(-1).settings.mlModel).toBe('roformer');
    });
  });
  describe('advanced section', () => {
    const adv = () => el('advanced');
    it('holds the model and delay controls and is closed by default', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(isOpen('advanced')).toBe(false);
      for (const id of ['ml-model', 'ml-gpu', 'chunk-row', 'ml-delay']) expect(adv().contains(el(id))).toBe(true);
      expect(adv().contains(el('vocal'))).toBe(false);
    });
    it('opens by itself when a non-default model is in use', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'deux' } });
      expect(isOpen('advanced')).toBe(true);
    });
    it('remembers being opened', async () => {
      await load({ stored: { mode: 'separate' } });
      el('advanced-toggle').click();
      await settle();
      await load({ stored: { mode: 'separate' } });
      expect(isOpen('advanced')).toBe(true);
    });
  });

  describe('chunk length', () => {
    it('is shown for every model, as a 2 to 15 s slider in 1 s steps starting at 2 s', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'mdx' } });
      expect(has('chunk-row')).toBe(true);
      choose('ml-model', 'roformer');
      await settle();
      expect(has('chunk-row')).toBe(true);
      const slider = el<HTMLInputElement>('ml-delay');
      expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['2', '15', '1', '2']);
      expect(slider.disabled).toBe(false);
      expect(el<HTMLOutputElement>('ml-delay-value').value).toBe('2 s');
      expect(has('ml-auto')).toBe(false);
    });

    it('dragging only moves the label; Apply sends the delay limit once', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'roformer', mlDelayS: 4 } });
      const before = sent().length;
      input('ml-delay', '9');
      await settle();
      expect(el<HTMLOutputElement>('ml-delay-value').value).toBe('9 s');
      expect(sent()).toHaveLength(before);
      expect(el<HTMLButtonElement>('ml-delay-apply').disabled).toBe(false);
      el('ml-delay-apply').click();
      await settle();
      expect(sent().at(-1).settings.mlDelayS).toBe(9);
      expect(el<HTMLButtonElement>('ml-delay-apply').disabled).toBe(true);
      expect(sent()).toHaveLength(before + 1);
    });
  });

  describe('model download', () => {
    const files = { 'roformer.onnx': 100 * 2 ** 20, 'roformer-meta.json': 1000 };
    const dfiles = { 'deux.onnx': 50 * 2 ** 20, 'deux-meta.json': 1000 };
    const remote = (version: number, f: Record<string, number> = files) => ({ format: MODEL_FORMAT, version, files: f, checkedAt: 0 });
    const installedV1 = { format: MODEL_FORMAT, version: 1, files };

    it('is hidden for the default model and shown for a downloadable one', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'mdx' } });
      expect(has('model-row')).toBe(false);
      choose('ml-model', 'roformer');
      await settle();
      expect(has('model-row')).toBe(true);
    });

    it('offers a download when the model is missing and asks the background to install that model', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'roformer' }, local: { 'modelRemote.roformer': remote(1) } });
      expect(el('model-text').textContent).toMatch(/High quality is a one-time download \(100 MB\)/);
      el<HTMLButtonElement>('model-btn').click();
      expect(sendMessage).toHaveBeenCalledWith({ type: 'model-install', id: 'roformer' });
    });

    it('shows the state of the selected model (Best Vocal = deux)', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'deux' }, local: { 'modelInstalled.roformer': installedV1, 'modelRemote.deux': remote(1, dfiles) } });
      expect(el('model-text').textContent).toMatch(/Best Vocal is a one-time download \(50 MB\)/);
      el<HTMLButtonElement>('model-btn').click();
      expect(sendMessage).toHaveBeenCalledWith({ type: 'model-install', id: 'deux' });
    });

    it('asks the background to look for newer models when the popup opens', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(sendMessage).toHaveBeenCalledWith({ type: 'model-check' });
    });

    it('shows download progress without a button', async () => {
      await load({
        stored: { mode: 'separate', mlModel: 'roformer' },
        local: { 'modelRemote.roformer': remote(1), 'modelProgress.roformer': { phase: 'downloading', version: 1, done: 50 * 2 ** 20, total: 100 * 2 ** 20, at: Date.now() } },
      });
      expect(el('model-text').textContent).toMatch(/Downloading… 50% \(50 MB of 100 MB\)/);
      expect(has('model-btn')).toBe(false);
      const bar = el('model-row').querySelector('[role=progressbar]')!;
      expect(bar.getAttribute('aria-valuenow')).toBe('50');
    });

    it('shows no progress bar when nothing is downloading', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'roformer' }, local: { 'modelRemote.roformer': remote(1) } });
      expect(el('model-row').querySelector('[role=progressbar]')).toBeNull();
    });

    it('shows an update button even when the default model is selected', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'mdx' }, local: { 'modelInstalled.roformer': installedV1, 'modelRemote.roformer': remote(2) } });
      expect(has('model-row')).toBe(true);
      expect(el('model-text').textContent).toMatch(/Update available: High quality model v2/);
      expect(el('model-btn').textContent).toBe('Update');
    });

    it('says installed when up to date', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'roformer' }, local: { 'modelInstalled.roformer': installedV1, 'modelRemote.roformer': remote(1) } });
      expect(el('model-text').textContent).toBe('High quality model v1 installed.');
      expect(has('model-btn')).toBe(false);
    });
  });

  describe('split instrumental', () => {
    const dfiles = { 'drums.onnx': 41 * 2 ** 20 };
    const dremote = { format: MODEL_FORMAT, version: 1, files: dfiles, checkedAt: 0 };
    const sepSplit = (extra: Record<string, unknown> = {}) => ({ mode: 'separate', splitInstrumental: true, ...extra });

    it('is off by default: the Drums and Others sliders are hidden and the drum model row too', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(el<HTMLInputElement>('split-on').checked).toBe(false);
      expect(has('split-mix')).toBe(false);
      expect(has('drums-row')).toBe(false);
      expect(isOpen('split')).toBe(false);
    });

    it('opens by itself when the split is on, and shows the Drums and Others sliders with their values', async () => {
      await load({ stored: sepSplit({ drumsPct: 60, othersPct: 40 }) });
      expect(isOpen('advanced')).toBe(true);
      expect(isOpen('split')).toBe(true);
      expect(el<HTMLInputElement>('split-on').checked).toBe(true);
      expect(has('split-mix')).toBe(true);
      expect(el<HTMLInputElement>('drums').value).toBe('60');
      expect(el<HTMLOutputElement>('drums-value').value).toBe('60%');
      expect(el<HTMLInputElement>('others').value).toBe('40');
    });

    it('the switch sends the setting and leaves the delay limit alone', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'roformer', mlDelayS: 3 } });
      el('split-on').click();
      await settle();
      expect(sent().at(-1).settings).toMatchObject({ splitInstrumental: true, mlDelayS: 3 });
      expect(has('split-mix')).toBe(true);
      el('split-on').click();
      await settle();
      expect(sent().at(-1).settings.splitInstrumental).toBe(false);
    });

    it('the Drums and Others sliders send their gains', async () => {
      await load({ stored: sepSplit() });
      for (const [id, key, v] of [['drums', 'drumsPct', '40'], ['others', 'othersPct', '30']] as const) {
        input(id, v);
        await settle();
        expect(sent().at(-1).settings[key]).toBe(Number(v));
      }
    });

    it('offers the drum model download while the split is on, and asks the background for it', async () => {
      await load({ stored: sepSplit(), local: { 'modelRemote.drums': dremote } });
      expect(has('drums-row')).toBe(true);
      expect(el('drums-text').textContent).toMatch(/Drum split is a one-time download \(41 MB\)/);
      el<HTMLButtonElement>('drums-btn').click();
      expect(sendMessage).toHaveBeenCalledWith({ type: 'model-install', id: 'drums' });
      expect(has('model-row')).toBe(false); // the Model row is for the Model menu
    });

    it('says installed, and stays hidden with the split off unless an update is on offer', async () => {
      const inst = { format: MODEL_FORMAT, version: 1, files: dfiles };
      await load({ stored: sepSplit(), local: { 'modelInstalled.drums': inst, 'modelRemote.drums': dremote } });
      expect(el('drums-text').textContent).toBe('Drum split model v1 installed.');
      expect(has('drums-btn')).toBe(false);
      await load({ stored: { mode: 'separate' }, local: { 'modelInstalled.drums': inst, 'modelRemote.drums': dremote } });
      expect(has('drums-row')).toBe(false);
      await load({ stored: { mode: 'separate' }, local: { 'modelInstalled.drums': inst, 'modelRemote.drums': { ...dremote, version: 2 } } });
      expect(has('drums-row')).toBe(true);
      expect(el('drums-btn').textContent).toBe('Update');
    });

    it('the Guitar switch has its own slider, model row and download; Drums and Guitar can be on together', async () => {
      const gremote = { format: MODEL_FORMAT, version: 1, files: { 'guitar.onnx': 45 * 2 ** 20, 'guitar-meta.json': 19000 }, checkedAt: 0 };
      await load({ stored: { mode: 'separate' }, local: { 'modelRemote.guitar': gremote } });
      expect(el<HTMLInputElement>('split-guitar').checked).toBe(false);
      expect(has('guitar-row')).toBe(false);
      expect(has('split-mix')).toBe(false);
      el('split-guitar').click();
      await settle();
      expect(sent().at(-1).settings).toMatchObject({ splitGuitar: true, splitInstrumental: false });
      expect(has('split-mix')).toBe(true);
      expect(el('guitar-text').textContent).toMatch(/Guitar split is a one-time download \(45 MB\)/);
      expect(has('drums-row')).toBe(false);
      el<HTMLButtonElement>('guitar-btn').click();
      expect(sendMessage).toHaveBeenCalledWith({ type: 'model-install', id: 'guitar' });
      expect(has('model-row')).toBe(false); // not a Model menu entry
      await load({ stored: sepSplit({ splitGuitar: true, drumsPct: 60, guitarPct: 20 }), local: { 'modelRemote.guitar': gremote, 'modelRemote.drums': dremote } });
      expect(isOpen('split')).toBe(true);
      expect(has('drums-row') && has('guitar-row')).toBe(true);
      expect(el<HTMLInputElement>('drums').value).toBe('60');
      expect(el<HTMLInputElement>('guitar').value).toBe('20');
    });

    it('the Guitar slider sends its gain, and the guitar switch alone opens the split section', async () => {
      await load({ stored: { mode: 'separate', splitGuitar: true } });
      expect(isOpen('split')).toBe(true);
      input('guitar', '35');
      await settle();
      expect(sent().at(-1).settings.guitarPct).toBe(35);
    });

    describe('Focus Instrumental Splitting (all stems)', () => {
      const swFiles = { 'sw.onnx': 343 * 2 ** 20, 'sw-meta.json': 13000 };
      const sw = (extra: Record<string, unknown> = {}) => ({ mode: 'separate', mlModel: 'sw', ...extra });

      it('is the fourth Model entry and has its own download row', async () => {
        await load({ stored: sw(), local: { 'modelRemote.sw': { format: MODEL_FORMAT, version: 1, files: swFiles, checkedAt: 0 } } });
        expect(el('ml-model').textContent).toMatch(/Focus Instrumental Splitting/);
        expect(el('model-text').textContent).toMatch(/Focus Instrumental Splitting is a one-time download \(343 MB\)/);
        el<HTMLButtonElement>('model-btn').click();
        expect(sendMessage).toHaveBeenCalledWith({ type: 'model-install', id: 'sw' });
      });

      it('shows a slider for the drums, guitar, bass, piano and others, and each sends its gain', async () => {
        await load({ stored: sw({ bassPct: 20, pianoPct: 30 }) });
        expect(has('split-mix')).toBe(true);
        expect(el<HTMLInputElement>('bass').value).toBe('20');
        expect(el<HTMLInputElement>('piano').value).toBe('30');
        for (const [id, key, v] of [['drums', 'drumsPct', '40'], ['guitar', 'guitarPct', '50'], ['bass', 'bassPct', '60'], ['piano', 'pianoPct', '70'], ['others', 'othersPct', '80']] as const) {
          input(id, v);
          await settle();
          expect(sent().at(-1).settings[key]).toBe(Number(v));
        }
      });

      it('the Drums and Guitar switches are not available: the Split section says why instead', async () => {
        await load({ stored: sw({ splitInstrumental: true, splitGuitar: true }), local: { 'modelRemote.drums': dremote } });
        expect(has('split-on')).toBe(false);
        expect(has('split-guitar')).toBe(false);
        expect(has('drums-row')).toBe(false);
        expect(el('split-all').textContent).toMatch(/already splits the drums, guitar, bass and piano/);
      });

      it('the bass and piano sliders are only there with this model', async () => {
        await load({ stored: { mode: 'separate', splitInstrumental: true, splitGuitar: true } });
        expect(has('bass')).toBe(false);
        expect(has('piano')).toBe(false);
      });

      it('Reset puts the bass and piano back to 100% too', async () => {
        await load({ stored: sw({ bassPct: 10, pianoPct: 20, drumsPct: 30 }) });
        el('preset-reset').click();
        await settle();
        expect(sent().at(-1).settings).toMatchObject({ bassPct: 100, pianoPct: 100, drumsPct: 100, guitarPct: 100, othersPct: 100 });
      });
    });

    it('there is no stem dropdown and no guitar note', async () => {
      await load({ stored: sepSplit({ splitGuitar: true }) });
      expect(has('split-model')).toBe(false);
      expect(has('guitar-note')).toBe(false);
    });
  });

  it('shows the waiting-for-gesture hint', async () => {
    await load({ status: { ...okStatus, audio: 'waiting-for-gesture' } });
    expect(el('status').textContent).toMatch(/Click anywhere/);
  });

  it('shows audio errors', async () => {
    await load({ status: { ...okStatus, audio: 'error', error: 'boom' } });
    expect(el('status').textContent).toBe('Audio error: boom');
  });

  it('asks for a reload when there is no content script, and offers no Separate mode', async () => {
    await load({ status: 'reject' });
    expect(el('status').textContent).toMatch(/Reload this tab/);
    expect(has('separate-mode')).toBe(false);
    expect(has('tab-separate')).toBe(false);
  });

  describe('pitch', () => {
    const value = (id: string) => el<HTMLOutputElement>(`${id}-value`).textContent;

    it('the Default tab steps the global pitch with − and +, within ±6', async () => {
      await load();
      expect(value('pitch')).toBe('0');
      el('pitch-up').click();
      await settle();
      expect(sent().at(-1).settings.pitch).toBe(1);
      expect(value('pitch')).toBe('+1');
      el('pitch-down').click();
      await settle();
      el('pitch-down').click();
      await settle();
      expect(sent().at(-1).settings.pitch).toBe(-1);
      expect(value('pitch')).toBe('−1');
      await load({ stored: { pitch: 6 } });
      expect(el<HTMLButtonElement>('pitch-up').disabled).toBe(true);
    });

    it('the Separate tab has the global pitch in the Global volume box and no stem steppers until "Change pitch separately"', async () => {
      await load({ stored: { mode: 'separate', pitch: 2 } });
      expect(el('pitch-label').closest('.mx-row')).toBe(el('master').closest('.mx-row'));
      expect(has('vocal-pitch-up')).toBe(false);
      expect(el<HTMLInputElement>('pitch-split').checked).toBe(false);
    });

    it('"Change pitch separately" starts both stems at the global pitch and moves the steppers into the stem rows', async () => {
      await load({ stored: { mode: 'separate', pitch: 2 } });
      el('pitch-split').click();
      await settle();
      expect(sent().at(-1).settings).toMatchObject({ pitchSplit: true, vocalPitch: 2, instrPitch: 2 });
      expect(el('vocal-pitch-up').closest('.mx-row')).toBe(el('vocal').closest('.mx-row'));
      expect(el<HTMLButtonElement>('pitch-up').disabled).toBe(true);
      el('vocal-pitch-down').click();
      el('instrumental-pitch-up').click();
      await settle();
      expect(sent().at(-1).settings).toMatchObject({ pitch: 2, vocalPitch: 1, instrPitch: 3 });
      expect(value('vocal-pitch')).toBe('+1');
      el('pitch-split').click();
      await settle();
      expect(sent().at(-1).settings.pitchSplit).toBe(false);
      expect(has('vocal-pitch-up')).toBe(false);
    });
  });

  describe('Separate tab', () => {
    const sep = (state: 'loading' | 'on' | 'error', extra: object = {}, engine = 'ml', processingMs = 120.2) =>
      ({ ...okStatus, separation: { state, latency: { engine, processingMs }, ...extra } }) as unknown as ContentStatus;
    const drag = async (id: string, v: string) => {
      input(id, v);
      await settle();
    };
    const pressed = () =>
      [...document.querySelectorAll('.presets button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.id);
    const kind = () => banner()?.dataset.kind;
    const live = (ms: number) => sep('on', { choice: { state: 'on' } }, 'ml', ms);

    it('sliders are enabled and send vocalPct / instrumentalPct', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(el<HTMLInputElement>('vocal').disabled).toBe(false);
      await drag('vocal', '25');
      expect(sent().at(-1).settings.vocalPct).toBe(25);
      expect(el<HTMLOutputElement>('vocal-value').value).toBe('25%');
      await drag('instrumental', '9999');
      expect(sent().at(-1).settings).toMatchObject({ vocalPct: 25, instrumentalPct: 100 });
    });

    it.each([
      ['preset-karaoke', 0, 100],
      ['preset-half-karaoke', 50, 100],
      ['preset-acappella', 100, 0],
      ['preset-reset', 100, 100],
    ])('%s sets %i / %i and is aria-pressed', async (id, v, i) => {
      await load({ stored: { mode: 'separate', vocalPct: 70, instrumentalPct: 70 } });
      expect(pressed()).toEqual([]);
      el(id).click();
      await settle();
      expect(sent().at(-1).settings).toMatchObject({ vocalPct: v, instrumentalPct: i });
      expect(pressed()).toEqual([id]);
    });

    it('the Reset preset also puts Drums and Others back to 100%', async () => {
      await load({ stored: { mode: 'separate', splitInstrumental: true, drumsPct: 40, othersPct: 30, masterPct: 300 } });
      el('preset-reset').click();
      await settle();
      expect(sent().at(-1).settings).toMatchObject({ drumsPct: 100, othersPct: 100, masterPct: 300 });
      el('preset-karaoke').click();
      await settle();
      expect(sent().at(-1).settings).toMatchObject({ vocalPct: 0, drumsPct: 100 });
    });

    describe('undo after a preset', () => {
      it('offers Undo that restores the levels the preset replaced', async () => {
        await load({ stored: { mode: 'separate', vocalPct: 70, instrumentalPct: 40, drumsPct: 100, othersPct: 100 } });
        expect(has('preset-undo')).toBe(false);
        el('preset-karaoke').click();
        await settle();
        expect(sent().at(-1).settings).toMatchObject({ vocalPct: 0, instrumentalPct: 100 });
        el('preset-undo').click();
        await settle();
        expect(sent().at(-1).settings).toMatchObject({ vocalPct: 70, instrumentalPct: 40 });
        expect(has('preset-undo')).toBe(false);
      });

      it('is not offered when the preset changes nothing, and goes away when a slider moves', async () => {
        await load({ stored: { mode: 'separate' } }); // already 100 / 100
        el('preset-reset').click();
        await settle();
        expect(has('preset-undo')).toBe(false);
        el('preset-karaoke').click();
        await settle();
        expect(has('preset-undo')).toBe(true);
        input('vocal', '40');
        await settle();
        expect(has('preset-undo')).toBe(false);
      });
    });

    describe('tips', () => {
      const tip = () => document.querySelector('[role=tooltip]');
      it('shows what a preset does on keyboard focus and hides it on blur', async () => {
        await load({ stored: { mode: 'separate' } });
        expect(tip()).toBeNull();
        el('preset-karaoke').dispatchEvent(new Event('focusin', { bubbles: true }));
        await settle();
        expect(tip()!.textContent).toBe('Vocal 0%, instrumental 100%');
        el('preset-karaoke').dispatchEvent(new Event('focusout', { bubbles: true }));
        await settle();
        expect(tip()).toBeNull();
      });

      it('shows after a short hover and goes away on a press', async () => {
        await load({ stored: { mode: 'separate' } });
        el('preset-acappella').dispatchEvent(new Event('pointerover', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 650));
        expect(tip()!.textContent).toBe('Vocal 100%, instrumental 0%');
        el('preset-acappella').dispatchEvent(new Event('pointerdown', { bubbles: true }));
        await settle();
        expect(tip()).toBeNull();
      });
    });

    it('moving a slider clears the preset highlight', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(pressed()).toEqual(['preset-reset']);
      await drag('vocal', '55');
      expect(pressed()).toEqual([]);
    });

    it('loading shows the warming banner', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('loading') });
      expect(kind()).toBe('warming');
      expect(banner()!.textContent).toMatch(/Warming up/);
    });

    it('polls while loading and shows the delay once ML is on', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('loading') });
      expect(kind()).toBe('warming');
      (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(live(120.2));
      await new Promise((r) => setTimeout(r, 600));
      expect(kind()).toBe('live');
      expect(banner()!.textContent).toMatch(/0\.1 s audio delay/);
    });

    it('warming up: says the original mix plays, and keeps polling', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('on', { choice: { state: 'warming' } }, 'bypass', 0) });
      expect(banner()!.textContent).toMatch(/original mix keeps playing/);
      (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(live(120.2));
      await new Promise((r) => setTimeout(r, 600));
      expect(kind()).toBe('live');
    });

    it('keeps polling while live, so a later stop shows without reopening the popup', async () => {
      await load({ stored: { mode: 'separate' }, status: live(120.2) });
      expect(kind()).toBe('live');
      (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(sep('on', { choice: { state: 'stopped', cause: 'ML missed its deadline' } }, 'bypass', 0));
      await vi.waitFor(() => expect(kind()).toBe('stopped'), { timeout: 3500 });
    }, 5000);

    it('leaving the Separate tab clears the separation banner', async () => {
      await load({ stored: { mode: 'separate' }, status: live(305) });
      expect(banner()!.textContent).toMatch(/0\.3 s audio delay/);
      tabDefault();
      await settle(); // the status read afterwards still says live: the banner follows the tab
      expect(banner()).toBeNull();
    });

    it('on shows the delay in seconds with one decimal', async () => {
      await load({ stored: { mode: 'separate' }, status: live(303.4) });
      expect(banner()!.textContent).toMatch(/Separating live.*0\.3 s audio delay/);
    });

    it('unavailable shows the cause and that the original plays, with no retry buttons', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('on', { choice: { state: 'unavailable', cause: 'no webgpu' } }, 'bypass', 0) });
      expect(kind()).toBe('unavailable');
      expect(banner()!.textContent).toMatch(/Separation unavailable.*no webgpu\. The original mix is playing\./);
      expect(has('act-retry')).toBe(false);
    });

    describe('stopped (device too slow)', () => {
      const stopped = sep('on', { choice: { state: 'stopped', cause: 'ML missed its deadline' } }, 'bypass', 0);

      it('says the device is too slow and the original plays', async () => {
        await load({ stored: { mode: 'separate' }, status: stopped });
        expect(kind()).toBe('stopped');
        expect(banner()!.textContent).toMatch(/too slow to separate in real time \(ML missed its deadline\)\. The original mix is playing\./);
      });

      it('on the Default model offers a longer delay limit and a retry, not a model switch', async () => {
        await load({ stored: { mode: 'separate', mlDelayS: 2 }, status: stopped });
        expect(has('act-default-model')).toBe(false);
        expect(el('act-raise-delay').textContent).toBe('Raise delay limit to 6 s');
        el('act-raise-delay').click();
        await settle();
        expect(sent().at(-1).settings.mlDelayS).toBe(6);
      });

      it('on another model offers to switch to the Default model', async () => {
        await load({ stored: { mode: 'separate', mlModel: 'deux', mlDelayS: 15 }, status: stopped });
        expect(has('act-raise-delay')).toBe(false); // already at the longest limit
        el('act-default-model').click();
        await settle();
        expect(sent().at(-1).settings.mlModel).toBe('mdx');
      });

      it('offers the high performance GPU unless it is already chosen', async () => {
        await load({ stored: { mode: 'separate' }, status: stopped });
        el('act-fast-gpu').click();
        await settle();
        expect(sent().at(-1).settings.gpu).toBe('high-performance');
        await load({ stored: { mode: 'separate', gpu: 'high-performance' }, status: stopped });
        expect(has('act-fast-gpu')).toBe(false);
      });

      it('Try again turns Separate off and on again', async () => {
        await load({ stored: { mode: 'separate' }, status: stopped });
        el('act-retry').click();
        await settle();
        expect(sent().map((m: { settings: { mode: string } }) => m.settings.mode)).toEqual(['default', 'separate']);
      });
    });

    it('error status', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('error', { error: 'no worklet' }) });
      expect(banner()!.textContent).toMatch(/Separation unavailable.*no worklet\. The original mix is playing\./);
    });

    it('shows nothing without separation info', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(banner()).toBeNull();
      expect(el('status').textContent).toBe('');
    });
  });
});
