import { MlHost } from '../content/audio/ml-host';
import { GEOMETRY, type FromMlWorker, type MlModel } from '../worklet/protocol';
import type { MixerSettings } from '../shared/settings';
import { OfflineSeparator } from './separator';

/** The model warm-up takes 10 to 40 s; the model download is not part of it. */
const START_TIMEOUT_MS = 180_000;

export interface MlSession {
  separator: OfflineSeparator;
  adapter: string;
  dispose(): void;
}

export type OpenMlSession = (audio: MixerSettings, signal: AbortSignal) => Promise<MlSession>;

/**
 * Starts the ML worker the live engine uses (hidden ml.html iframe + worker) with the model, GPU and delay limit of the export,
 * waits for its warm-up and hands back the separator on the port. A reason from the worker ("too slow", "not downloaded",
 * "no WebGPU") comes back as the error message.
 */
export const openMlSession: OpenMlSession = (audio, signal) =>
  new Promise<MlSession>((resolve, reject) => {
    const all = audio.mlModel === 'sw'; // the all-stems model splits the drums, guitar, bass and piano itself
    const host = new MlHost(undefined, document, audio.mlModel as MlModel, audio.mlDelayS * 1000, audio.splitInstrumental && !all, audio.gpu, audio.splitGuitar && !all, true);
    let port: MessagePort | null = null;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const fail = (e: Error) => done(() => {
      port?.close();
      host.dispose();
      reject(e);
    });
    const onAbort = () => fail(new Error('Export cancelled'));
    const timer = setTimeout(() => fail(new Error('The model did not start in time')), START_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort);
    port = host.start((m: FromMlWorker) => {
      if (m.type === 'unavailable') return fail(new Error(`Separation is not available: ${m.reason}`));
      const separator = new OfflineSeparator(port!, m.geometry ?? GEOMETRY[audio.mlModel as MlModel]);
      done(() => resolve({ separator, adapter: m.adapter, dispose: () => { separator.dispose(); host.dispose(); } }));
    });
    if (!port) fail(new Error('The model host could not start'));
  });
