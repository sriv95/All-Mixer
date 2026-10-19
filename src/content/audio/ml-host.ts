import { ML_INIT, ML_PAGE_PATH, type FromMlWorker, type GpuPreference, type MlModel, type SplitModel, type ToMlWorker } from '../../worklet/protocol';

/**
 * Owns the hidden extension iframe (ml/ml.html) that hosts the ML worker, and the channel to it.
 * `start()` creates the iframe, makes a MessageChannel, sends one port to the iframe (→ worker) and
 * returns the other for the worklet (MasterChain.setMlPort). Status comes back as ready/unavailable.
 * `dispose()` removes the iframe, which ends the worker and frees the GPU session.
 */
export class MlHost {
  private frame: HTMLIFrameElement | null = null;
  private onMessage: ((e: MessageEvent) => void) | null = null;

  private readonly origin: string;

  constructor(
    private readonly pageUrl: string = chrome.runtime.getURL(ML_PAGE_PATH),
    private readonly doc: Document = document,
    private readonly model: MlModel = 'mdx',
    private readonly delayMs: number | null = null,
    private readonly drums: boolean = false,
    private readonly gpu: GpuPreference = 'auto',
    private readonly split: SplitModel = 'drums',
  ) {
    this.origin = /^[a-z-]+:\/\/[^/]+/.exec(pageUrl)?.[0] ?? '';
  }

  get running(): boolean {
    return this.frame !== null;
  }

  /** @returns the port for the worklet, or null if already started. `onStatus` gets ready / unavailable. */
  start(onStatus: (m: FromMlWorker) => void): MessagePort | null {
    if (this.frame) return null;
    const origin = this.origin;
    const channel = new MessageChannel();
    const frame = this.doc.createElement('iframe');
    frame.src = this.pageUrl;
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'display:none;position:fixed;width:0;height:0;border:0';
    this.frame = frame;
    this.onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.origin !== origin) return;
      const m = e.data as FromMlWorker | null;
      if (m?.type === 'ready' || m?.type === 'unavailable') onStatus(m);
    };
    window.addEventListener('message', this.onMessage);
    frame.addEventListener('load', () => {
      if (this.frame !== frame) return;
      frame.contentWindow?.postMessage({ type: ML_INIT, model: this.model, delayMs: this.delayMs, drums: this.drums, split: this.split, gpu: this.gpu }, origin, [channel.port2]);
    });
    (this.doc.body ?? this.doc.documentElement).appendChild(frame);
    return channel.port1;
  }

  dispose(): void {
    if (!this.frame) return;
    this.frame.contentWindow?.postMessage({ type: 'dispose' } satisfies ToMlWorker, this.origin);
    this.frame.remove();
    this.frame = null;
    if (this.onMessage) window.removeEventListener('message', this.onMessage);
    this.onMessage = null;
  }
}
