"""Kim Vocal 2 (UVR MDX-Net) for the shared WebGPU harness: verify weights, CPU-check dim_t variants + SDR on clips, fp16, write meta.
  /Users/.../.venv/bin/python -I spike/bench/export_kim2.py <clips_dir> [n_clips]
UVR pipeline (python-audio-separator / UVR mdx): stft n_fft 7680 hop 1024 periodic Hann center=True, bins 0..3071 as [Lre,Lim,Rre,Rim],
chunk = hop*(T-1) samples, trim n_fft/2 each side, output * compensate (1.009), vocal = primary stem."""
import hashlib, json, pathlib, sys
import numpy as np, onnx, onnxruntime as ort, soundfile as sf, torch

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / '.cache/cands/Kim_Vocal_2.onnx'
NFFT, HOP, BINS, COMP, SR = 7680, 1024, 3072, 1.009, 44100
OUTD = ROOT / 'spike/ml/models'
win = torch.hann_window(NFFT)

def uvr_hash(p):  # UVR model_data.json key: md5 of the last 10 MB
    f = open(p, 'rb'); f.seek(-10000 * 1024, 2); return hashlib.md5(f.read()).hexdigest()

def sep(sess, mix, T, comp=COMP):  # mix [2, n] float32 -> vocal [2, n]
    trim = NFFT // 2; chunk = HOP * (T - 1); gen = chunk - 2 * trim; n = mix.shape[1]
    pad = gen - n % gen
    m = np.concatenate([np.zeros((2, trim)), mix, np.zeros((2, pad + trim))], 1).astype(np.float32)
    out = []
    for i in range(0, n + pad, gen):
        seg = torch.from_numpy(m[:, i:i + chunk])
        s = torch.stft(seg, NFFT, HOP, window=win, center=True, return_complex=True)  # [2, 3841, T]
        x = torch.view_as_real(s).permute(0, 3, 1, 2).reshape(4, 3841, T)[:, :BINS][None].numpy()
        y = torch.from_numpy(sess.run(None, {'input': x.astype(np.float32)})[0][0])
        y = torch.cat([y, torch.zeros(4, 3841 - BINS, T)], 1).reshape(2, 2, 3841, T).permute(0, 2, 3, 1).contiguous()
        w = torch.istft(torch.view_as_complex(y), NFFT, HOP, window=win, center=True, length=chunk)
        out.append(w[:, trim:-trim].numpy() * comp)
    return np.concatenate(out, 1)[:, :n]

def sdr(ref, est): return 10 * np.log10((ref ** 2).sum() / (((ref - est) ** 2).sum() + 1e-12))

if __name__ == '__main__':
    assert hashlib.md5(open(SRC, 'rb').read()).hexdigest() == 'fa29b9d118ba4ad14a000254a60114b8'
    print('uvr hash', uvr_hash(SRC))
    clips = sorted((pathlib.Path(sys.argv[1])).iterdir())[:int(sys.argv[2]) if len(sys.argv) > 2 else 3]
    # attempt 1: make the frames axis dynamic (convs + freq-axis MatMuls only, no Reshape), drop stale value_info
    m = onnx.load(SRC)
    for t in list(m.graph.input) + list(m.graph.output): t.type.tensor_type.shape.dim[3].dim_param = 'frames'
    del m.graph.value_info[:]
    OUTD.mkdir(parents=True, exist_ok=True); onnx.save(m, OUTD / 'kim2.onnx')
    from onnxruntime.transformers.float16 import convert_float_to_float16
    onnx.save(convert_float_to_float16(m, keep_io_types=True), OUTD / 'kim2_fp16.onnx')
    for T in (256, 64):
        sess = ort.InferenceSession(str(OUTD / ('kim2_fp16.onnx' if len(sys.argv) > 3 else 'kim2.onnx')), providers=['CPUExecutionProvider'])
        r = []
        for c in clips:
            mix, sr = sf.read(c / 'mix.wav', dtype='float32'); voc, _ = sf.read(c / 'vocals.wav', dtype='float32')
            assert sr == SR
            est = sep(sess, mix.T, T)
            r.append(sdr(voc.T, est)); 
        print('T', T, 'chunk s', HOP * (T - 1) / SR, 'SDR', [round(float(x), 2) for x in r], 'mean', round(float(np.mean(r)), 2))
