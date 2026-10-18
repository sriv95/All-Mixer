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
const tabSeparate = () => el('tab-separate').click();
const tabDefault = () => el('tab-default').click();

/** React tracks the value it last set: write through the prototype setter so the event counts as a user change. */
function setNative(e: HTMLInputElement | HTMLSelectElement, value: string, event: 'input' | 'change'): void {
  const proto = e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(e, value);
  e.dispatchEvent(new Event(event, { bubbles: true }));
}
const input = (id: string, v: string) => setNative(el<HTMLInputElement>(id), v, 'input');
const choose = (id: string, v: string) => setNative(el<HTMLSelectElement>(id), v, 'change');

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
  await import('./popup');
  await settle();
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

  it('Global Volume is on the Separate tab too', async () => {
    await load({ stored: { mode: 'separate', masterPct: 400 } });
    el('master-reset').click();
    await settle();
    expect(sent().at(-1).settings).toMatchObject({ mode: 'separate', masterPct: 100 });
  });

  it('has no separation-quality selector, only the ML model one', async () => {
    await load({ stored: { mode: 'separate', separationQuality: 'light' } });
    expect(has('separation-quality')).toBe(false);
    expect(document.querySelectorAll('select')).toHaveLength(1);
  });

  it('the model selector shows the stored model and sends a change', async () => {
    await load({ stored: { mode: 'separate', mlModel: 'roformer' } });
    const select = el<HTMLSelectElement>('ml-model');
    expect(select.value).toBe('roformer');
    expect([...select.options].map((o) => o.value)).toEqual(['mdx', 'roformer', 'deux']);
    choose('ml-model', 'mdx');
    await settle();
    expect(sent().at(-1).settings.mlModel).toBe('mdx');
  });
  describe('advanced section', () => {
    const adv = () => el<HTMLDetailsElement>('advanced');
    it('holds the model and delay controls and is closed by default', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(adv().open).toBe(false);
      for (const id of ['ml-model', 'chunk-row', 'ml-delay']) expect(adv().contains(el(id))).toBe(true);
      expect(adv().contains(el('vocal'))).toBe(false);
    });
    it('opens by itself when a non-default model is in use', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'deux' } });
      expect(adv().open).toBe(true);
    });
    it('remembers being opened', async () => {
      await load({ stored: { mode: 'separate' } });
      adv().open = true;
      adv().dispatchEvent(new Event('toggle'));
      await load({ stored: { mode: 'separate' } });
      expect(adv().open).toBe(true);
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

    it('shows the state of the selected model (Best quality = deux)', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'deux' }, local: { 'modelInstalled.roformer': installedV1, 'modelRemote.deux': remote(1, dfiles) } });
      expect(el('model-text').textContent).toMatch(/Best quality is a one-time download \(50 MB\)/);
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
      expect(el<HTMLDetailsElement>('split').open).toBe(false);
    });

    it('opens by itself when the split is on, and shows the Drums and Others sliders with their values', async () => {
      await load({ stored: sepSplit({ drumsPct: 60, othersPct: 40 }) });
      expect(el<HTMLDetailsElement>('advanced').open).toBe(true);
      expect(el<HTMLDetailsElement>('split').open).toBe(true);
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
