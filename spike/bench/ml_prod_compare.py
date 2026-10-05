"""Browser (ml_prod) vs native (spl_h4l2_single) on one clip, metrics from metrics.py.
Usage: python ml_prod_compare.py [clip=00] [native_tag=spl_h4l2_single]  -> merges into results/ml_prod_quality.json[compare_<tag>]"""
import json, pathlib, sys
import numpy as np, soundfile as sf
from scipy.signal import correlate
import metrics as M

clip = sys.argv[1] if len(sys.argv) > 1 else '00'
d = M.ROOT / clip
stems = [sf.read(d / f'{s}.wav')[0] for s in M.STEMS]
acc, sr = sf.read(d / 'accompaniment.wav')

def clip_metrics(tag):
    inst = sf.read(d / tag / 'instrumental.wav')[0]; voc = sf.read(d / tag / 'vocal.wav')[0]
    rf, rs = M.retention(inst, stems, sr, 'full'), M.retention(inst, stems, sr, 'sub')
    return {'bass_ret': rf[2], 'drums_ret': rf[1], 'kick_ret': rs[1], 'vocal_leak': rf[0],
            'sub_energy': M.energy_db(M.bandpass(inst, 20, 120, sr)[M.SKIP:-M.SKIP]) - M.energy_db(M.bandpass(acc, 20, 120, sr)[M.SKIP:-M.SKIP]),
            'sdr_inst': M.sdr(acc, inst), 'sdr_voc': M.sdr(stems[0], voc)}, voc

TAGN = sys.argv[2] if len(sys.argv) > 2 else 'spl_h4l2_single'
nat, nv = clip_metrics(TAGN)
web, wv = clip_metrics('ml_prod')
diff = {k: float(web[k] - nat[k]) for k in nat}
e = wv - nv
mono = lambda x: x.mean(1)
a, b = mono(wv), mono(nv)
cc = correlate(a, b, mode='full', method='fft')
lags = np.arange(-len(b) + 1, len(a))
sel = np.abs(lags) <= 8192
best = int(lags[sel][np.argmax(cc[sel])])  # >0: browser is later than native
res = {
    'native_clip': {k: round(float(v), 2) for k, v in nat.items()},
    'browser_clip': {k: round(float(v), 2) for k, v in web.items()},
    'diff_dB': {k: round(v, 3) for k, v in diff.items()},
    'max_abs_diff_dB': round(max(abs(v) for v in diff.values()), 3),
    'vocal_max_abs_diff': float(np.abs(e).max()), 'vocal_rms_diff': float(np.sqrt((e ** 2).mean())),
    'vocal_rms_native': float(np.sqrt((nv ** 2).mean())),
    'vocal_diff_rms_rel_db': float(20 * np.log10(np.sqrt((e ** 2).mean()) / np.sqrt((nv ** 2).mean()))),
    'vocal_max_abs_native': float(np.abs(nv).max()),
    'best_lag_samples': best, 'best_lag_xcorr_norm': float(cc[sel].max() / np.sqrt((a ** 2).sum() * (b ** 2).sum())),
}
p = pathlib.Path(__file__).parent / 'results/ml_prod_quality.json'
j = json.loads(p.read_text()); j['compare_' + TAGN] = res; j.pop('compare', None); p.write_text(json.dumps(j, indent=1))
print(json.dumps(res, indent=1))
