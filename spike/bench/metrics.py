"""Separation quality metrics on the MUSDB clips.

For an output Y (instrumental = Karaoke, or vocal = A cappella) we fit, per band,
Y ~= sum_j g_j * stem_j by least squares. 20*log10(g_j) is the stem *retention* in dB:
0 dB = stem passes at full level, -inf = removed. This works for linear masks and ML alike.

Reported (median over clips):
  bass_ret, drums_ret      retention of bass / drums stems in the Karaoke output (want ~0 dB)
  kick_ret                 drums retention in the 20-120 Hz band (kick fundamental)
  vocal_leak               vocals retention in the Karaoke output (want very negative)
  sub_energy               Karaoke vs. true accompaniment energy, 20-120 Hz (dB)
  sdr_inst, sdr_voc        simple SDR vs. accompaniment / vocals stems (dB, higher better)
  acap_drums/bass/other    retention of those stems in vocal.wav (A cappella leak, want very negative)
  acap_music               energy of vocal.wav - g_v*vocals relative to vocal.wav (dB, want low)
  acap_interf              true music energy in vocal.wav: sum_k ||g_k s_k||^2 (drums,bass,other) / ||vocal.wav||^2 (dB)
  acap_artif               residual of the 4-stem fit ||vb - A g||^2 / ||vb||^2 (dB): distortion that is neither vocal nor stem
  acap_gap_leak            energy(vocal.wav)/energy(mix) (dB) pooled over 1 s windows where true vocals are < -30 dB below the clip's mean window energy (NaN if none)
  acap_gap_leak_q          same, 0.25 s windows; gap = true vocals window < -20 dB below the median of voiced windows (voiced = above the 30th percentile of window energy). gap_clips_q = clips with a gap
  acap_voc_ret             vocals retention in vocal.wav (want ~0 dB)
  kara_sir, kara_sar       framewise BSS-eval v4 (museval, 1 s windows, median over windows then clips) of the Karaoke output vs. accompaniment, interferer = vocals
  acap_sir, acap_sar       same for vocal.wav vs. vocals, interferer = accompaniment (SIR higher = less music, SAR higher = fewer artifacts)
  kara_buzz                energy of (inst_est - accompaniment) in 1-8 kHz relative to accompaniment energy there, 0.25 s windows, median (dB, lower = cleaner)
  acap_hf_ret/mid_ret/low_ret  retention of the true vocal in vocal.wav, 2-8 kHz / 300-2000 Hz / < 300 Hz (g of vb ~= g * vocals_band, dB; 0 = full)
Usage: python metrics.py <tag> [<tag> ...]
"""
import json, pathlib, sys, warnings
from concurrent.futures import ProcessPoolExecutor
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfiltfilt

ROOT = pathlib.Path(__file__).resolve().parents[1] / 'clips' / 'wav'
STEMS = ('vocals', 'drums', 'bass', 'other')
BANDS = {'full': (20, 16000), 'sub': (20, 120), 'low': (120, 500), 'mid': (500, 4000), 'high': (4000, 16000)}
SKIP = 4096  # ignore edges (STFT warm-up)

def bandpass(x, lo, hi, sr):
    sos = butter(4, [lo, hi], btype='band', fs=sr, output='sos')
    return sosfiltfilt(sos, x, axis=0)

def fit(y, stems, sr, band):
    """Joint least-squares fit y ~= A g. Returns (g, yb, A); inactive stems have g = nan."""
    lo, hi = BANDS[band]
    yb = bandpass(y, lo, hi, sr)[SKIP:-SKIP].reshape(-1)
    A = np.stack([bandpass(s, lo, hi, sr)[SKIP:-SKIP].reshape(-1) for s in stems], axis=1)
    active = (A ** 2).sum(0) > 1e-3 * max((A ** 2).sum(0).max(), 1e-12)
    g = np.full(len(stems), np.nan)
    if active.any():
        g[active] = np.linalg.lstsq(A[:, active], yb, rcond=None)[0]
    return g, yb, A

def retention(y, stems, sr, band):
    g = fit(y, stems, sr, band)[0]
    return 20 * np.log10(np.maximum(np.abs(g), 1e-4))

def energy_db(x):
    return 10 * np.log10((x ** 2).sum() + 1e-12)

