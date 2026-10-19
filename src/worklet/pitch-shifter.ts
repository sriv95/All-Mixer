// Stereo pitch shifter for the separator worklet: two read taps move through a delay line at a different speed than
// the write head, each tap faded by a Hann window so the jump back at the end of its sweep is silent. The tempo does
// not change. shortcut: no waveform alignment between the taps, so tonal music gets a slight warble; upgrade to WSOLA
// or a phase vocoder if that is not good enough.
// At 0 semitones the output is the input delayed by PITCH_LATENCY_SAMPLES; the shifted path fades in over RAMP samples.
// process() allocates nothing.
import { PITCH_LATENCY_SAMPLES, PITCH_WINDOW } from './protocol';

const SIZE = 4096;
const MASK = SIZE - 1;
/** Fade between the dry and the shifted path. */
const RAMP = 512;
/** Below this many semitones the shifter is a plain delay. */
const OFF_BELOW = 0.01;

export class PitchShifter {
  private readonly bufL = new Float32Array(SIZE);
  private readonly bufR = new Float32Array(SIZE);
  private w = 0;
  /** Tap A's delay as a fraction of the window; tap B is half a window behind. 0.5 = tap A at the dry delay, full weight. */
  private phase = 0.5;
  /** Weight of the shifted path (0 = dry). */
  private mix = 0;

  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.phase = 0.5;
    this.mix = 0;
  }

  /** `in` and `out` may be the same arrays. */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, n: number, semitones: number): void {
    const { bufL, bufR } = this;
    const shifting = Math.abs(semitones) >= OFF_BELOW;
    const target = shifting ? 1 : 0;
    // Start the shifted path where it matches the dry one (tap A at the dry delay), so the fade-in has no comb.
    if (shifting && this.mix === 0) this.phase = 0.5;
    const dPhase = (1 - 2 ** (semitones / 12)) / PITCH_WINDOW;
    let { w, phase, mix } = this;
    for (let i = 0; i < n; i++) {
      bufL[w] = inL[i];
      bufR[w] = inR[i];
      const dry = (w - PITCH_LATENCY_SAMPLES) & MASK;
      let l = bufL[dry];
      let r = bufR[dry];
      if (mix > 0) {
        const wa = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
        const pb = phase < 0.5 ? phase + 0.5 : phase - 0.5;
        const da = phase * PITCH_WINDOW;
        const db = pb * PITCH_WINDOW;
        const sl = wa * tap(bufL, w, da) + (1 - wa) * tap(bufL, w, db);
        const sr = wa * tap(bufR, w, da) + (1 - wa) * tap(bufR, w, db);
        l += mix * (sl - l);
        r += mix * (sr - r);
      }
      outL[i] = l;
      outR[i] = r;
      w = (w + 1) & MASK;
      if (shifting || mix > 0) {
        phase += dPhase;
        if (phase >= 1) phase -= 1;
        else if (phase < 0) phase += 1;
      }
      if (mix < target) mix = Math.min(target, mix + 1 / RAMP);
      else if (mix > target) mix = Math.max(target, mix - 1 / RAMP);
    }
    this.w = w;
    this.phase = phase;
    this.mix = mix;
  }
}

/** Linear interpolation `delay` samples behind index `w` (delay in [0, PITCH_WINDOW]). */
function tap(buf: Float32Array, w: number, delay: number): number {
  const p = w - delay;
  const i0 = Math.floor(p);
  const a = buf[i0 & MASK];
  return a + (p - i0) * (buf[(i0 + 1) & MASK] - a);
}
