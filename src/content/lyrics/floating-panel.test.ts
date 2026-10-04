import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampRect, FloatingPanel } from './floating-panel';

const store = new Map<string, unknown>();

beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (k: string) => (store.has(k) ? { [k]: store.get(k) } : {}),
        set: async (o: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(o)) store.set(k, v);
        },
      },
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
});

const opts = { id: 'am-panel', title: 'Lyrics', storageKey: 'panel', defaultRect: { x: 10, y: 10, w: 300, h: 300 } };

describe('clampRect', () => {
  const vp = { w: 1000, h: 800 };
  const min = { w: 240, h: 160 };
  it('keeps in-bounds rects', () => {
    expect(clampRect({ x: 10, y: 20, w: 300, h: 300 }, vp, min)).toEqual({ x: 10, y: 20, w: 300, h: 300 });
  });
  it('pulls position inside', () => {
    expect(clampRect({ x: -50, y: 900, w: 300, h: 300 }, vp, min)).toEqual({ x: 0, y: 500, w: 300, h: 300 });
    expect(clampRect({ x: 900, y: 0, w: 300, h: 300 }, vp, min)).toEqual({ x: 700, y: 0, w: 300, h: 300 });
  });
  it('enforces min and max size', () => {
    expect(clampRect({ x: 0, y: 0, w: 10, h: 10 }, vp, min)).toMatchObject({ w: 240, h: 160 });
    expect(clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, vp, min)).toMatchObject({ w: 1000, h: 800 });
  });
  it('min wins in a tiny viewport', () => {
    expect(clampRect({ x: 5, y: 5, w: 300, h: 300 }, { w: 100, h: 100 }, min)).toEqual({ x: 0, y: 0, w: 240, h: 160 });
  });
});

describe('FloatingPanel', () => {
  it('starts hidden, shows and hides, with open shadow root', () => {
    const p = new FloatingPanel(opts);
    const host = document.getElementById('am-panel') as HTMLElement;
    expect(host.shadowRoot).not.toBeNull();
    expect(host.style.display).toBe('none');
    expect(p.isOpen).toBe(false);
    p.show();
    expect(p.isOpen).toBe(true);
    expect(host.style.display).toBe('');
    p.toggle();
    expect(host.style.display).toBe('none');
    p.body.appendChild(document.createElement('i'));
    expect(host.shadowRoot!.querySelector('.body i')).not.toBeNull();
    p.destroy();
    expect(document.getElementById('am-panel')).toBeNull();
  });

  it('close button hides and notifies', () => {
    const p = new FloatingPanel(opts);
    const cb = vi.fn();
    p.onClose(cb);
    p.show();
    (document.getElementById('am-panel')!.shadowRoot!.querySelector('.close') as HTMLElement).click();
    expect(p.isOpen).toBe(false);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('persists debounced and restores', async () => {
    const p = new FloatingPanel(opts);
    p.show();
    expect(store.has('panel')).toBe(false);
    vi.advanceTimersByTime(300);
    expect(store.get('panel')).toEqual({ x: 10, y: 10, w: 300, h: 300, open: true });
    p.destroy();

    store.set('panel', { x: 50, y: 60, w: 400, h: 350, open: true });
    const q = new FloatingPanel(opts);
    await vi.advanceTimersByTimeAsync(0);
    expect(q.isOpen).toBe(true);
    const panel = document.getElementById('am-panel')!.shadowRoot!.querySelector('.panel') as HTMLElement;
    expect(panel.style.left).toBe('50px');
    expect(panel.style.width).toBe('400px');
  });

  it('re-parents into the fullscreen element and back', () => {
    const p = new FloatingPanel(opts);
    const host = document.getElementById('am-panel')!;
    expect(host.parentElement).toBe(document.body);
    const fs = document.createElement('div');
    document.body.appendChild(fs);
    Object.defineProperty(document, 'fullscreenElement', { value: fs, configurable: true });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(host.parentElement).toBe(fs);
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(host.parentElement).toBe(document.body);
    p.destroy();
  });
});
