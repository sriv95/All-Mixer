"""becruily mel-band-roformer-deux quality (CC-BY-NC-4.0; 2 stems [Vocals, Instrumental], vocals = stem 0 = model forward stft*mask0, istft), same 49-window set/scoring as the kara2 stage. fp32 torch / ONNX CPU.
  .venv/bin/python -I spike/duality/eval_deux.py long|short [--n N]   -> results/{long,short}_deux.json
long: config chunk 573300 (13 s), num_overlap 2 (step chunk/2); eval_long Hamming OLA, tail-aligned last window; vocals = model forward (stft*mask, istft).
short: eval_short.Stream at 112 frames, block 39680, overlap 8832 (no live plan on M1 at 1006 ms); torch fp32 core masks, stem 0."""
import sys, json, pathlib, subprocess
import numpy as np, torch, yaml, onnxruntime as ort
from safetensors.torch import load_file
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import eval_long as L, eval_short as S
K2 = pathlib.Path('/Users/sriv/Space/Repos/All-Mixer/.cache/models')
import mel_band_roformer as mbr


def load():
    cfg = yaml.unsafe_load(open(K2 / 'deux-config.yaml')); cfg['model']['flash_attn'] = False
    m = mbr.MelBandRoformer(**cfg['model']); sd = torch.load(K2 / 'becruily_deux.ckpt', map_location='cpu', weights_only=False)  # trusted local file
    m.load_state_dict(sd.get('state_dict', sd), strict=True)
    for a in m.modules():
        if hasattr(a, 'q_block'): a.q_block = 128  # exact; keeps the 13 s time-attention scores (60x8x1501^2 fp32 = 4 GB) off the 8 GB M1
    return m.eval()


def long_fn(m):  # config: chunk_size 573300 (13 s), num_overlap 2 -> step chunk/2. Scheme = eval_long Hamming OLA, tail-aligned last window (not ZFTurbo's reflect-padded fade windows)
    chunk = 573300; step = chunk // 2; win = torch.hamming_window(chunk)

    def demix(mix):
        x = torch.from_numpy(mix); n = x.shape[1]; res, cnt = torch.zeros_like(x), torch.zeros_like(x)
        with torch.no_grad():
            for i in range(0, n, step):
                if i + chunk > n: s, Ln = (n - chunk, chunk) if n >= chunk else (0, n)
                else: s, Ln = i, chunk
                part = x[:, s:s + Ln]
                if Ln < chunk: part = torch.nn.functional.pad(part, (0, chunk - Ln))
                y = m(part[None])[0, 0][:, :Ln]  # [B, stems, C, T] -> stem 0 = Vocals
                res[:, s:s + Ln] += y * win[:Ln]; cnt[:, s:s + Ln] += win[:Ln]
                if s + Ln >= n: break
        return (res / cnt.clamp(min=1e-10)).numpy()
    return demix


class _Sess:  # onnxruntime-like wrapper over the torch fp32 core (same Core as scripts/export-roformer.py, stem 0)
    def __init__(self, m): self.m = m

    def run(self, _, feed):
        from einops import rearrange
        x = torch.from_numpy(feed['x'])
        with torch.no_grad():
            bs = self.m.band_split; outs, o = [], 0
            for w, net in zip(bs.dim_inputs, bs.to_features): outs.append(net(x[..., o:o + w]).unsqueeze(-2)); o += w
            x = torch.cat(outs, -2)
            for tt, ft in self.m.layers:
                x = rearrange(x, 'b t f d -> b f t d'); b, f, t, dd = x.shape
                x = tt(x.reshape(b * f, t, dd)).reshape(b, f, t, dd)
                x = rearrange(x, 'b f t d -> b t f d').reshape(b * t, f, dd)
                x = ft(x).reshape(b, t, f, dd)
            y = torch.cat([mlp(x[..., i, :]) for i, mlp in enumerate(self.m.mask_estimators[0].to_freqs)], -1)
        return [y.numpy()]


def short_setup(m):  # 112 frames: block 39680 = largest 128-multiple with framesFor(block, 8832) == 112
    S.FRAMES, S.BLOCK, S.OVERLAP = 112, 39680, 8832
    S.CHUNK = (S.FRAMES - 1) * S.HOP; S.K = S.CHUNK - S.BLOCK; S.E = S.K - S.OVERLAP; S.PADDED = S.CHUNK + S.NFFT
    meta = dict(nFft=S.NFFT, hop=S.HOP, sel=m.freq_indices.tolist(), bands=m.num_bands_per_freq.tolist())
    json.dump(meta, open(HERE / 'results/meta_deux.json', 'w'), separators=(',', ':'))
    st = S.Stream(_Sess(m), meta)
    return lambda mix: S.separate(st, mix)


if __name__ == '__main__':
    mode = sys.argv[1]; n_max = int(sys.argv[sys.argv.index('--n') + 1]) if '--n' in sys.argv else None
    m = load(); fn = long_fn(m) if mode == 'long' else short_setup(m)
    items = json.load(open(HERE / 'eval_set.json')); per = {}
    for i, (name, mix, voc) in enumerate(S.clips(items)):
        if n_max and i >= n_max: break
        if (voc ** 2).sum() < 1e-6: print('skip silent', name); continue
        per[name] = float(L.sdr(voc, fn(mix))); print(f'{name:40s} {per[name]:.3f}', flush=True)
    v = np.array(list(per.values()))
    r = dict(model='deux', mode=mode, n=len(v), mean=float(v.mean()), median=float(np.median(v)), sdr=per)
    print({k: x for k, x in r.items() if k != 'sdr'})
    json.dump(r, open(HERE / f'results/{mode}_deux.json', 'w'), indent=1)
