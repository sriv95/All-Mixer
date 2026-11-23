"""Duality (Aname Mel-Band-Roformer_Duality) transformer core as a trainable torch module, same graph as the shipped ONNX.
Model code: spike/duality/mel_band_roformer.py (vendored musetric/lab, MIT, from lucidrains/BS-RoFormer, MIT). Weights + config:
https://huggingface.co/Aname-Tommy/Mel-Band-Roformer_Duality (Apache-2.0 per HF tag), local models-out/duality-teacher/{duality_v1.ckpt,config_v1.yaml}.
Shipped app model = models-out/duality.onnx == models-out/duality-teacher/teacher_fp16_fixed.onnx (cmp identical): fp16 core, x [1,T,4144] -> masks [1,T,4144];
STFT/mask-apply/iSTFT run host-side (src/ml/roformer.ts). core_features() reproduces the host STFT features.
  load(device) -> Core; core_features(raw[B,2,n]) -> x [B,T,Fin]; apply_masks(x_raw, masks) -> vocals [B,2,n] (differentiable)
The 'fix' patches (eps 1e-9 RMSNorm, fp32 attention scores, no 128-row blocks) are the maths of export_teacher.py --fp16fix; applied at import."""
import pathlib, sys
import torch, yaml
from einops import rearrange

ROOT = pathlib.Path(__file__).resolve().parents[2]
D = ROOT / 'models-out/duality-teacher'
sys.path.insert(0, str(ROOT / 'spike/duality'))
import mel_band_roformer as mbr
from attend import Attend


def _rms(self, x, eps=1e-9):  # F.normalize clamps ||x|| at 1e-12 (0 in fp16); same maths otherwise
    return x / x.pow(2).sum(-1, keepdim=True).clamp_min(eps ** 2).sqrt() * self.scale * self.gamma


def _att(self, q, k, v):  # fp32 scores/softmax, no query blocks (identical to blocks of 128 for T <= 128 and numerically for any T)
    sim = torch.matmul(q, k.transpose(-1, -2)).float() * q.shape[-1] ** -0.5
    return torch.matmul(sim.softmax(-1).to(v.dtype), v)


mbr.RMSNorm.forward = _rms
Attend.forward = _att


def hcat(parts, dim, g=8):  # nested concat: ORT-web WebGPU has a 10 storage-buffer limit (scripts/export-roformer.py:11-14)
    while len(parts) > 1: parts = [torch.cat(parts[i:i + g], dim=dim) for i in range(0, len(parts), g)]
    return parts[0]


class Core(torch.nn.Module):  # same as export_teacher.py Core
    def __init__(s, m): super().__init__(); s.m = m

    def forward(s, x):
        bs = s.m.band_split; outs, o = [], 0
        for w, net in zip(bs.dim_inputs, bs.to_features):
            outs.append(net(x[..., o:o + w]).unsqueeze(-2)); o += w
        x = hcat(outs, -2)
        for tt, ft in s.m.layers:
            x = rearrange(x, 'b t f d -> b f t d'); b, f, t, dd = x.shape
            x = tt(x.reshape(b * f, t, dd)).reshape(b, f, t, dd)
            x = rearrange(x, 'b f t d -> b t f d').reshape(b * t, f, dd)
            x = ft(x).reshape(b, t, f, dd)
        return hcat([mlp(x[..., i, :]) for i, mlp in enumerate(s.m.mask_estimators[0].to_freqs)], -1)


def load(device='cpu', ckpt=D / 'duality_v1.ckpt'):
    cfg = yaml.unsafe_load(open(D / 'config_v1.yaml'))
    cfg['model']['flash_attn'] = False
    m = mbr.MelBandRoformer(**cfg['model'])
    sd = torch.load(ckpt, map_location='cpu', weights_only=False)  # HF card ships a pickle: trusted file only
    m.load_state_dict(sd.get('state_dict', sd), strict=True)
    return Core(m).to(device)


def _stft(core, raw):  # raw [B,2,n] -> real [B, f*s, t, 2], centred STFT as MelBandRoformer.forward
    m = core.m; b, s, n = raw.shape
    z = torch.stft(raw.reshape(b * s, n), **m.stft_kwargs, window=m.stft_window_fn().to(raw.device), return_complex=True)
    return rearrange(torch.view_as_real(z).reshape(b, s, *z.shape[1:], 2), 'b s f t c -> b (f s) t c')


def core_features(core, raw):
    st = _stft(core, raw); idx = core.m.freq_indices.to(raw.device)
    return rearrange(st[:, idx], 'b f t c -> b t (f c)'), st


def apply_masks(core, st, masks):
    """masks [B,T,Fin] from Core -> vocals waveform [B,2,n]; same maths as MelBandRoformer.forward (num_stems 1), complex mask multiply + istft."""
    m = core.m; b, _, t, _ = st.shape; idx = core.m.freq_indices.to(st.device)
    mk = rearrange(masks.to(st.dtype), 'b t (f c) -> b f t c', c=2)  # masks are bf16 under autocast; scatter in fp32
    full = torch.zeros_like(st).index_add_(1, idx, mk)  # sum over overlapping bands, as scatter_add in forward
    den = torch.zeros(st.shape[1], device=st.device).index_add_(0, idx, torch.ones(len(idx), device=st.device)).clamp_min(1e-8)
    full = full / den[None, :, None, None]
    z = torch.view_as_complex(st.contiguous()) * torch.view_as_complex(full.contiguous())
    z = rearrange(z, 'b (f s) t -> (b s) f t', s=2)
    wav = torch.istft(z, **m.stft_kwargs, window=m.stft_window_fn().to(st.device), return_complex=False, length=None)
    return rearrange(wav, '(b s) n -> b s n', s=2)
