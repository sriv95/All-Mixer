"""Parity of the torch port (mdx_torch.py) vs compat-mdx.onnx (ORT CPU) on 3 musdb18hq test clips of ~10 s.
  .venv/bin/python spike/finetune/parity_mdx.py [--T 64] [--secs 10]    SDR torch vs ONNX (target > 40 dB), both vs vocals.wav
  .venv/bin/python spike/finetune/parity_mdx.py --selftest              fwd+bwd on MPS, random [1,4,2048,128] (batch 4 thrashes on an 8 GB Mac), finite grads, s/step"""
import argparse, pathlib, sys, time
import numpy as np, onnxruntime as ort, soundfile as sf, torch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import mdx_torch as mt

MUSDB = pathlib.Path('/Users/sriv/Space/Repos/All-Mixer/.cache/musdb18hq/test')
MPS = False  # --mps enables the torch-mps leg (off: 8 GB Mac shared)


def sdr(ref, est): return 10 * np.log10((ref ** 2).sum() / (((ref - est) ** 2).sum() + 1e-12))


def selftest():
    dev = 'mps'; m = mt.load().to(dev).train()
    ps = [p for p in m.parameters() if p.requires_grad]; assert ps
    x = torch.randn(1, 4, mt.BINS, 128, device=dev); ts = []
    for i in range(3):
        m.zero_grad(); t0 = time.time(); loss = m(x).pow(2).mean(); loss.backward(); torch.mps.synchronize(); ts.append(time.time() - t0)
    assert torch.isfinite(loss).item()
    assert all(p.grad is not None and torch.isfinite(p.grad).all().item() for p in ps), 'non-finite/missing grads'
    print(f'selftest ok: {len(ps)} trainable tensors, batch 1 x T128, {ts[-1]:.2f} s/step (all: {[round(t, 2) for t in ts]})')


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--mps', action='store_true'); ap.add_argument('--T', type=int, default=64); ap.add_argument('--secs', type=float, default=10); a = ap.parse_args()
    if a.selftest: return selftest()
    s = ort.InferenceSession(str(mt.SRC), providers=['CPUExecutionProvider'])
    f_ort = lambda inp: torch.from_numpy(s.run(None, {'input': inp.numpy()})[0])
    cpu = mt.load().eval(); mps = mt.load().eval().to('mps') if a.mps else None
    f_cpu = lambda inp: cpu(inp); f_mps = lambda inp: mps(inp.to('mps')).cpu() if mps is not None else None
    clips = sorted(MUSDB.iterdir())[:3]
    for d in clips:
        n = int(a.secs * 44100); a0 = 30 * 44100
        mix = sf.read(d / 'mixture.wav', dtype='float32')[0].T[:, a0:a0 + n].copy(); voc = sf.read(d / 'vocals.wav', dtype='float32')[0].T[:, a0:a0 + n]
        o = mt.separate(f_ort, mix, a.T); c = mt.separate(f_cpu, mix, a.T); g = mt.separate(f_mps, mix, a.T) if a.mps else c
        print(f'{d.name[:28]:28s} torch-cpu vs onnx {sdr(o, c):6.1f} | torch-mps vs onnx {sdr(o, g):6.1f} | vs vocals: onnx {sdr(voc, o):5.2f} cpu {sdr(voc, c):5.2f} mps {sdr(voc, g):5.2f}')
    for T in (96, 256):  # other frame counts: torch vs ONNX on one raw input
        x = torch.randn(1, 4, mt.BINS, T) * 0.1
        with torch.no_grad(): print(f'T={T}: max|torch-onnx| {(cpu(x) - f_ort(x)).abs().max():.2e}')


if __name__ == '__main__': main()