def gap_leak(voc_true, voc_est, mix, sr, win_s=1.0, thr_db=-30):
    w = int(sr * win_s); n = len(voc_true) // w
    ev = np.array([(voc_true[i * w:(i + 1) * w] ** 2).sum() for i in range(n)])
    gap = ev < ev.mean() * 10 ** (thr_db / 10)
    if not gap.any():
        return np.nan
    sel = lambda x: sum((x[i * w:(i + 1) * w] ** 2).sum() for i in np.flatnonzero(gap))
    return 10 * np.log10((sel(voc_est) + 1e-12) / (sel(mix) + 1e-12))

def gap_leak_q(voc_true, voc_est, mix, sr, win_s=0.25, thr_db=-20):
    w = int(sr * win_s); n = len(voc_true) // w
    ev = np.array([(voc_true[i * w:(i + 1) * w] ** 2).sum() for i in range(n)])
    voiced = ev[ev > np.percentile(ev, 30)]
    if not len(voiced):
        return np.nan
    gap = ev < np.median(voiced) * 10 ** (thr_db / 10)
    if not gap.any():
        return np.nan
    sel = lambda x: sum((x[i * w:(i + 1) * w] ** 2).sum() for i in np.flatnonzero(gap))
    return 10 * np.log10((sel(voc_est) + 1e-12) / (sel(mix) + 1e-12))

def sdr(ref, est):
    ref, est = ref[SKIP:-SKIP], est[SKIP:-SKIP]
    return 10 * np.log10((ref ** 2).sum() / (((ref - est) ** 2).sum() + 1e-12) + 1e-12)

def bss_median(ref_a, ref_b, est_a, sr):
    """Framewise BSS-eval v4 (museval) for source a vs interferer b; returns (median SIR, median SAR) over 1 s windows."""
    import museval
    n = min(len(ref_a), len(est_a))
    refs = np.stack([ref_a[:n], ref_b[:n]]); ests = np.stack([est_a[:n], ref_a[:n] + ref_b[:n] - est_a[:n]])
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        sdr_, isr_, sir_, sar_, _perm = museval.metrics.bss_eval(refs, ests, window=sr, hop=sr, compute_permutation=False)
    return float(np.nanmedian(sir_[0])), float(np.nanmedian(sar_[0]))

def buzz(inst, acc, sr, win_s=0.25):
    e = bandpass(inst - acc, 1000, 8000, sr); r = bandpass(acc, 1000, 8000, sr)
    w = int(sr * win_s); n = len(acc) // w
    v = [10 * np.log10(((e[i * w:(i + 1) * w] ** 2).sum() + 1e-12) / ((r[i * w:(i + 1) * w] ** 2).sum() + 1e-12)) for i in range(n)
         if (r[i * w:(i + 1) * w] ** 2).sum() > 1e-8]
    return float(np.median(v)) if v else np.nan

def band_ret(voc, voc_true, sr, lo, hi):
    a, b = (bandpass(z, lo, hi, sr)[SKIP:-SKIP].reshape(-1) for z in (voc, voc_true))
    return 20 * np.log10(max(abs((a @ b) / (b @ b + 1e-12)), 1e-4))

def clip_extra(d, tag):
    stems = {s: sf.read(d / f'{s}.wav')[0] for s in STEMS}
    acc, sr = sf.read(d / 'accompaniment.wav')
    inst = sf.read(d / tag / 'instrumental.wav')[0]; voc = sf.read(d / tag / 'vocal.wav')[0]
    has_voc = energy_db(stems['vocals']) - energy_db(acc) > -20
    ks, ka = bss_median(acc, stems['vocals'], inst, sr) if has_voc else (np.nan, np.nan)
    as_, aa = bss_median(stems['vocals'], acc, voc, sr) if has_voc else (np.nan, np.nan)
    v = stems['vocals']
    return {'kara_sir': ks, 'kara_sar': ka, 'acap_sir': as_, 'acap_sar': aa, 'kara_buzz': buzz(inst, acc, sr),
            'acap_hf_ret': band_ret(voc, v, sr, 2000, 8000) if has_voc else np.nan,
            'acap_mid_ret': band_ret(voc, v, sr, 300, 2000) if has_voc else np.nan,
            'acap_low_ret': band_ret(voc, v, sr, 40, 300) if has_voc else np.nan}

