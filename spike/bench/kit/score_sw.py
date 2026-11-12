# usage: score_sw.py PREFIX -> SDR per stem (same formula as sdr.py) + sum-of-stems vs mix self-check
import sys, soundfile as sf, numpy as np
P = sys.argv[1]
rd = lambda f: sf.read(f, dtype='float64')[0]
st = {k: rd(f"{P}_{k}.wav") for k in ['bass','drums','other','vocals','guitar','piano']}
mix, voc = rd('mix.wav'), rd('vocals.wav'); ins = mix - voc
def sdr(r, e):
    n = min(len(r), len(e)); r, e = r[:n], e[:n]
    return 10*np.log10((r**2).sum()/max(((r-e)**2).sum(), 1e-20))
tot = sum(st.values()); assert sdr(mix, tot) > 10, 'stems do not sum to mix'
nv = tot - st['vocals']
print(f"voc={sdr(voc,st['vocals']):.2f} drums={sdr(rd('drums.wav'),st['drums']):.2f} bass={sdr(rd('bass.wav'),st['bass']):.2f} "
      f"other={sdr(rd('other.wav'),st['other']):.2f} other+g+p={sdr(rd('other.wav'),st['other']+st['guitar']+st['piano']):.2f} "
      f"instr_sum5={sdr(ins,nv):.2f} instr_mixminusvoc={sdr(ins,mix-st['vocals']):.2f} sum6vsmix={sdr(mix,tot):.2f}")
