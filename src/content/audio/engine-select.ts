import {
  GEOMETRY,
  type FromMlWorker,
  type GpuPreference,
  type MlEngine,
  type MlGeometry,
  type MlModel,
  type MlReason,
} from '../../worklet/protocol';
import type { ModelId } from '../../shared/model-store';
import type { LatencyListener } from './latency';
import { MlHost } from './ml-host';

/** What the selector needs from MasterChain. */
export interface EngineChain {
  setMlPort(port: MessagePort): void;
  /** Block geometry for the next ML stream; call before `setEngine('ml')`. */
  setMlGeometry(geometry: MlGeometry): void;
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
  /** RoFormer delay budget in ms (the audio delay stays below it); null or absent = automatic. Changing it while on restarts the probe. */
  delayMs?: number | null;
  /** Split the instrumental (drum stage, needs the drum model); changing it while on restarts the probe. */
  drums?: boolean;
  /** Also split the guitar out of the instrumental (needs the guitar model); changing it while on restarts the probe. */
  guitar?: boolean;
  /** GPU preference; changing it while on restarts the probe. Default 'auto'. */
  gpu?: GpuPreference;
}

const RATE_CAUSE = 'the audio context is not at 44.1 kHz';
/**
 * Turning Separate off keeps a warmed-up host for this long, so turning it on again (to compare with the original, say)
 * does not pay the 3 to 40 s warm-up again. The host holds the model on the GPU (up to ~0.5 GB), so it is not kept for long.
 */
export const KEEP_WARM_MS = 3 * 60 * 1000;

/** A host that passed its warm-up, and what it was started for. */
interface Warm {
  model: MlModel;
  delayMs: number | null;
  drums: boolean;
  guitar: boolean;
  gpu: GpuPreference;
  geometry: MlGeometry;
}

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
  private delayMs: number | null = null;
  private drums = false;
  private guitar = false;
  private gpu: GpuPreference = 'auto';
  private choice: EngineChoice = { state: 'off' };
  /** Set while the host in `host` has passed its warm-up (cleared with the host). */
  private warm: Warm | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly chain: EngineChain,
    private readonly createHost: (model: MlModel, delayMs: number | null, drums: boolean, gpu: GpuPreference, guitar: boolean) => MlHostLike = (model, delayMs, drums, gpu, guitar) => new MlHost(undefined, undefined, model, delayMs, drums, gpu, guitar),
  ) {
    chain.onLatencyChange((info) => {
      if (this.mlActive && info.engine === 'bypass' && info.reason === 'deadline-miss') {
        this.mlActive = false;
        this.disposeHost();
        this.setChoice({ state: 'stopped', cause: 'ML missed its deadline' });
      }
    });
  }

  get status(): EngineChoice {
    return this.choice;
  }

  /** Called whenever `status` changes (the content script pauses the video while it is `warming`). */
  onChange: ((choice: EngineChoice) => void) | null = null;

  private setChoice(choice: EngineChoice): void {
    this.choice = choice;
    this.onChange?.(choice);
  }

  update(req: SelectorRequest): void {
    const turnedOn = req.on && !this.on;
    const model = req.model ?? 'mdx';
    const delayMs = req.delayMs ?? null;
    const drums = req.drums === true;
    const guitar = req.guitar === true;
    const gpu = req.gpu ?? 'auto';
    const restart = req.on && this.on && (model !== this.model || delayMs !== this.delayMs || drums !== this.drums || guitar !== this.guitar || gpu !== this.gpu);
    this.model = model;
    this.delayMs = delayMs;
    this.drums = drums;
    this.guitar = guitar;
    this.gpu = gpu;
    this.on = req.on;
    if (!req.on) {
      if (this.mlActive) this.chain.setEngine('bypass', 'auto');
      this.mlActive = false;
      if (this.warm) this.idleTimer = setTimeout(() => this.disposeHost(), KEEP_WARM_MS);
      else this.disposeHost();
      this.setChoice({ state: 'off' });
      return;
    }
    if (turnedOn && this.warm && this.resume(model, delayMs, drums, gpu, guitar)) return;
    if (restart) {
      // A new model, delay budget, drum split or GPU: back to the original mix, drop the old host, probe again.
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
    const { delayMs, drums, gpu, guitar } = this;
    const host = this.createHost(model, delayMs, drums, gpu, guitar);
    this.host = host;
    this.probing = true;
    this.setChoice({ state: 'warming' });
    const port = host.start((m) => {
      if (this.host !== host || !this.probing) return;
      this.probing = false;
      if (m.type === 'unavailable') return this.giveUp(m.reason);
      // A RoFormer worker, or any worker with the drum stage, plans the geometry and checks the speed itself; the plain MDX gate is fixed.
      if (m.geometry) this.chain.setMlGeometry(m.geometry);
      else if (m.p90 >= GEOMETRY[model].warmupP90Ms) return this.giveUp(`too slow on this device (p90 ${m.p90.toFixed(1)} ms)`);
      if (!this.chain.setEngine('ml', 'auto')) return this.giveUp(RATE_CAUSE);
      this.warm = { model, delayMs, drums, guitar, gpu, geometry: m.geometry ?? GEOMETRY[model] };
      this.mlActive = true;
      this.setChoice({ state: 'on' });
    });
    if (port) {
      this.chain.setMlGeometry(GEOMETRY[model]); // the default; a RoFormer plan replaces it once the worker is ready
      this.chain.setMlPort(port);
    }
  }

  /** Separate turned on again while a warmed-up host is kept: use it if it was made for these settings. */
  private resume(model: MlModel, delayMs: number | null, drums: boolean, gpu: GpuPreference, guitar: boolean): boolean {
    const w = this.warm!;
    clearTimeout(this.idleTimer);
    if (w.model === model && w.delayMs === delayMs && w.drums === drums && w.guitar === guitar && w.gpu === gpu) {
      this.chain.setMlGeometry(w.geometry);
      if (this.chain.setEngine('ml', 'auto')) {
        this.mlActive = true;
        this.setChoice({ state: 'on' });
        return true;
      }
    }
    this.disposeHost(); // other settings, or ML refused: a fresh probe
    return false;
  }

  /** The downloaded files of model `id` changed (first download, update): probe again if it is in use. */
  reload(id: ModelId): void {
    // A kept host runs the old files: drop it.
    const stage = id === 'drums' || id === 'guitar';
    if (this.warm && !this.on && (stage ? (id === 'drums' ? this.warm.drums : this.warm.guitar) : this.warm.model === id)) this.disposeHost();
    if (!this.on || (stage ? !(id === 'drums' ? this.drums : this.guitar) : this.model !== id)) return;
    if (this.mlActive) this.chain.setEngine('bypass', 'auto');
    this.disposeHost();
    this.mlActive = false;
    this.probe();
  }

  /** Stay on the original mix. */
  private giveUp(cause: string): void {
    this.disposeHost();
    this.setChoice({ state: 'unavailable', cause });
  }

  private disposeHost(): void {
    clearTimeout(this.idleTimer);
    this.host?.dispose();
    this.host = null;
    this.warm = null;
    this.probing = false;
  }
}
