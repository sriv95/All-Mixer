"""Export MUSDB18 7 s preview clips (test subset) to float WAV: mix + stems.
Clips are for internal benchmarking only (MUSDB18 licence: research / non-commercial); never ship them."""
import pathlib, musdb, soundfile as sf
root = pathlib.Path(__file__).resolve().parents[1] / 'clips'
db = musdb.DB(root=str(root / 'musdb7'), download=True, subsets='test')
out = root / 'wav'
for i, t in enumerate(db):
    d = out / f'{i:02d}'
    d.mkdir(parents=True, exist_ok=True)
    sf.write(d / 'mix.wav', t.audio, t.rate, subtype='FLOAT')
    for name in ('vocals', 'drums', 'bass', 'other', 'accompaniment'):
        sf.write(d / f'{name}.wav', t.targets[name].audio, t.rate, subtype='FLOAT')
    (d / 'name.txt').write_text(t.name)
print('exported', len(db))
