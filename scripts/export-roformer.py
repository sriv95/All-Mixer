"""Export the Mel-Band RoFormer vocal models for the extension (the Model menu in the popup):
  roformer  Unwa's Kim fine-tune `mel_band_roformer_kim_ft_unwa` (menu: High quality)
  deux      becruily's 2-stem `mel-band-roformer-deux` (CC BY-NC 4.0); only its vocal stem is exported (menu: Best quality)
Writes models-out/<name>.onnx + <name>-meta.json. They are not part of the extension build: `bun run model-manifest`
prepares them for upload to the Hugging Face repo that the extension downloads from (src/shared/model-store.ts).

The ONNX file is fp16 weights, fp32 input/output, any number of STFT frames (the `frames` axis is dynamic: the extension
picks the chunk length at run time, src/ml/rof-plan.ts, and sets the axis with a session option). The graph is the
transformer core only: band
split, 6 x (time + frequency transformer), mask estimator. The STFT, the gather of the mel-band bins, the mask
scatter and the iSTFT run in JS (src/ml/roformer.ts), because ORT Web's WebGPU EP has no STFT op. Two rewrites keep
the graph inside WebGPU limits: the 60 per-band slices/concats are done in groups of 8 (a kernel may bind at most 10
storage buffers), and RMSNorm is rewritten so fp16 cannot produce NaN.

Needs python with: torch einops rotary-embedding-torch librosa pyyaml beartype onnx onnxruntime audio-separator
  bun run export-roformer [name ...] [--force]
No name = all models; one that is already exported is skipped unless --force. Checkpoints and configs are downloaded
into .cache/models (SHA-256 checked where known).
"""
import argparse, functools, hashlib, json, pathlib, sys, urllib.request
import numpy as np, torch, yaml, onnx, onnxruntime as ort
from torch.export import Dim
from einops import rearrange
from onnxruntime.transformers.float16 import convert_float_to_float16
from audio_separator.separator.uvr_lib_v5.roformer import mel_band_roformer as mbr
from audio_separator.separator.uvr_lib_v5.roformer.mel_band_roformer import MaskEstimator, MelBandRoformer

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = 'https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs'
DEUX = 'https://huggingface.co/becruily/mel-band-roformer-deux/resolve/main'
GUITAR = 'https://huggingface.co/becruily/mel-band-roformer-guitar/resolve/main'
# name -> (checkpoint url, SHA-256 or None, config url, index of the vocal stem in the model output)
MODELS = {
    'roformer': (f'{BASE}/mel_band_roformer_kim_ft_unwa.ckpt', 'e6bd8d333880191254a6ef6be3cb0ffa4dda9d3282e36b0cce2e88a660e00d39', f'{BASE}/config_mel_band_roformer_kim_ft_unwa.yaml', 0),
    # stems are [Vocals, Instrumental]; stem 0 has ~0 % of its energy below 150 Hz, stem 1 about 65 %
    # debug Split model, not a menu entry: becruily's guitar model, stems [Guitar, Other], one mask estimator; licence unstated
    'guitar': (f'{GUITAR}/becruily_guitar.ckpt', None, f'{GUITAR}/config_guitar_becruily.yaml', 0),
    'deux': (f'{DEUX}/becruily_deux.ckpt', '10255c02295bf3e3865d4ee50ff752d7b19b124ed5fd93b147babc4333eda3aa', f'{DEUX}/config.yaml', 0),
}
HOP = 441
FRAMES = 112  # example length for the trace; the exported axis is dynamic (16 to MAX_FRAMES)
MAX_FRAMES = 1700


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
    def __init__(self, m, stem):
        super().__init__()
        self.m, self.stem = m, stem

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
        me = self.m.mask_estimators[self.stem]
        return hcat([mlp(x[..., i, :]) for i, mlp in enumerate(me.to_freqs)], -1)


def export(name, force):
    out = ROOT / 'models-out'
    if not force and (out / f'{name}.onnx').exists() and (out / f'{name}-meta.json').exists():
        print(name, 'already exported (--force to redo)')
        return
    ckpt_url, ckpt_sha, config_url, stem = MODELS[name]
    cache = ROOT / '.cache/models'
    ckpt = fetch(ckpt_url, cache / ckpt_url.rsplit('/', 1)[1], ckpt_sha)
    config = fetch(config_url, cache / f'{name}-{config_url.rsplit("/", 1)[1]}')
    cfg = yaml.unsafe_load(open(config))
    if not cfg['model'].get('linear_transformer_depth'):
        cfg['model'].pop('linear_transformer_depth', None)  # not an argument of audio-separator's model; 0 = unused
    # audio-separator builds the mask estimator with the default expansion 4 whatever the config says
    mbr.MaskEstimator = functools.partial(MaskEstimator, mlp_expansion_factor=cfg['model'].get('mlp_expansion_factor', 4))
    m = MelBandRoformer(**cfg['model'])
    sd = torch.load(ckpt, map_location='cpu', weights_only=False)
    print(m.load_state_dict(sd.get('state_dict', sd) if isinstance(sd, dict) else sd, strict=True))
    m.eval()
    fin = len(m.freq_indices) * 2
    core = Core(m, stem).eval()
    x = torch.randn(1, FRAMES, fin) * 0.5
    out.mkdir(parents=True, exist_ok=True)
    tmp = ROOT / f'.cache/models/{name}_fp32.onnx'
    tmp.parent.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        # dynamo export: the tracing exporter bakes the frame count into the reshapes
        torch.onnx.export(core, (x,), input_names=['x'], output_names=['masks'], opset_version=18, dynamo=True,
                          dynamic_shapes={'x': {1: Dim('frames', min=16, max=MAX_FRAMES)}}).save(str(tmp))
    onnx.save(convert_float_to_float16(onnx.load(tmp), keep_io_types=True), out / f'{name}.onnx')
    g = onnx.load(out / f'{name}.onnx').graph
    assert g.input[0].type.tensor_type.shape.dim[1].dim_param == 'frames', 'the frame axis must be named "frames" (session freeDimensionOverrides)'
    sess = ort.InferenceSession(str(out / f'{name}.onnx'), providers=['CPUExecutionProvider'])
    for t in (FRAMES, 200, 449):
        xt = torch.randn(1, t, fin) * 0.5
        with torch.no_grad():
            ref = core(xt).numpy()
        got = sess.run(None, {'x': xt.numpy()})[0]
        print(f'{t} frames, fp16 vs torch fp32: max abs diff', float(np.abs(got - ref).max()), 'mean |ref|', float(np.abs(ref).mean()))
    meta = {
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('names', nargs='*', choices=list(MODELS), metavar='name')
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    for name in a.names or MODELS:
        export(name, a.force)


if __name__ == '__main__':
    main()
