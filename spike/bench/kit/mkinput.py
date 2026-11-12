# usage (cwd = work dir): mkinput.py -> mix.wav + vocals.wav = concat of spike/clips/wav/00..04
import pathlib
import soundfile as sf, numpy as np
R=str(pathlib.Path(__file__).resolve().parents[3]/'spike/clips/wav')
for n in ['mix','vocals']:
    a=[sf.read(f'{R}/0{i}/{n}.wav',dtype='float32') for i in range(5)]
    print(n,[(x.shape,sr) for x,sr in a])
    sf.write(f'{n}.wav',np.concatenate([x for x,_ in a]),a[0][1],subtype='FLOAT')
