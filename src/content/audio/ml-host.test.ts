// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ML_INIT } from '../../worklet/protocol';
import { MlHost } from './ml-host';

const URL_ = 'https://ext.test/ml/ml.html';

describe('MlHost', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('creates a hidden iframe, hands back one port, and disposes it', () => {
    const host = new MlHost(URL_);
    const port = host.start(() => {});
    expect(typeof port?.postMessage).toBe('function');
    const f = document.querySelector('iframe')!;
    expect(f.src).toBe(URL_);
    expect(f.hidden).toBe(true);
    expect(host.start(() => {})).toBeNull(); // already running
    host.dispose();
    expect(document.querySelector('iframe')).toBeNull();
    expect(host.running).toBe(false);
  });

  it('tells the iframe to run the drum stage when asked', () => {
    const host = new MlHost(URL_, document, 'roformer', 6000, true);
    host.start(() => {});
    const f = document.querySelector('iframe')!;
    const post = vi.spyOn(f.contentWindow!, 'postMessage').mockImplementation(() => {});
    f.dispatchEvent(new Event('load'));
    expect(post.mock.calls[0][0]).toEqual({ type: ML_INIT, model: 'roformer', delayMs: 6000, drums: true, guitar: false, gpu: 'auto', offline: false });
    host.dispose();
  });

  it('tells the worker it runs for an export (no real-time gate) when asked', () => {
    const host = new MlHost(URL_, document, 'sw', 8000, false, 'auto', false, true);
    host.start(() => {});
    const f = document.querySelector('iframe')!;
    const post = vi.spyOn(f.contentWindow!, 'postMessage').mockImplementation(() => {});
    f.dispatchEvent(new Event('load'));
    expect(post.mock.calls[0][0]).toMatchObject({ model: 'sw', offline: true });
    host.dispose();
  });

  it('sends ML_INIT with the other port on load and reports worker status only from the iframe', () => {
    const host = new MlHost(URL_);
    const status = vi.fn();
    host.start(status);
    const f = document.querySelector('iframe')!;
    const win = f.contentWindow!;
    const post = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
    f.dispatchEvent(new Event('load'));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toEqual({ type: ML_INIT, model: 'mdx', delayMs: null, drums: false, guitar: false, gpu: 'auto', offline: false });
    expect(post.mock.calls[0][1]).toBe('https://ext.test');
    const ready = { type: 'ready', p50: 1, p90: 2, p95: 2, createMs: 3, adapter: 'x' };
    window.dispatchEvent(new MessageEvent('message', { data: ready, origin: 'https://ext.test', source: win }));
    expect(status).toHaveBeenCalledWith(ready);
    window.dispatchEvent(new MessageEvent('message', { data: ready, origin: 'https://evil.example', source: win }));
    window.dispatchEvent(new MessageEvent('message', { data: ready, origin: 'https://ext.test', source: window }));
    expect(status).toHaveBeenCalledTimes(1);
    host.dispose();
  });
});
