# usage: sdr.py ref.wav est.wav  -> whole-signal stereo SDR (dB)
import sys, soundfile as sf, numpy as np
r,_=sf.read(sys.argv[1],dtype='float64'); e,_=sf.read(sys.argv[2],dtype='float64')
n=min(len(r),len(e)); r,e=r[:n],e[:n]
print(f"SDR {10*np.log10((r**2).sum()/max(((r-e)**2).sum(),1e-20)):.2f} dB")
