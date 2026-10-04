import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentStatus } from '../shared/messages';

const html = readFileSync('src/popup/popup.html', 'utf8');
const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');

const YT = { id: 7, url: 'https://www.youtube.com/watch?v=abcdefghijk' };
const okStatus: ContentStatus = { site: 'youtube', videoFound: true, audio: 'active', gain: 1 };

interface Opts {
  tab?: { id?: number; url?: string };
  stored?: unknown;
  status?: ContentStatus | 'reject';
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
  });
  await import('./popup');
  await settle();
}

const sent = () =>
  sendMessage.mock.calls.map((c) => c[0]).filter((m: { type: string }) => m.type === 'set-tab-settings');

beforeEach(() => vi.useRealTimers());
afterEach(() => {
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
});
