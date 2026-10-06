SRI-203 harness (no product change). Run on a scratch copy of dist/:
1. cp -R dist $SCRATCH/dist; add scripts/qa-sri203-tap-worklet.js as dist/worklet/qa-tap.js and list it in manifest web_accessible_resources.
2. In dist/worklet/separator-worklet.js after `this.core.process(...)` post every 32 quanta {type:'qa-w', t:currentTime, b:mean(bw), st:{...core.stats}, ph:core.phase, en:core.engine, um:core.useMl} (the worklet exposes no counters otherwise).
3. QA_EXT=$SCRATCH/dist node scripts/qa-sri203.mjs music V1Pl8CzNzCw lovely 50 60 <reference|karaoke|acappella>  (one fresh Chrome per mode)
4. python scripts/qa-sri203-offline.py <ref .st.f32> 44100 offline.json ; python scripts/qa-sri203-report.py <scratch> scripts rep.json
