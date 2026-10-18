"""Export the drum split model for the extension (Advanced > Split instrumental): SCNet Tran Small from ZFTurbo's
Music-Source-Separation-Training (MIT code; the checkpoint carries no license of its own, check before you upload it).
Writes models-out/drums.onnx. It is not part of the extension build: `bun run model-manifest drums=1` prepares it for
upload to the Hugging Face repo that the extension downloads from (src/shared/model-store.ts).

The graph is the SCNet body only, between torch.stft and torch.istft of SCNet_Tran.forward; both run in JS
(src/ml/scnet.ts). It takes the STFT of a stereo chunk of 128 frames, x [1, 4, 2049, 128] with the channels
(L re, L im, R re, R im), and returns the drums in the same layout (the other three stems are cut off). The shape is
fixed: 128 frames = 129772 samples. The model is trained on 11 s; at 3 s it loses about 1 dB of drums SDR on MUSDB
(9.3 -> 8.3 dB, spike/bench/drums_bench.py) and is about 4x cheaper per second of audio.

Two rewrites keep the graph inside WebGPU limits: the rfft / irfft over time in FeatureConversion are matmuls with
DFT matrices (ORT WebGPU has no FFT), and RMSNorm is the NaN-safe form of scripts/export-roformer.py. It stays fp32:
the fp16 conversion of this graph overflows (the attention / norm path), and it is only 41 MB.

Needs python with: torch einops rotary-embedding-torch pyyaml onnx onnxruntime soundfile (uv sync); git.
  bun run export-scnet [--force]
The checkpoint, config and the training repo (pinned) are downloaded into .cache/drums (SHA-256 checked).
"""
import argparse, hashlib, pathlib, subprocess, sys, urllib.request
import numpy as np, torch, yaml, onnx, onnxruntime as ort

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache/drums'
REPO = 'https://github.com/ZFTurbo/Music-Source-Separation-Training'
REPO_COMMIT = '6fdad13686bb7e84d029ec66f9dbe76e65c93ebf'
REL = f'{REPO}/releases/download/v1.0.14'
CKPT = ('model_scnet_tran_sdr_8.9272.ckpt', '253882ba7222fd07bad164044b9b0d980a39bbb3e243be64d748244aff8fd4ef')
CONFIG = ('config_musdb18_scnet_tran.yaml', 'd5f74af205d8b0f8d9daf9ac7f62bdba0d7b3c40ee108d7a54830090c7218fe5')
FRAMES = 128  # SC_FRAMES in src/ml/scnet.ts
BINS = 2049


def fetch(url, dst, sha=None):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        print('downloading', url)
        urllib.request.urlretrieve(url, dst)
    if sha and hashlib.sha256(dst.read_bytes()).hexdigest() != sha:
        sys.exit(f'{dst}: SHA-256 mismatch')
    return dst


def clone():
    src = CACHE / 'msst'
    if not src.exists():
        subprocess.run(['git', 'init', '-q', str(src)], check=True)
        subprocess.run(['git', '-C', str(src), 'fetch', '-q', '--depth', '1', REPO, REPO_COMMIT], check=True)
        subprocess.run(['git', '-C', str(src), 'checkout', '-q', 'FETCH_HEAD'], check=True)
    sys.path.insert(0, str(src))
    return src


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    out = ROOT / 'models-out/drums.onnx'
    if out.exists() and not a.force:
        print('drums already exported (--force to redo)')
        return
    clone()
    import models.scnet.scnet_tran as tran
    ckpt = fetch(f'{REL}/{CKPT[0]}', CACHE / CKPT[0], CKPT[1])
    cfg = yaml.unsafe_load(open(fetch(f'{REL}/{CONFIG[0]}', CACHE / CONFIG[0], CONFIG[1])))['model']  # the file has python/tuple tags; its hash is pinned

    def dft_fc(self, x):
        # torch.fft.rfft / irfft (norm="ortho") over the last axis as matmuls
        t = 2 * (x.shape[-1] - 1) if self.inverse else x.shape[-1]
        n = torch.arange(t, dtype=torch.float32)
        if self.inverse:
            k = torch.arange(t // 2 + 1, dtype=torch.float32)[:, None]
            w = torch.full((t // 2 + 1, 1), 2.0)
            w[0] = 1.0
            w[-1] = 1.0
            ang = 2 * np.pi * k * n[None] / t
            h = self.channels // 2
            return x[:, :h].float() @ (w * torch.cos(ang) / t ** 0.5) + x[:, h:].float() @ (-w * torch.sin(ang) / t ** 0.5)
        k = torch.arange(t // 2 + 1, dtype=torch.float32)
        ang = 2 * np.pi * n[:, None] * k[None] / t
        x = x.float()
        return torch.cat([x @ (torch.cos(ang) / t ** 0.5), x @ (-torch.sin(ang) / t ** 0.5)], dim=1)

    def rms_norm(self, x):
        # F.normalize(x) * sqrt(d) * gamma, scaled by the largest element first so fp16 / silent bands cannot give NaN
        y = x / x.abs().amax(dim=-1, keepdim=True).clamp_min(1e-3)
        return y / y.pow(2).sum(dim=-1, keepdim=True).sqrt().clamp_min(1.0) * self.scale * self.gamma

    tran.FeatureConversion.forward = dft_fc
    tran.RMSNorm.forward = rms_norm
    m = tran.SCNet_Tran(**cfg)
    sd = torch.load(ckpt, map_location='cpu', weights_only=False)
    print(m.load_state_dict(sd.get('state_dict', sd) if isinstance(sd, dict) else sd, strict=True))
    m.eval()

    class Body(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.m = m  # a submodule, so the exporter sees the weights as parameters

        def forward(self, x):
            m = self.m
            skips, lens, olens = [], [], []
            for sd_layer in m.encoder:
                x, s, l, o = sd_layer(x)
                skips.append(s); lens.append(l); olens.append(o)
            x = m.separation_net(x)
            for fusion, su in m.decoder:
                x = su(fusion(x, skips.pop()), lens.pop(), olens.pop())
            return x[:, :4]  # drums = source 0 = the first 4 of the 16 output channels

    body = Body().eval()
    x = torch.randn(1, 4, BINS, FRAMES) * 0.1
    out.parent.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        ref = body(x).numpy()
        torch.onnx.export(body, (x,), str(out), input_names=['x'], output_names=['y'], opset_version=18, dynamo=False)
    got = ort.InferenceSession(str(out), providers=['CPUExecutionProvider']).run(None, {'x': x.numpy()})[0]
    diff = float(np.abs(got - ref).max())
    print('onnx vs torch: max abs diff', diff, 'mean |ref|', float(np.abs(ref).mean()))
    assert diff < 1e-2, 'exported graph does not match torch'
    print('ops:', sorted({n.op_type for n in onnx.load(out).graph.node}))
    print('wrote', out, out.stat().st_size // 2**20, 'MiB')


if __name__ == '__main__':
    main()
