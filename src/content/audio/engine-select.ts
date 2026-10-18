import {
  GEOMETRY,
  type FromMlWorker,
  type MlEngine,
  type MlModel,
  type MlReason,
} from '../../worklet/protocol';
import type { LatencyListener } from './latency';
import { MlHost } from './ml-host';

/** What the selector needs from MasterChain. */
export interface EngineChain {
  setMlPort(port: MessagePort): void;
  /** Block geometry for the next ML stream; call before `setMlPort`. */
  setMlModel(model: MlModel): void;
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

/**
 * What Separate mode is doing, for the popup:
 *   off          Separate is off
 *   warming      probing ML; the original mix plays
 *   on           ML stems play
 *   unavailable  ML cannot run (cause says why); the original mix plays
 *   stopped      ML missed its deadline at run time; the original mix plays until Separate is toggled
 */
type SeparationChoiceState = 'off' | 'warming' | 'on' | 'unavailable' | 'stopped';

export interface EngineChoice {
  state: SeparationChoiceState;
  /** Short text for the UI, e.g. why ML is not running. */
  cause?: string;
}

export interface SelectorRequest {
  on: boolean;
  /** ML model to run; changing it while on restarts the probe. Default 'mdx'. */
  model?: MlModel;
}

const RATE_CAUSE = 'the audio context is not at 44.1 kHz';

/**
 * ML-only engine choice. Separate mode starts on the original mix (bypass); this probes the ML
 * engine and switches to it only after a fast warm-up. When ML cannot run, the original mix keeps
 * playing and `status` says why. A runtime deadline-miss stops ML until Separate mode is toggled.
 */
export class EngineSelector {
  private host: MlHostLike | null = null;
  private probing = false;
  private mlActive = false;
  private on = false;
  private model: MlModel = 'mdx';
  private choice: EngineChoice = { state: 'off' };

  constructor(
    private readonly chain: EngineChain,
    private readonly createHost: (model: MlModel) => MlHostLike = (model) => new MlHost(undefined, undefined, model),
  ) {
    chain.onLatencyChange((info) => {
      if (this.mlActive && info.engine === 'bypass' && info.reason === 'deadline-miss') {
        this.mlActive = false;
        this.disposeHost();
        this.choice = { state: 'stopped', cause: 'ML missed its deadline' };
      }
    });
  }

  get status(): EngineChoice {
    return this.choice;
  }

  update(req: SelectorRequest): void {
    const turnedOn = req.on && !this.on;
    const model = req.model ?? 'mdx';
    const restart = req.on && this.on && model !== this.model;
    this.model = model;
    this.on = req.on;
    if (!req.on) {
      if (this.mlActive) this.chain.setEngine('bypass', 'auto');
      this.disposeHost();
      this.mlActive = false;
      this.choice = { state: 'off' };
      return;
    }
    if (restart) {
      // A new model: back to the original mix, drop the old host, probe the new one.
      if (this.mlActive) this.chain.setEngine('bypass', 'auto');
      this.disposeHost();
      this.mlActive = false;
    }
    if (!(turnedOn || restart) || this.mlActive || this.probing) return;
    this.probe();
  }

  private probe(): void {
    if (!this.chain.canRunMl()) return this.giveUp(RATE_CAUSE);
    const model = this.model;
    const host = this.createHost(model);
    this.host = host;
    this.probing = true;
    this.choice = { state: 'warming' };
    const port = host.start((m) => {
      if (this.host !== host || !this.probing) return;
      this.probing = false;
      if (m.type === 'unavailable') return this.giveUp(m.reason);
      if (m.p90 >= GEOMETRY[model].warmupP90Ms) return this.giveUp(`too slow on this device (p90 ${m.p90.toFixed(1)} ms)`);
      if (!this.chain.setEngine('ml', 'auto')) return this.giveUp(RATE_CAUSE);
      this.mlActive = true;
      this.choice = { state: 'on' };
    });
    if (port) {
      this.chain.setMlModel(model);
      this.chain.setMlPort(port);
    }
  }

  /** The downloaded model files changed (first download, update): probe again if a RoFormer is wanted. */
  reload(): void {
    if (!this.on || this.model === 'mdx') return;
    if (this.mlActive) this.chain.setEngine('bypass', 'auto');
    this.disposeHost();
    this.mlActive = false;
    this.probe();
  }

  /** Stay on the original mix. */
  private giveUp(cause: string): void {
    this.disposeHost();
    this.choice = { state: 'unavailable', cause };
  }

  private disposeHost(): void {
    this.host?.dispose();
    this.host = null;
    this.probing = false;
  }
}
