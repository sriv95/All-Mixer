**SRI-144 QA: PASS on items 1-4 (www.youtube.com, build with cdb5eb7 + b3df1e4 in dist). Item 5 is only partly covered.**

Setup: Playwright Chromium with the unpacked `dist/`, video dQw4w9WgXcQ, ad checked, content playing and synced (59 lines). Script: `scripts/qa-sri144.mjs`. I fixed its storage key (it used `www`, but the real keys are `youtube`/`ytmusic`). Because of that wrong key, the earlier run never opened the panel.

1. **Resize: pass.**
   - 340x720: `.scroll` 657.6 + footer 27.4 = 685 (body height). Footer bottom 759 against panel bottom 760.
   - 340x340, then back to 720, then 340 again: `.scroll` 277.6 + footer 27.4 = 305 (body height). All footer children (source select, Centered, src) sit inside the panel, none clipped.
2. **Centering: pass.** centerDelta after each resize is -0.16, -0.38, -0.38, +0.40, and -0.09 after relock. All within 1px, including at width 240 (-0.91) and width 600 (-0.51).
3. **First and last line: pass, on the spacer range.**
   - The `::before`/`::after` percent-height spacers resolve to 138.8px at a 277.6px scroller (exactly half) and 328.8px at 657.6px. No real-spacer fallback is needed.
   - Unlocked at scrollTop 0, the first line's centre is 17.2px below the scroller centre. That is half a line height, and scrollTop can still go up to about 17 to centre it. At scrollMax (2192) the last line is -16.7px, the same in reverse. So both edge lines can reach the exact centre.
   - I did not drive scrollTop to those exact values.
4. **Status message (240x160): pass.** The scroller is 80.6px high. scrollTop 0 with the status top equal to the scroller top (74). The first text line top is 87, visible, and there are 8 text rects.
5. **Regression: partly covered.**
   - Width scaling: font 16px at 240 wide, 16px at 340, and 28.1px at 600. Pass.
   - Lock/unlock: overflow goes `hidden`, then `auto` on unlock, then `hidden` again on relock, and it re-centers. Pass.
   - Not covered: plain (unsynced) lyrics padding, and the YT Music tab surface (left-aligned, no lock button). The music.youtube.com smoke was not run this heartbeat.

Evidence: `scripts/qa-sri144-www-720.png`, `scripts/qa-sri144-www-340.png`, `scripts/qa-sri144-www-160.png`, `scripts/qa-sri144-www-result.json`.

Next: run the music.youtube.com smoke and an unsynced-lyrics video for the rest of item 5 (Shadow). No bugs found.
