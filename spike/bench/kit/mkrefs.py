# usage (cwd = work dir, after mkinput.py): mkrefs.py -> drums/bass/other.wav (concat of 00..04) + instr.wav = mix - vocals
import pathlib
import soundfile as sf, numpy as np
R=str(pathlib.Path(__file__).resolve().parents[3]/'spike/clips/wav')
for n in ['drums','bass','other']:
    a=[sf.read(f'{R}/0{i}/{n}.wav',dtype='float32') for i in range(5)]
    sf.write(f'{n}.wav',np.concatenate([x for x,_ in a]),a[0][1],subtype='FLOAT')
m,sr=sf.read('mix.wav',dtype='float32');v,_=sf.read('vocals.wav',dtype='float32')
sf.write('instr.wav',m-v,sr,subtype='FLOAT')
