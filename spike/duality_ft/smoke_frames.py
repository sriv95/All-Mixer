"""Session-creation check: a Duality ONNX must load at every frame count the M1 planner can produce (src/ml/rof-plan.ts MAX_FRAMES = 900).
  .venv/bin/python -I spike/duality_ft/smoke_frames.py <duality.onnx> [frames...]   exit 1 if any fails (e.g. rotary freqs baked at 175 frames)"""
import sys, onnxruntime as ort
f, fr = sys.argv[1], [int(a) for a in sys.argv[2:]] or [112, 175, 176, 250, 400, 900]
bad = 0
for n in fr:
    o = ort.SessionOptions(); o.add_free_dimension_override_by_name('frames', n)
    try: ort.InferenceSession(f, o, providers=['CPUExecutionProvider']); print('PASS frames', n)
    except Exception as e: bad += 1; print('FAIL frames', n, str(e)[-120:].replace('\n', ' '))
sys.exit(1 if bad else 0)
