"""Default model (MDX-Net 9482, models-out/compat-mdx.onnx FP32) as a trainable torch nn.Module via onnx2torch.
  load(path) -> nn.Module, input [B,4,2048,T] float32 (Lre,Lim,Rre,Rim; bins 0..2047), output same shape. compensate = 1.
  T is dynamic in the ONNX (dim 'T') but the U-Net needs T a multiple of 32 (src/ml/mdx-plan.ts MDX_T_STEP): app uses 64..256.
  separate(fn, mix[2,n], T) = app pipeline (src/ml/mdx.ts MdxStream): n_fft 4096, hop 1024, periodic Hann, no centre pad,
  segment N=(T-1)*1024+4096, 50 % overlap, Hann cross-fade, iSTFT / sum(w^2). fn maps [1,4,2048,T] tensor -> same.
BatchNorm stays in eval mode and frozen, even after .train()."""
import pathlib, torch, onnx
from onnx2torch import convert

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / 'models-out/compat-mdx.onnx'
NFFT, HOP, BINS, COMP = 4096, 1024, 2048, 1.0
WIN = torch.hann_window(NFFT, dtype=torch.float64)


def load(path=SRC):
    m = convert(onnx.load(str(path)))
    for p in m.parameters(): p.requires_grad_(True)
    for mod in m.modules():
        if isinstance(mod, torch.nn.modules.batchnorm._BatchNorm):
            for p in mod.parameters(): p.requires_grad_(False)
    return _freeze_bn(m)


def _freeze_bn(m):
    base = type(m).train
    def train(self, mode=True):
        base(self, mode)
        for mod in self.modules():
            if isinstance(mod, torch.nn.modules.batchnorm._BatchNorm): mod.eval()
        return self
    m.train = train.__get__(m)
    return m


def trainable_state_dict(m):  # params with requires_grad only (BN stats/affine stay from the ONNX)
    names = {n for n, p in m.named_parameters() if p.requires_grad}
    return {k: v.detach().cpu() for k, v in m.state_dict().items() if k in names}


def save(m, path): torch.save(trainable_state_dict(m), path)


def load_trained(path, base=SRC):
    m = load(base); m.load_state_dict(torch.load(path, map_location='cpu'), strict=False); return m


def export_onnx(m, path, T=64):
    m = m.eval().cpu()
    torch.onnx.export(m, torch.zeros(1, 4, BINS, T), str(path), input_names=['input'], output_names=['output'], opset_version=17,
                      dynamic_axes={'input': {0: 'batch_size', 3: 'T'}, 'output': {0: 'batch_size', 3: 'T'}})
    # TODO: untested; check with onnxruntime parity (parity_mdx.py) and FP16 conversion as the shipped public/ml/mdx.onnx before use.


@torch.no_grad()
def separate(fn, mix, T, dev='cpu'):  # mix [2, n] float32 numpy -> [2, n] float32 numpy
    import numpy as np
    N = (T - 1) * HOP + NFFT; H = N // 2; n = mix.shape[1]
    nb = -(-n // H) + 1
    x = torch.from_numpy(np.concatenate([np.zeros((2, H)), mix, np.zeros((2, (nb + 1) * H - n))], 1)).double()
    env = torch.zeros(N, dtype=torch.float64)
    for t in range(T): env[t * HOP:t * HOP + NFFT] += WIN ** 2
    wgt = torch.where(env > 1e-10, 1 / env, torch.ones_like(env)) * (0.5 - 0.5 * torch.cos(2 * torch.pi * torch.arange(N, dtype=torch.float64) / N))
    out = torch.zeros(2, (nb + 1) * H, dtype=torch.float64)
    for b in range(nb):
        fr = x[:, b * H:b * H + N].unfold(1, NFFT, HOP)[:, :T] * WIN
        s = torch.fft.rfft(fr, dim=-1)[..., :BINS].permute(0, 2, 1)
        inp = torch.stack([s[0].real, s[0].imag, s[1].real, s[1].imag])[None].float()
        y = fn(inp)[0].double().cpu() * COMP
        c = torch.zeros(2, NFFT // 2 + 1, T, dtype=torch.complex128)
        c[0, :BINS] = torch.complex(y[0], y[1]); c[1, :BINS] = torch.complex(y[2], y[3])
        w = torch.fft.irfft(c.permute(0, 2, 1), n=NFFT, dim=-1) * WIN
        acc = torch.zeros(2, N, dtype=torch.float64)
        for t in range(T): acc[:, t * HOP:t * HOP + NFFT] += w[:, t]
        out[:, b * H:b * H + N] += acc * wgt
    return out[:, H:H + n].float().numpy()
