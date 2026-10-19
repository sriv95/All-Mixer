"""Spike: BS-RoFormer SW (6 stems: bass, drums, other, vocals, guitar, piano) core as fp16 ONNX, to time it on WebGPU.
Same recipe as scripts/export-roformer.py (core graph only; STFT/mask/iSTFT stay outside; groups of 8 for the 10-buffer
limit; RMSNorm rewritten for fp16), for audio-separator's BSRoformer. Checks the core against the full torch model.
  .venv/bin/python -I spike/bench/sw_export.py   (needs .cache/sw/sw.ckpt + sw.yaml)
Writes spike/ml/models/sw.onnx (input x [1, frames, 4100], output [1, frames, 6 * 4100])."""
import pathlib, numpy as np, torch, yaml, onnx, onnxruntime as ort
from torch.export import Dim
from einops import rearrange
from onnxruntime.transformers.float16 import convert_float_to_float16
from audio_separator.separator.uvr_lib_v5.roformer import bs_roformer as bsr

ROOT = pathlib.Path(__file__).resolve().parents[2]
SW = ROOT / '.cache/sw'
FRAMES, MAX_FRAMES = 112, 1700


def rms_norm(self, x):
    y = x / x.abs().amax(dim=-1, keepdim=True).clamp_min(1e-3)
    return y / y.pow(2).sum(dim=-1, keepdim=True).sqrt().clamp_min(1.0) * self.scale * self.gamma


bsr.RMSNorm.forward = rms_norm


def hcat(parts, dim, g=8):
    while len(parts) > 1:
        parts = [torch.cat(parts[i:i + g], dim=dim) for i in range(0, len(parts), g)]
    return parts[0]


class Core(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):  # [1, T, 4100] (bin, channel, re/im) -> [1, T, S * 4100]
        m = self.m
        outs, o = [], 0
        for w, net in zip(m.band_split.dim_inputs, m.band_split.to_features):
            outs.append(net(x[..., o:o + w]).unsqueeze(-2))
            o += w
        x = hcat(outs, -2)
        for tt, ft in m.layers:
            x = rearrange(x, 'b t f d -> b f t d')
            b, f, t, d = x.shape
            x = tt(x.reshape(b * f, t, d)).reshape(b, f, t, d)
            x = rearrange(x, 'b f t d -> b t f d').reshape(b * t, f, d)
            x = ft(x).reshape(b, t, f, d)
        x = m.final_norm(x)
        return torch.cat([hcat([mlp(x[..., i, :]) for i, mlp in enumerate(me.to_freqs)], -1) for me in m.mask_estimators], -1)


def load():
    cfg = yaml.unsafe_load(open(SW / 'sw.yaml'))['model']
    cfg.pop('linear_transformer_depth', None)
    m = bsr.BSRoformer(**cfg)
    m.load_state_dict(torch.load(SW / 'sw.ckpt', map_location='cpu', weights_only=True), strict=True)
    return m.eval()


if __name__ == '__main__':
    m = load()
    core = Core(m).eval()
    # parity with the full model: same STFT, masks from the core, same istft
    wav = torch.randn(1, 2, 44100 * 3) * 0.1
    with torch.no_grad():
        ref = m(wav)  # [1, 6, 2, T]
        win = m.stft_window_fn()
        st = torch.view_as_real(torch.stft(wav.reshape(2, -1), **m.stft_kwargs, window=win, return_complex=True))  # [2, f, t, 2]
        x = rearrange(st, 's f t c -> t (f s c)')[None]
        mask = core(x)
        mk = rearrange(mask, 'b t (n f s c) -> b n (f s) t c', n=6, f=1025, s=2, c=2)
        st2 = rearrange(st, 's f t c -> (f s) t c')[None, None]
        y = torch.view_as_complex(st2.contiguous()) * torch.view_as_complex(mk.contiguous())
        y = rearrange(y, 'b n (f s) t -> (b n s) f t', s=2)
        out = torch.istft(y, **m.stft_kwargs, window=win, return_complex=False)
        out = rearrange(out, '(n s) t -> n s t', s=2)
    print('core vs full model max abs diff', float((out - ref[0]).abs().max()), 'ref max', float(ref.abs().max()))
    x = torch.randn(1, FRAMES, 4100) * 0.5
    tmp = SW / 'sw_fp32.onnx'
    with torch.no_grad():
        torch.onnx.export(core, (x,), input_names=['x'], output_names=['masks'], opset_version=18, dynamo=True,
                          dynamic_shapes={'x': {1: Dim('frames', min=16, max=MAX_FRAMES)}}).save(str(tmp))
    dst = ROOT / 'spike/ml/models/sw.onnx'
    onnx.save(convert_float_to_float16(onnx.load(tmp), keep_io_types=True), dst)
    sess = ort.InferenceSession(str(dst), providers=['CPUExecutionProvider'])
    for t in (FRAMES, 200):
        xt = torch.randn(1, t, 4100) * 0.5
        with torch.no_grad():
            r = core(xt).numpy()
        g = sess.run(None, {'x': xt.numpy()})[0]
        print(t, 'frames fp16 vs fp32 max abs diff', float(np.abs(g - r).max()), 'mean |ref|', float(np.abs(r).mean()))
    print('size MB', dst.stat().st_size / 1e6)
