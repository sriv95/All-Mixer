# usage: bench_all.py CSV OUTDIR [limit_per_set] [WORKDIR with clips_musdb/ (set B, from prep_musdb.py)]   resumable; deux 112/224 then sw 112/256 (vocals stem idx 3), CPU EP
# Inference math copied from bench.py / bench_sw.py (only the vocals stem is synthesised for sw: stems are independent).
import os, pathlib; ROOT = pathlib.Path(__file__).resolve().parents[3]; MODELS = os.environ.get('MODELS_OUT') or str(ROOT / 'models-out')  # same default as stream_eval*.mjs
import sys, os, time, json, glob, csv, numpy as np, soundfile as sf, onnxruntime as ort
CSV, OUT = sys.argv[1], sys.argv[2]; LIM = int(sys.argv[3]) if len(sys.argv) > 3 else 10**9
M = MODELS + '/'; W = (sys.argv[4] if len(sys.argv) > 4 else 'work') + '/'
N_FFT, Q, CONTEXT, R = 2048, 128, 439, 8832; BINS = N_FFT // 2 + 1
win = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)); ramp = 0.5 - 0.5 * np.cos(np.pi * (np.arange(R) + 0.5) / R)

def make(name, F, sess, meta, S, k):
    HOP = meta['hop']; C = (F - 1) * HOP; H = (C - R - CONTEXT) // Q * Q; E = C - H - R
    sel = np.array(meta['sel']); invb = (1 / np.maximum(np.array(meta['bands'], dtype=np.float32), 1e-8)).astype(np.float32)[:BINS]
    pad = C + N_FFT; env = np.zeros(pad)
    for t in range(F): env[t*HOP:t*HOP+N_FFT] += win**2
    norm = np.where(env > 1e-11, 1 / np.maximum(env, 1e-11), 1.0)
    idx = np.arange(F)[:, None] * HOP + np.arange(N_FFT)[None, :] - N_FFT // 2
    idx = np.where(idx < 0, -idx, np.where(idx >= C, 2 * (C - 1) - idx, idx))
    def run(x):
        n = len(x); nb = -(-(n + R) // H); xp = np.zeros((nb * H, 2), np.float32); xp[:n] = x
        chunk = np.zeros((2, C), np.float32); tail = np.zeros((2, R)); outs = []
        for b in range(nb):
            chunk = np.concatenate([chunk[:, H:], xp[b*H:(b+1)*H].T], axis=1)
            spec = np.fft.rfft(chunk[:, idx] * win, axis=-1)
            fs = spec.transpose(1, 2, 0).reshape(F, 2 * BINS); g = fs[:, sel]
            xin = np.stack([g.real, g.imag], -1).reshape(1, F, -1).astype(np.float32)
            o = sess.run(None, {'x': xin})[0]
            m = (o.reshape(F, len(sel), 2) if S == 1 else o.reshape(F, S, len(sel), 2)[:, k]).astype(np.float32)
            accr = np.zeros((F, 2 * BINS), np.float32); acci = np.zeros_like(accr)
            np.add.at(accr, (slice(None), sel), m[..., 0]); np.add.at(acci, (slice(None), sel), m[..., 1])
            mask = ((accr + 1j * acci).reshape(F, BINS, 2) * invb[None, :, None]).transpose(2, 0, 1)
            y = np.fft.irfft(spec * mask, n=N_FFT, axis=-1) * win
            ola = np.zeros((2, pad))
            for t in range(F): ola[:, t*HOP:t*HOP+N_FFT] += y[:, t]
            ola *= norm
            seg = ola[:, N_FFT // 2 + E: N_FFT // 2 + E + H].copy()
            seg[:, :R] = tail * (1 - ramp) + seg[:, :R] * ramp
            tail = ola[:, N_FFT // 2 + E + H: N_FFT // 2 + E + H + R].copy(); outs.append(seg)
        o = np.concatenate(outs, axis=1)[:, R:R + n].T
        assert o.shape == x.shape and np.isfinite(o).all(); return o.astype(np.float32)
    return run

def sdr(r, e): return 10*np.log10((r**2).sum() / max(((r-e)**2).sum(), 1e-20))
def sisdr(r, e):
    r, e = r.ravel(), e.ravel(); a = (e @ r) / max(r @ r, 1e-20); t = a * r
    return 10*np.log10(max((t**2).sum(), 1e-20) / max(((e-t)**2).sum(), 1e-20))
def bleed(r, e):
    nf = len(r) // 2048; rr = r[:nf*2048].reshape(nf, -1); ee = e[:nf*2048].reshape(nf, -1)
    rms = np.sqrt((rr**2).mean(1)); q = rms < rms.max() * 10**(-40/20) if rms.max() > 0 else np.zeros(nf, bool)
    if not q.any(): return float('nan')
    return 10*np.log10(max((ee[q]**2).sum(), 1e-20) / max((e**2).sum(), 1e-20))

clips = [(os.path.basename(d.rstrip('/')), 'A', d) for d in sorted(glob.glob(str(ROOT / 'spike/clips/wav') + '/*/'))[:LIM]]
clips += [(os.path.basename(d.rstrip('/')), 'B', d) for d in sorted(glob.glob(W + 'clips_musdb/*/'))[:LIM]]
cols = 'clip,set,name,model,frames,sdr,sisdr,bleed_db,instr_sdr,voc_to_mix_db,silent,sec'.split(',')
done = set()
if os.path.exists(CSV):
    done = {(r['set'], r['clip'], r['model'], r['frames']) for r in csv.DictReader(open(CSV))}
else: csv.writer(open(CSV, 'w')).writerow(cols)
for model, Fs in (('deux', (112, 224)), ('sw', (112, 256))):
    todo = [(F, c) for F in Fs for c in clips if (c[1], c[0], model, str(F)) not in done]
    if not todo: continue
    meta = json.load(open(M + model + '-meta.json')); S = len(meta['stems']) if model == 'sw' else 1
    sess = ort.InferenceSession(M + model + '.onnx', providers=['CPUExecutionProvider'])
    for F in Fs:
        run = make(model, F, sess, meta, S, 3); os.makedirs(f'{OUT}/{model}_{F}', exist_ok=True)
        for c, st, d in clips:
            if (st, c, model, str(F)) not in done and (F, (c, st, d)) in todo:
                x, _ = sf.read(d + '/mix.wav', dtype='float32'); ref, _ = sf.read(d + '/vocals.wav', dtype='float64')
                t0 = time.time(); e = run(x); sec = time.time() - t0
                nm = open(d + '/name.txt').read().strip() if st == 'A' else c
                wp = f'{OUT}/{model}_{F}/{st}_{c}.wav'; sf.write(wp, np.clip(e, -1, 1), 44100, subtype='PCM_16')
                x64 = x.astype(np.float64); e = e.astype(np.float64); n = min(len(ref), len(e)); r, e, x64 = ref[:n], e[:n], x64[:n]
                v2m = 10*np.log10(max((r**2).sum(), 1e-20) / max((x64**2).sum(), 1e-20))
                row = [c, st, nm, model, F, f'{sdr(r, e):.3f}', f'{sisdr(r, e):.3f}', f'{bleed(r, e):.3f}', f'{sdr(x64-r, x64-e):.3f}', f'{v2m:.2f}', int(v2m < -20), f'{sec:.1f}']
                with open(CSV, 'a') as f: csv.writer(f).writerow(row)
                print(*row, flush=True)
    del sess
