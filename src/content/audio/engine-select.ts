import {
  ML_WARMUP_P95_MS,
  type FromMlWorker,
  type MlEngine,
  type MlReason,
} from '../../worklet/protocol';
import type { SeparationQuality } from '../../shared/settings';
import type { LatencyListener } from './latency';
import { MlHost } from './ml-host';

/** What the selector needs from MasterChain. */
export interface EngineChain {
  setMlPort(port: MessagePort): void;
  /** @returns false when ML cannot run on this graph (e.g. context not at the model rate). */
  setEngine(engine: MlEngine, reason: MlReason): boolean;
  /** False when ML can never run on this graph; checked before any host is created. */
  canRunMl(): boolean;
  onLatencyChange(cb: LatencyListener): () => void;
}

export interface MlHostLike {
  start(onStatus: (m: FromMlWorker) => void): MessagePort | null;
  dispose(): void;
}

export interface EngineChoice {
  engine: MlEngine;
  reason: MlReason;
  /** Short text for the UI, e.g. why ML is not running. */
  cause?: string;
}

export interface SelectorRequest {
  on: boolean;
  quality: SeparationQuality;
}

/**
 * Auto / Light / Quality engine choice (SRI-5 §4). The DSP engine always starts at once; this
 * decides whether to also probe the ML engine, and switches to it only after a fast warm-up.
 * A runtime deadline-miss pins DSP until Separate mode is toggled or the setting changes.
 */
export class EngineSelector {
  private host: MlHostLike | null = null;
  private probing = false;
  private mlActive = false;
  private on = false;
  private quality: SeparationQuality | null = null;
  private fallback: Pick<EngineChoice, 'reason' | 'cause'> = { reason: 'auto' };

  constructor(
    private readonly chain: EngineChain,
    private readonly createHost: () => MlHostLike = () => new MlHost(),
  ) {
    chain.onLatencyChange((info) => {
      if (this.mlActive && info.engine === 'dsp' && info.reason === 'deadline-miss') {
        this.mlActive = false;
        this.disposeHost();
        this.fallback = { reason: 'deadline-miss', cause: 'ML missed its deadline' };
      }
    });
  }

  get status(): EngineChoice {
    return this.mlActive ? { engine: 'ml', reason: 'auto' } : { engine: 'dsp', ...this.fallback };
  }

  update(req: SelectorRequest): void {
    const turnedOn = req.on && !this.on;
    const changed = req.quality !== this.quality;
    this.on = req.on;
    this.quality = req.quality;
    if (!req.on) {
      if (this.mlActive) this.chain.setEngine('dsp', 'user');
      this.disposeHost();
      this.mlActive = false;
      this.fallback = { reason: 'auto' };
      return;
    }
    if (!turnedOn && !changed) return;
    if (req.quality === 'light') {
      this.disposeHost();
      if (this.mlActive) this.chain.setEngine('dsp', 'user');
      this.mlActive = false;
      this.fallback = { reason: 'user' };
      return;
    }
    if (this.mlActive || this.probing) return;
    this.probe();
  }

  private probe(): void {
    if (!this.chain.canRunMl()) return this.giveUp('ML needs a 44.1 kHz audio context');
    const host = this.createHost();
    this.host = host;
    this.probing = true;
    this.fallback = { reason: 'auto', cause: 'ML warming up' };
    const port = host.start((m) => {
      if (this.host !== host || !this.probing) return;
      this.probing = false;
      if (m.type === 'unavailable') return this.giveUp(`ML unavailable: ${m.reason}`);
      if (m.p95 >= ML_WARMUP_P95_MS) return this.giveUp(`ML too slow (p95 ${m.p95.toFixed(1)} ms)`);
      if (!this.chain.setEngine('ml', 'auto')) return this.giveUp('ML needs a 44.1 kHz audio context');
      this.mlActive = true;
      this.fallback = { reason: 'auto' };
    });
    if (port) this.chain.setMlPort(port);
  }

  /** Stay on DSP; the reason depends on the setting at the time the probe ended. */
  private giveUp(cause: string): void {
    this.disposeHost();
    this.fallback = { reason: this.reasonFor(), cause };
  }

  private reasonFor(): MlReason {
    return this.quality === 'quality' ? 'deadline-miss' : 'auto';
  }

  private disposeHost(): void {
    this.host?.dispose();
    this.host = null;
    this.probing = false;
  }
}