def _extra(args):
    return clip_extra(*args)

def evaluate(tag):
    rows = []
    for d in sorted(p for p in ROOT.iterdir() if (p / tag / 'instrumental.wav').exists()):
        stems = [sf.read(d / f'{s}.wav')[0] for s in STEMS]
        acc, sr = sf.read(d / 'accompaniment.wav')
        inst = sf.read(d / tag / 'instrumental.wav')[0]
        voc = sf.read(d / tag / 'vocal.wav')[0]
        has_voc = energy_db(stems[0]) - energy_db(acc) > -20
        r_full = retention(inst, stems, sr, 'full')
        r_sub = retention(inst, stems, sr, 'sub')
        ra = retention(voc, stems, sr, 'full')
        g, vfit, A = fit(voc, stems, sr, 'full')
        g0 = np.nan_to_num(g)
        e_vb = (vfit ** 2).sum() + 1e-12
        interf = 10 * np.log10((((A[:, 1:] * g0[1:]) ** 2).sum()) / e_vb + 1e-12)
        artif = 10 * np.log10(((vfit - A @ g0) ** 2).sum() / e_vb + 1e-12)
        vb, sb = (bandpass(z, *BANDS['full'], sr)[SKIP:-SKIP].reshape(-1) for z in (voc, stems[0]))
        gv = (vb @ sb) / ((sb @ sb) + 1e-12)
        rows.append({
            'acap_drums': ra[1] if has_voc else np.nan, 'acap_bass': ra[2] if has_voc else np.nan,
            'acap_other': ra[3] if has_voc else np.nan, 'acap_voc_ret': ra[0] if has_voc else np.nan,
            'acap_interf': interf if has_voc else np.nan, 'acap_artif': artif if has_voc else np.nan,
            'acap_music': energy_db(vb - gv * sb) - energy_db(vb) if has_voc else np.nan,
            'acap_gap_leak': gap_leak(stems[0], voc, sf.read(d / 'mix.wav')[0], sr),
            'acap_gap_leak_q': gap_leak_q(stems[0], voc, sf.read(d / 'mix.wav')[0], sr),
            'clip': d.name,
            'bass_ret': r_full[2], 'drums_ret': r_full[1], 'kick_ret': r_sub[1],
            'vocal_leak': r_full[0] if has_voc else np.nan,
            'sub_energy': energy_db(bandpass(inst, 20, 120, sr)[SKIP:-SKIP]) - energy_db(bandpass(acc, 20, 120, sr)[SKIP:-SKIP]),
            'sdr_inst': sdr(acc, inst),
            'sdr_voc': sdr(stems[0], voc) if has_voc else np.nan,
        })
    dirs = sorted(p for p in ROOT.iterdir() if (p / tag / 'instrumental.wav').exists())
    with ProcessPoolExecutor() as ex:
        for r, x in zip(rows, ex.map(_extra, [(d, tag) for d in dirs])):
            r.update(x)
    pc = ROOT.parents[1] / 'bench/results/perclip'
    if pc.is_dir():  # per-clip vocal_leak, for 'clips at or below c0' counts
        json.dump({r['clip']: (None if np.isnan(r['vocal_leak']) else float(r['vocal_leak'])) for r in rows}, open(pc / f'{tag}.json', 'w'))
    keys = [k for k in rows[0] if k != 'clip']
    summary = {k: round(float(np.nanmedian([r[k] for r in rows])), 2) for k in keys}
    summary['p10_bass_ret'] = round(float(np.nanpercentile([r['bass_ret'] for r in rows], 10)), 2)
    summary['p10_drums_ret'] = round(float(np.nanpercentile([r['drums_ret'] for r in rows], 10)), 2)
    summary['gap_clips'] = int(np.sum(~np.isnan([r['acap_gap_leak'] for r in rows])))
    summary['gap_clips_q'] = int(np.sum(~np.isnan([r['acap_gap_leak_q'] for r in rows])))
    summary['clips'] = len(rows)
    return summary

if __name__ == '__main__':
    for tag in sys.argv[1:]:
        print(json.dumps({'tag': tag, **evaluate(tag)}))
