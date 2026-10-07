# SRI-220: SRI-209 dip-fill with a pause gate, corrected frames (lovely t0 = 71.5387)

Script `spike/ml/sri220_gate.py`; results `scripts/qa-sri220-*.json`. Offline only, no `src/` change. Fill core = SRI-209 V1 a0.5 t0.3 b1.0 (band 100-1000 Hz, STFT 4096/1024). Gate g in [0,1] per STFT frame, smoothed with a 5-frame Hann (+-2 frames = +-46 ms): `Vz = Vm + g*(fill - Vm)`.
Gates: G1 Spleeter band energy minus MDX band energy 3->9 dB, and Spleeter above P95-40 dB; G2 |X|-weighted mean Spleeter mask in band 0.3->0.5 (and Spleeter above P95-40 dB); G3 = G1*G2*"vocal phrase within +-1.5 s"; G4 = G2 loosened (mask 0.15->0.35, floor P95-50 dB); G5 = G4 dilated +-2 frames. Dip metric as SRI-209 (12 times 102.5-127.75 s on the SRI-203 clock, max V dB within +-4 frames minus V dB). Pause frames = 20 (89-92, 94-96, 99-100 s with base V < -55 dB). Leak = V dB minus base V dB. Band change = Karaoke 20-120 Hz energy vs the current stream (bass), Karaoke 150-1000 Hz frame mean vs the current stream.

## Lovely (worst dip dB | pause leak mean / max dB | bass change dB | Kar 150-1k change dB)
| Variant | shift 0 | shift 512 |
|---|---|---|
| base (current) | 32.1 / 0 / 0 / 0 / 0 | 21.9 / 0 / 0 / 0 / 0 |
| G0 no gate (SRI-209 V1) | 19.1 / 3.50 / 22.5 / 0.00 / -0.78 | 18.8 / 3.53 / 22.1 / 0.00 / -0.76 |
| G1 spleeter-vs-mdx | 21.1 / 3.5 / 22.5 / 0.00 / -0.33 | 20.9 / 3.52 / 22.1 / 0.00 / -0.31 |
| G2 mask evidence | 22.9 / **0.00 / 0.0** / 0.00 / -0.73 | 22.0 / **0.00 / 0.0** / 0.00 / -0.71 |
| G3 G1xG2+phrase | 22.8 / **0.00 / 0.0** / 0.00 / -0.30 | 21.9 / **0.00 / 0.0** / 0.00 / -0.29 |
| G4 mask loose | 22.3 / 0.53 / 9.6 / 0.00 / -0.77 | 21.4 / 0.51 / 9.2 / 0.00 / -0.75 |
| G5 loose + dilated | 21.7 / 0.88 / 14.7 / 0.00 / -0.78 | 20.9 / 0.88 / 14.3 / 0.00 / -0.75 |

Bass (20-120 Hz) and 150-1000 Hz change are within 1 dB of the current stream for all variants (max -0.78 dB).

## Why the worst dip stays about 21 dB (not a gate problem)
The worst frames are 102.5 s (16.2 dB, every variant) and 104.3 / 104.5 s (18-23 dB). In those frames Spleeter's own vocal is also low: full-band V at frames 131/132 is MDX -39.3 / -40.1 dB, fill -36.2 / -35.5, Spleeter-only -34.0 / -35.4, neighbours about -17 dB. The 100-1000 Hz fill can raise it by 3-5 dB at most, because the Spleeter evidence agrees with the dip (a real quiet moment, or both models miss it). The mix there is steady (-15.8 dB), so only mix-based evidence could fill it, with no way to tell it from accompaniment.
Excluding frames 124/131/132 the worst dip is: G0 6.4, G1 6.3, G2 13.7, G3 13.6, G4 7.5, G5 6.6 dB. The Chrome-visible dip (126.0 s, 32.1 dB) becomes 2.0 (G0), 1.8 (G1), 6.4 (G2), 6.3 (G3), 2.0 (G4/G5).

## Second clips (mono references from SRI-169, 60 s, no ground truth; dips = frames >= 8 dB under the +-4 frame max)
| Clip | Variant | worst dip | pause leak mean/max | Kar 150-1k change |
|---|---|---|---|---|
| despacito | base | 34.5 | 0 / 0 | 0 |
| despacito | G2 | 34.5 | 0.00 / 0.0 | -0.24 |
| despacito | G4 | 34.5 | 0.00 / 0.03 | -0.27 |
| despacito | G0 no gate | 34.5 | 0.03 / 0.6 | -0.28 |
| billie | base | 41.5 | no pause frames | 0 |
| billie | G2 / G4 / G5 | 41.7 / 40.7 / 39.2 | none | -0.15 / -0.23 / -0.28 |
Bass change 0.00 dB on both. The fill does not change the worst dip on either (despacito 34.5 unchanged; billie 41.5 -> 39.2 at best, with G0 35.2). Those worst frames are mostly real vocal gaps, and the generic detector cannot tell a model dip from a musical one, so this clip check only supports "gate keeps pauses clean and bass intact"; it does not show the dip fix generalises.

## Verdict against the target (dip <= 12 dB, leak mean <= 1 dB and max <= 6 dB)
**Fails.** No variant meets both. Best leak: G2/G3 (0.00 / 0.0 dB) but worst dip 21.9-22.9 dB (9.9-10.9 dB over target; 13.6-13.7 dB if frames 102.5/104.3/104.5 are excluded, still 1.6 over). Best dip: G0 18.8-19.1 dB with leak 3.5 / 22.5 dB (fails leak by 2.5 / 16.5 dB). G4 reaches leak mean 0.5 (passes) but max 9.2-9.6 (3.2-3.6 over). Gating cannot fix 102.5 / 104.4 s because Spleeter agrees with MDX there.
Suggested next step (Marquess): accept the gated fill (G2 or G4) for the 126 s class of dip (32.1 -> 6.4 / 2.0 dB) and treat 102.5 / 104.4 s as a model limit, or ask for a different vocal-evidence source for those frames.

## Latency and CPU
- Latency: the gate looks +-2 STFT frames (+-46 ms) inside the MDX segment output; fill and Spleeter mask use the same 4096/1024 STFT frames as hybrid_stream (Spleeter lookahead 2 frames is already in its stated "no extra delay beyond MDX"). Added latency beyond the 1.97 s budget: 0 ms by construction, worst case +46 ms at segment edges. Not measured in Chrome.
- CPU (offline ORT CPU, 6 threads, 30 s stereo): MDX 11.75 s, Spleeter masks (hop 4, ctx 64, lookahead 2) 32.21 s = 2.74x the MDX time. Running Spleeter alongside MDX ~3.7x the MDX CPU cost on this setup. The shipped path already runs Spleeter (hybrid_stream m_spl); the gate itself (band energies, ramps) is O(frames) and negligible.
