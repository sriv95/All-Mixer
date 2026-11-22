"""Fine-tuned kara2 checkpoint -> fp16 ONNX core: spike/duality/export_kara2.py (run unchanged, its load_file patched to return the ckpt state_dict) then to_fp16.py --clamp-fill.
  .venv/bin/python -I spike/finetune/export_kara2_ft.py --ckpt ft.pt --out kara2_ft_fp16.onnx     (fp32 intermediate: <out>.fp32.onnx, kept)
--ckpt: torch.save dict, key 'model' = state_dict (a bare state_dict also works). Needs models-out/kara2/config.yaml (export_kara2.py default cache dir)."""
import argparse, pathlib, runpy, subprocess, sys
import torch, safetensors.torch as st

ROOT = pathlib.Path(__file__).resolve().parents[2]; DUAL = ROOT / 'spike/duality'
ap = argparse.ArgumentParser(); ap.add_argument('--ckpt', required=True); ap.add_argument('--out', required=True); a = ap.parse_args()
ck = torch.load(a.ckpt, map_location='cpu', weights_only=False); sd = ck.get('model', ck)
st.load_file = lambda *_a, **_k: sd  # export_kara2.py does `from safetensors.torch import load_file` at run time
fp32 = a.out + '.fp32.onnx'
sys.argv = ['export_kara2.py', str(ROOT / 'models-out/kara2'), fp32]
runpy.run_path(str(DUAL / 'export_kara2.py'), run_name='__main__')
subprocess.run([sys.executable, str(DUAL / 'to_fp16.py'), fp32, a.out, '--clamp-fill'], check=True)
print('wrote', a.out)
