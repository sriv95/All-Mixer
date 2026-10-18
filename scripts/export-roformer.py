"""Export the Mel-Band RoFormer vocal model for the extension: Unwa's `mel_band_roformer_kim_ft_unwa`.
Writes models-out/roformer.onnx + roformer-meta.json. They are not part of the extension build: `bun run model-manifest <version>`
prepares them for upload to the Hugging Face repo that the extension downloads from (src/shared/model-store.ts).

The ONNX file is fp16 weights, fp32 input/output, fixed 112-frame chunk. The graph is the transformer core only: band
split, 6 x (time + frequency transformer), mask estimator. The STFT, the gather of the mel-band bins, the mask
scatter and the iSTFT run in JS (src/ml/roformer.ts), because ORT Web's WebGPU EP has no STFT op. Two rewrites keep
the graph inside WebGPU limits: the 60 per-band slices/concats are done in groups of 8 (a kernel may bind at most 10
storage buffers), and RMSNorm is rewritten so fp16 cannot produce NaN.

Needs python with: torch einops rotary-embedding-torch librosa pyyaml beartype onnx onnxruntime audio-separator
  python scripts/export-roformer.py [--ckpt path] [--config path]
Without --ckpt/--config the files are downloaded into .cache/models (SHA-256 checked).
"""
import argparse, hashlib, json, pathlib, sys, urllib.request
import numpy as np, torch, yaml, onnx, onnxruntime as ort
from einops import rearrange
from onnxruntime.transformers.float16 import convert_float_to_float16
from audio_separator.separator.uvr_lib_v5.roformer import mel_band_roformer as mbr
from audio_separator.separator.uvr_lib_v5.roformer.mel_band_roformer import MelBandRoformer

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = 'https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs'
CKPT, CKPT_SHA, CONFIG, NAME = 'mel_band_roformer_kim_ft_unwa.ckpt', 'e6bd8d333880191254a6ef6be3cb0ffa4dda9d3282e36b0cce2e88a660e00d39', 'config_mel_band_roformer_kim_ft_unwa.yaml', 'roformer'
HOP = 441
CHUNK = 111 * HOP  # 48951 samples (src/worklet/protocol.ts ROF_CHUNK); centre padding gives 112 frames
FRAMES = CHUNK // HOP + 1


def fetch(url, dst, sha=None):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        print('downloading', url)
        urllib.request.urlretrieve(url, dst)
    if sha and hashlib.sha256(dst.read_bytes()).hexdigest() != sha:
        sys.exit(f'{dst}: SHA-256 mismatch')
    return dst


def rms_norm(self, x):
    # F.normalize(x) * sqrt(d) * gamma, rewritten so fp16 on WebGPU cannot produce NaN. The original divides by
    # max(||x||, 1e-12): 1e-12 is 0 in fp16, so a silent band (an mp3 low-pass leaves the top mel bands at 0) gives
    # 0 / 0 = NaN, and a loud one overflows the sum of squares. Here x is scaled by its largest element first, so the
    # sum of squares is in [1, d] (exact normalisation, same result in fp32); a vector whose largest element is
    # below 1e-3 is scaled down smoothly instead of being blown up to unit length.
    y = x / x.abs().amax(dim=-1, keepdim=True).clamp_min(1e-3)
    return y / y.pow(2).sum(dim=-1, keepdim=True).sqrt().clamp_min(1.0) * self.scale * self.gamma


mbr.RMSNorm.forward = rms_norm


def hcat(parts, dim, g=8):
    while len(parts) > 1:
        parts = [torch.cat(parts[i:i + g], dim=dim) for i in range(0, len(parts), g)]
    return parts[0]


class Core(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):  # x [1, T, Fin]: STFT bins of the mel bands as (bin, re/im) pairs -> masks, same shape
        bs = self.m.band_split
        outs, o = [], 0
        for w, net in zip(bs.dim_inputs, bs.to_features):
            outs.append(net(x[..., o:o + w]).unsqueeze(-2))
            o += w
        x = hcat(outs, -2)
        for tt, ft in self.m.layers:
            x = rearrange(x, 'b t f d -> b f t d')
            b, f, t, d = x.shape
            x = tt(x.reshape(b * f, t, d)).reshape(b, f, t, d)
            x = rearrange(x, 'b f t d -> b t f d').reshape(b * t, f, d)
            x = ft(x).reshape(b, t, f, d)
        me = self.m.mask_estimators[0]
        return hcat([mlp(x[..., i, :]) for i, mlp in enumerate(me.to_freqs)], -1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt'); ap.add_argument('--config')
    a = ap.parse_args()
    ckpt_name, ckpt_sha, config_name, name = CKPT, CKPT_SHA, CONFIG, NAME
    cache = ROOT / '.cache/models'
    ckpt = pathlib.Path(a.ckpt) if a.ckpt else fetch(f'{BASE}/{ckpt_name}', cache / ckpt_name, ckpt_sha)
    config = pathlib.Path(a.config) if a.config else fetch(f'{BASE}/{config_name}', cache / config_name)
    cfg = yaml.unsafe_load(open(config))
    m = MelBandRoformer(**cfg['model'])
    sd = torch.load(ckpt, map_location='cpu', weights_only=False)
    print(m.load_state_dict(sd.get('state_dict', sd) if isinstance(sd, dict) else sd, strict=True))
    m.eval()
    fin = len(m.freq_indices) * 2
    core = Core(m).eval()
    x = torch.randn(1, FRAMES, fin) * 0.5
    out = ROOT / 'models-out'
    out.mkdir(parents=True, exist_ok=True)
    tmp = ROOT / f'.cache/models/{name}_fp32.onnx'
    tmp.parent.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        ref = core(x).numpy()
        torch.onnx.export(core, (x,), str(tmp), input_names=['x'], output_names=['masks'], opset_version=17, dynamo=False)
    onnx.save(convert_float_to_float16(onnx.load(tmp), keep_io_types=True), out / f'{name}.onnx')
    got = ort.InferenceSession(str(out / f'{name}.onnx'), providers=['CPUExecutionProvider']).run(None, {'x': x.numpy()})[0]
    print('fp16 vs torch fp32: max abs diff', float(np.abs(got - ref).max()), 'mean |ref|', float(np.abs(ref).mean()))
    meta = {
        'frames': FRAMES,
        'chunk': CHUNK,
        'nFft': cfg['model']['stft_n_fft'],
        'hop': cfg['model']['stft_hop_length'],
        # index into the interleaved (bin * 2 + channel) axis of every selected STFT value, in model order
        'sel': m.freq_indices.tolist(),
        # how many mel bands cover each bin
        'bands': m.num_bands_per_freq.tolist(),
    }
    assert meta['hop'] == HOP and meta['nFft'] == 2048
    (out / f'{name}-meta.json').write_text(json.dumps(meta, separators=(',', ':')))
    print('wrote', out / f'{name}.onnx', (out / f'{name}.onnx').stat().st_size // 2**20, 'MiB')


if __name__ == '__main__':
    main()
