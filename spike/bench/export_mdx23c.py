"""Export ZFTurbo MDX23C vocals (TFC-TDF v3, sdr 10.17; MIT code, weights licence unverified) to ONNX for the WebGPU harness.
STFT / iSTFT stay outside the graph (ORT Web WebGPU has no STFT op, cf. scripts/export-roformer.py:9-13).
Graph: x [1,4,4096,T] (L re, L im, R re, R im; STFT bins 0..4095 of n_fft 8192, hop 1024, center) -> vocals [1,4,4096,T] (same layout).
Shape fixed (InstanceNorm stats depend on T; T must be divisible by 32). chunk samples = (T-1)*1024.
  .venv/bin/python -I spike/bench/export_mdx23c.py [T=128] [--fp16]  -> spike/ml/models/mdx23c_t<T>[_fp16].onnx (+ -meta.json)
Pinned training repo + weights go to .cache/cands/mdx23c (pattern of scripts/export-scnet.py:26-29)."""
import json, pathlib, subprocess, sys, types
import numpy as np, torch, yaml, onnx, onnxruntime as ort

ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE = pathlib.Path(__import__('os').environ.get('MDX_CACHE', ROOT / '.cache/cands/mdx23c'))  # set MDX_CACHE when run from a worktree
COMMIT = '6fdad13686bb7e84d029ec66f9dbe76e65c93ebf'
OUT = pathlib.Path(__file__).resolve().parents[1] / 'ml/models'
NFFT, HOP, BINS = 8192, 1024, 4096


def load():
    src = CACHE / 'msst'
    if not src.exists():
        subprocess.run(['git', 'init', '-q', str(src)], check=True)
        subprocess.run(['git', '-C', str(src), 'fetch', '-q', '--depth', '1', 'https://github.com/ZFTurbo/Music-Source-Separation-Training', COMMIT], check=True)
        subprocess.run(['git', '-C', str(src), 'checkout', '-q', 'FETCH_HEAD'], check=True)
    sys.path.insert(0, str(src))
    mu = types.ModuleType('utils.model_utils')  # the real one pulls ml_collections, tqdm...; only this helper is used
    mu.prefer_target_instrument = lambda c: c.training.instruments
    sys.modules['utils'] = types.ModuleType('utils'); sys.modules['utils.model_utils'] = mu
    from models.mdx23c_tfc_tdf_v3 import TFC_TDF_net
    def ns(d): return types.SimpleNamespace(**{k: ns(v) if isinstance(v, dict) else v for k, v in d.items()})
    cfg = ns(yaml.safe_load(open(CACHE / 'config_vocals_mdx23c.yaml')))
    m = TFC_TDF_net(cfg)
    sd = torch.load(CACHE / 'model_vocals_mdx23c_sdr_10.17.ckpt', map_location='cpu', weights_only=True)
    m.load_state_dict(sd.get('state_dict', sd)); m.eval()
    assert cfg.training.instruments[0] == 'vocals'  # output stem 0 (reshape b, n_instr, ...)
    return m


class Core(torch.nn.Module):
    """TFC_TDF_net.forward between stft and stft.inverse, vocals stem only."""
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, x):
        m = s.m
        mix = x = m.cac2cws(x)
        fc = x = m.first_conv(x)
        x = x.transpose(-1, -2)
        enc = []
        for b in m.encoder_blocks:
            x = b.tfc_tdf(x); enc.append(x); x = b.downscale(x)
        x = m.bottleneck_block(x)
        for b in m.decoder_blocks:
            x = b.upscale(x); x = torch.cat([x, enc.pop()], 1); x = b.tfc_tdf(x)
        x = x.transpose(-1, -2) * fc
        x = m.cws2cac(m.final_conv(torch.cat([mix, x], 1)))  # [1, 2 stems * 4, F, T]
        return x[:, :4]


def main():
    T = int(next((a for a in sys.argv[1:] if a.isdigit()), 128)); fp16 = '--fp16' in sys.argv
    assert T % 32 == 0
    name = f'mdx23c_t{T}' + ('_fp16' if fp16 else '')
    OUT.mkdir(parents=True, exist_ok=True)
    core = Core(load()).eval()
    fp32 = OUT / f'mdx23c_t{T}.onnx'
    if not fp32.exists():
        torch.onnx.export(core, torch.randn(1, 4, BINS, T), str(fp32), input_names=['spec'], output_names=['vocals'], opset_version=17, dynamo=False)
        # fold external data into one file
        m = onnx.load(str(fp32)); onnx.save(m, str(fp32), save_as_external_data=False)
        print('fp32', fp32.stat().st_size)
    if fp16:
        from onnxruntime.transformers.float16 import convert_float_to_float16
        m = convert_float_to_float16(onnx.load(str(fp32)), keep_io_types=True)
        onnx.save(m, str(OUT / f'{name}.onnx')); print('fp16', (OUT / f'{name}.onnx').stat().st_size)
    ops = sorted({n.op_type for n in onnx.load(str(fp32)).graph.node}); print('ops', ops)
    meta = {'adapter': 'stft_outside', 'sr': 44100, 'n_fft': NFFT, 'hop': HOP, 'win': 'hann', 'frames': T, 'bins': BINS, 'layout': 'mdx',
            'out_kind': 'complex', 'out_stem': 'vocals', 'compensate': 1.0, 'dtype': 'fp32'}  # fp16 graph keeps fp32 io (keep_io_types)
    (OUT / f'{name}-meta.json').write_text(json.dumps(meta, separators=(',', ':')))


if __name__ == '__main__':
    main()
