"""kara2 (LeadBackingRoformer, lab 6daf2f3) as a trainable torch module (fine-tune spike, stage s0a).
  load(device) -> model (weights: models-out/kara2, strict, same as spike/duality/export_kara2.py)
  freeze(m) -> (trainable, total) param counts; trains trunk + vocals head (mask_estimators[0]), freezes split_estimator (backing head)
  vocals(m, raw[B,2,n]) -> vocals waveform [B,2,n] (differentiable); frames_to_samples(228) -> 100107"""
import pathlib, sys
import torch, yaml
from safetensors.torch import load_file

ROOT = pathlib.Path(__file__).resolve().parents[2]
K2 = ROOT / 'models-out/kara2'
sys.path.insert(0, str(ROOT / 'spike/duality'))
from lab6daf.lead_backing_roformer import LeadBackingRoformer

HOP, NFFT = 441, 2048


def load(device='cpu'):
    cfg = yaml.safe_load(open(K2 / 'config.yaml'))
    m = LeadBackingRoformer(**cfg['model'])
    m.load_state_dict(load_file(K2 / 'model.safetensors'), strict=True)
    return m.to(device)


def freeze(m):
    # Trunk + vocals head train. The backing head (split_estimator) stays frozen. Backing mask still moves because it reads
    # the trunk and shares body[:-1]/glu with the vocals head; only the vocals output is exported/used, so that is accepted.
    for n, p in m.named_parameters():
        p.requires_grad = not n.startswith('split_estimator.')
    return sum(p.numel() for p in m.parameters() if p.requires_grad), sum(p.numel() for p in m.parameters())


def vocals(m, raw):
    return m.separate(raw)['vocals']


def frames_to_samples(frames):  # eval_kara2.short_setup: CHUNK = (FRAMES-1)*HOP (centred STFT gives n/HOP+1 frames); 228 -> 100107
    return (frames - 1) * HOP
