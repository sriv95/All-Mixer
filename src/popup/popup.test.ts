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
const tabBtn = (mode: string) => document.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)!;
const settle = () => new Promise((r) => setTimeout(r, 50));

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
  it('disables everything on a non-YouTube tab', async () => {
    await load({ tab: { id: 1, url: 'https://example.com/' } });
    for (const e of document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) {
      expect(e.disabled).toBe(true);
    }
    expect(el('status').textContent).toMatch(/youtube\.com/);
  });

  it('disables everything when the tab url is hidden', async () => {
    await load({ tab: { id: 1 } });
    expect(el<HTMLInputElement>('master').disabled).toBe(true);
  });

  it('renders stored settings', async () => {
    await load({ stored: { mode: 'separate', masterPct: 250 } });
    expect(el<HTMLInputElement>('master').value).toBe('250');
    expect(el<HTMLOutputElement>('master-value').value).toBe('250%');
    expect(tabBtn('separate').getAttribute('aria-selected')).toBe('true');
    expect(tabBtn('default').getAttribute('aria-selected')).toBe('false');
    expect(el('panel-separate').hidden).toBe(false);
    expect(el('panel-default').hidden).toBe(true);
  });

  it('clicking a tab sends the new mode and shows its panel', async () => {
    await load({ stored: { mode: 'default', masterPct: 100 } });
    tabBtn('separate').click();
    await settle();
    expect(el('panel-separate').hidden).toBe(false);
    expect(el('panel-default').hidden).toBe(true);
    expect(sent().at(-1)).toMatchObject({ tabId: 7, settings: { mode: 'separate' } });
  });

  it('ArrowRight / ArrowLeft switch tabs and wrap', async () => {
    await load({ stored: { mode: 'default' } });
    tabBtn('default').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();
    expect(sent().at(-1).settings.mode).toBe('separate');
    expect(document.activeElement).toBe(tabBtn('separate'));
    tabBtn('separate').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await settle();
    expect(sent().at(-1).settings.mode).toBe('default');
    tabBtn('default').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await settle();
    expect(sent().at(-1).settings.mode).toBe('separate');
  });

  it('ignores other keys', async () => {
    await load();
    tabBtn('default').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await settle();
    expect(sent()).toHaveLength(0);
  });

  it('slider input sends a clamped masterPct', async () => {
    await load();
    const slider = el<HTMLInputElement>('master');
    slider.value = '9999';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(sent().at(-1).settings.masterPct).toBe(600);
    slider.value = '-40';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(sent().at(-1).settings.masterPct).toBe(0);
    expect(el<HTMLOutputElement>('master-value').value).toBe('0%');
  });

  it('Reset sends 100', async () => {
    await load({ stored: { masterPct: 400 } });
    el('master-reset').click();
    await settle();
    expect(sent().at(-1).settings.masterPct).toBe(100);
    expect(el<HTMLOutputElement>('master-value').value).toBe('100%');
  });

  it('has no separation-quality selector, only the ML model one', async () => {
    await load({ stored: { mode: 'separate', separationQuality: 'light' } });
    expect(document.getElementById('separation-quality')).toBeNull();
    expect(document.querySelectorAll('select')).toHaveLength(1);
  });

  it('the model selector shows the stored model and sends a change', async () => {
    await load({ stored: { mode: 'separate', mlModel: 'roformer' } });
    const select = el<HTMLSelectElement>('ml-model');
    expect(select.value).toBe('roformer');
    expect([...select.options].map((o) => o.value)).toEqual(['mdx', 'roformer', 'deux']);
    select.value = 'mdx';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(sent().at(-1).settings.mlModel).toBe('mdx');
  });
  describe('advanced section', () => {
    const adv = () => el<HTMLDetailsElement>('advanced');
    it('holds the model and delay controls and is closed by default', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(adv().open).toBe(false);
      for (const id of ['ml-model', 'model-row', 'chunk-row', 'ml-delay']) expect(adv().contains(el(id))).toBe(true);
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
    const select = (m: string) => {
      const s = el<HTMLSelectElement>('ml-model');
      s.value = m;
      s.dispatchEvent(new Event('change', { bubbles: true }));
    };
    it('is hidden for the default model and shown for a RoFormer, as a 2 to 15 s slider in 1 s steps starting at 2 s', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'mdx' } });
      expect(el('chunk-row').hidden).toBe(true);
      select('roformer');
      await settle();
      expect(el('chunk-row').hidden).toBe(false);
      const slider = el<HTMLInputElement>('ml-delay');
      expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['2', '15', '1', '2']);
      expect(slider.disabled).toBe(false);
      expect(el<HTMLOutputElement>('ml-delay-value').value).toBe('2 s');
      expect(document.getElementById('ml-auto')).toBeNull();
    });

    it('dragging only moves the label; Apply sends the delay limit once', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'roformer', mlDelayS: 4 } });
      const slider = el<HTMLInputElement>('ml-delay');
      const before = sent().length;
      slider.value = '9';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
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
    const row = () => el('model-row');

    it('is hidden for the default model and shown for a downloadable one', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'mdx' } });
      expect(row().hidden).toBe(true);
      const select = el<HTMLSelectElement>('ml-model');
      select.value = 'roformer';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      expect(row().hidden).toBe(false);
    });

    it('offers a download when the model is missing and asks the background to install that model', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'roformer' }, local: { 'modelRemote.roformer': remote(1) } });
      expect(el('model-text').textContent).toMatch(/High quality is a one-time download \(100 MB\)/);
      const btn = el<HTMLButtonElement>('model-btn');
      expect(btn.hidden).toBe(false);
      btn.click();
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
      expect(el<HTMLButtonElement>('model-btn').hidden).toBe(true);
    });

    it('shows an update button even when the default model is selected', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'mdx' }, local: { 'modelInstalled.roformer': installedV1, 'modelRemote.roformer': remote(2) } });
      expect(row().hidden).toBe(false);
      expect(el('model-text').textContent).toMatch(/Update available: High quality model v2/);
      expect(el('model-btn').textContent).toBe('Update');
    });

    it('says installed when up to date', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'roformer' }, local: { 'modelInstalled.roformer': installedV1, 'modelRemote.roformer': remote(1) } });
      expect(el('model-text').textContent).toBe('High quality model v1 installed.');
      expect(el<HTMLButtonElement>('model-btn').hidden).toBe(true);
    });
  });

  describe('split instrumental', () => {
    const dfiles = { 'drums.onnx': 41 * 2 ** 20 };
    const dremote = { format: MODEL_FORMAT, version: 1, files: dfiles, checkedAt: 0 };
    const sepSplit = (extra: Record<string, unknown> = {}) => ({ mode: 'separate', splitInstrumental: true, ...extra });

    it('is off by default: the Drums and Others sliders are hidden and the drum model row too', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(el<HTMLInputElement>('split-on').checked).toBe(false);
      expect(el('split-mix').hidden).toBe(true);
      expect(el('drums-row').hidden).toBe(true);
      expect(el<HTMLDetailsElement>('split').open).toBe(false);
    });

    it('opens by itself when the split is on, and shows the Drums and Others sliders with their values', async () => {
      await load({ stored: sepSplit({ drumsPct: 150, othersPct: 40 }) });
      expect(el<HTMLDetailsElement>('advanced').open).toBe(true);
      expect(el<HTMLDetailsElement>('split').open).toBe(true);
      expect(el<HTMLInputElement>('split-on').checked).toBe(true);
      expect(el('split-mix').hidden).toBe(false);
      expect(el<HTMLInputElement>('drums').value).toBe('150');
      expect(el<HTMLOutputElement>('drums-value').value).toBe('150%');
      expect(el<HTMLInputElement>('others').value).toBe('40');
    });

    it('the checkbox sends the setting; with a RoFormer it also raises the delay limit to 8 s', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'mdx' } });
      const on = el<HTMLInputElement>('split-on');
      on.checked = true;
      on.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      expect(sent().at(-1).settings).toMatchObject({ splitInstrumental: true, mlDelayS: 2 }); // the default model has a fixed delay
      expect(el('split-mix').hidden).toBe(false);
      on.checked = false;
      on.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      expect(sent().at(-1).settings.splitInstrumental).toBe(false);

      await load({ stored: { mode: 'separate', mlModel: 'roformer', mlDelayS: 3 } });
      const on2 = el<HTMLInputElement>('split-on');
      on2.checked = true;
      on2.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      expect(sent().at(-1).settings).toMatchObject({ splitInstrumental: true, mlDelayS: 8 });
      expect(el<HTMLInputElement>('ml-delay').value).toBe('8');
    });

    it('does not shorten a longer delay limit', async () => {
      await load({ stored: { mode: 'separate', mlModel: 'deux', mlDelayS: 12 } });
      const on = el<HTMLInputElement>('split-on');
      on.checked = true;
      on.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      expect(sent().at(-1).settings.mlDelayS).toBe(12);
    });

    it('the Drums and Others sliders send their gains', async () => {
      await load({ stored: sepSplit() });
      for (const [id, key, v] of [['drums', 'drumsPct', '250'], ['others', 'othersPct', '30']] as const) {
        const slider = el<HTMLInputElement>(id);
        slider.value = v;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        expect(sent().at(-1).settings[key]).toBe(Number(v));
      }
    });

    it('offers the drum model download while the split is on, and asks the background for it', async () => {
      await load({ stored: sepSplit(), local: { 'modelRemote.drums': dremote } });
      expect(el('drums-row').hidden).toBe(false);
      expect(el('drums-text').textContent).toMatch(/Drum split is a one-time download \(41 MB\)/);
      el<HTMLButtonElement>('drums-btn').click();
      expect(sendMessage).toHaveBeenCalledWith({ type: 'model-install', id: 'drums' });
      expect(el('model-row').hidden).toBe(true); // the Model row is for the Model menu
    });

    it('says installed, and stays hidden with the split off unless an update is on offer', async () => {
      const inst = { format: MODEL_FORMAT, version: 1, files: dfiles };
      await load({ stored: sepSplit(), local: { 'modelInstalled.drums': inst, 'modelRemote.drums': dremote } });
      expect(el('drums-text').textContent).toBe('Drum split model v1 installed.');
      expect(el<HTMLButtonElement>('drums-btn').hidden).toBe(true);
      await load({ stored: { mode: 'separate' }, local: { 'modelInstalled.drums': inst, 'modelRemote.drums': dremote } });
      expect(el('drums-row').hidden).toBe(true);
      await load({ stored: { mode: 'separate' }, local: { 'modelInstalled.drums': inst, 'modelRemote.drums': { ...dremote, version: 2 } } });
      expect(el('drums-row').hidden).toBe(false);
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

  it('asks for a reload when there is no content script', async () => {
    await load({ status: 'reject' });
    expect(el('status').textContent).toMatch(/Reload this YouTube tab/);
  });

  describe('Separate tab', () => {
    const sep = (state: 'loading' | 'on' | 'error', extra: object = {}, engine = 'ml', processingMs = 120.2) =>
      ({ ...okStatus, separation: { state, latency: { engine, processingMs }, ...extra } }) as unknown as ContentStatus;
    const drag = async (id: string, v: string) => {
      const s = el<HTMLInputElement>(id);
      s.value = v;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    };
    const pressed = () =>
      [...document.querySelectorAll('.presets button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.id);

    it('sliders are enabled and send vocalPct / instrumentalPct', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(el<HTMLInputElement>('vocal').disabled).toBe(false);
      await drag('vocal', '250');
      expect(sent().at(-1).settings.vocalPct).toBe(250);
      expect(el<HTMLOutputElement>('vocal-value').value).toBe('250%');
      await drag('instrumental', '9999');
      expect(sent().at(-1).settings).toMatchObject({ vocalPct: 250, instrumentalPct: 600 });
    });

    it.each([
      ['preset-karaoke', 0, 100],
      ['preset-half-karaoke', 50, 100],
      ['preset-acappella', 100, 0],
      ['preset-reset', 100, 100],
    ])('%s sets %i / %i and is aria-pressed', async (id, v, i) => {
      await load({ stored: { mode: 'separate', vocalPct: 300, instrumentalPct: 300 } });
      expect(pressed()).toEqual([]);
      el(id).click();
      await settle();
      expect(sent().at(-1).settings).toMatchObject({ vocalPct: v, instrumentalPct: i });
      expect(pressed()).toEqual([id]);
    });

    it('moving a slider clears the preset highlight', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(pressed()).toEqual(['preset-reset']);
      await drag('vocal', '55');
      expect(pressed()).toEqual([]);
    });

    it('loading status', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('loading') });
      expect(el('status').textContent).toBe('Starting separation…');
    });

    it('polls while loading and shows the delay once ML is on', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('loading') });
      expect(el('status').textContent).toBe('Starting separation…');
      (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(sep('on', { choice: { state: 'on' } }));
      await new Promise((r) => setTimeout(r, 600));
      expect(el('status').textContent).toBe('Separation on · 120 ms delay');
    });

    it('warming up: says the original mix plays, and keeps polling', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('on', { choice: { state: 'warming' } }, 'bypass', 0) });
      expect(el('status').textContent).toBe('Separation warming up… Playing the original mix.');
      (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(sep('on', { choice: { state: 'on' } }));
      await new Promise((r) => setTimeout(r, 600));
      expect(el('status').textContent).toBe('Separation on · 120 ms delay');
    });

    it('clicking Default clears the separation status at once', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('on', { choice: { state: 'on' } }, 'ml', 305) });
      expect(el('status').textContent).toBe('Separation on · 305 ms delay');
      tabBtn('default').click();
      expect(el('status').textContent).toBe('');
      await settle();
      expect(el('status').textContent).toBe('');
    });

    it('on shows the rounded delay', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('on', { choice: { state: 'on' } }, 'ml', 303.4) });
      expect(el('status').textContent).toBe('Separation on · 303 ms delay');
    });

    it('unavailable shows the cause and that the original plays', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('on', { choice: { state: 'unavailable', cause: 'no webgpu' } }, 'bypass', 0) });
      expect(el('status').textContent).toBe('Separation unavailable: no webgpu. Playing the original mix.');
    });

    it('stopped says the device is too slow and how to retry', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('on', { choice: { state: 'stopped', cause: 'ML missed its deadline' } }, 'bypass', 0) });
      expect(el('status').textContent).toBe(
        'Separation stopped: this device is too slow (ML missed its deadline). Playing the original mix. Switch to Default and back to retry.',
      );
    });

    it('error status', async () => {
      await load({ stored: { mode: 'separate' }, status: sep('error', { error: 'no worklet' }) });
      expect(el('status').textContent).toBe('Separation unavailable: no worklet. Playing the original mix.');
    });

    it('shows nothing without separation info', async () => {
      await load({ stored: { mode: 'separate' } });
      expect(el('status').textContent).toBe('');
    });
  });
});
