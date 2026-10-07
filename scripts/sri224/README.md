SRI-227 / SRI-224 QA on e275913, music.youtube.com, real ML, D=2000 ms, qa-sri224.mjs (qa-sri213.mjs + trace capture, pseek, live).
music/  : basic,pending,pseek (REPS=2) and Default control (-def, DEFMODE=1). music2/: pseek x3 + live mode/preset switch.
Run: PLAYWRIGHT_BROWSERS_PATH=~/Library/Caches/ms-playwright SITE=music SCEN=pending,pseek,basic REPS=2 OUT=scripts/sri224/music node scripts/qa-sri224.mjs
