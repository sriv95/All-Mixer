"""usage: .venv/bin/python spike/finetune/eval_mdx_ckpt.py base|CKPT.pt [...]   (run from worktree root)
last.pt (dict with 'model') or snap/best state dict; 'base' = no ckpt. Prints mean vocal SDR on 5 MUSDB test clips at T=128."""
import sys, pathlib, torch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import train_mdx as tm, mdx_torch as mt
clips = tm.load_eval(tm.MUSDB_REPO / 'test', 5)
for p in sys.argv[1:]:
    m = mt.load()
    if p != 'base':
        c = torch.load(p, map_location='cpu', weights_only=False); m.load_state_dict(c.get('model', c), strict=False)
    print(p, round(tm.eval_sdr(m, clips, [128], 'cpu'), 3), flush=True)
