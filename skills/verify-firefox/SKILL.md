---
name: verify-firefox
description: Verifies the All Mixer Firefox add-on in real Firefox (temporary install, fresh profile, Selenium over a geckodriver attached to a Firefox started with `open`): install, host-access notice and grant, content scripts on YouTube, WebGPU, OPFS model download, Separate mode, YTM lyrics origin. Use when a change touches the Firefox build, manifest.firefox.json, the popup FirefoxAccess notice, OPFS, or anything only real Firefox can prove.
---

# verify-firefox

STATUS: checks a, b, d, g run and pass; c passes windowed only; e and f are partial (see Gotchas). macOS only (uses `open`).

## Launch
```sh
npm run pack:firefox     # builds dist-firefox/ (needs public/ml/*.onnx)
python3 -m venv $SCRATCH/venv && $SCRATCH/venv/bin/pip install selenium   # once; Selenium Manager caches geckodriver in ~/.cache/selenium
$SCRATCH/venv/bin/python -I skills/verify-firefox/drive.py --addon dist-firefox --out $SCRATCH/out --headed
$SCRATCH/venv/bin/python -I skills/verify-firefox/drive.py --addon dist-firefox --out $SCRATCH/out-net --headed --netlog   # check f only
```
What drive.py does: writes `user.js` (fixed extension UUID, autoplay on, volume 0, console to stdout) into an empty profile, starts `open -n -a Firefox.app --args -marionette -no-remote -profile <dir>` with `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, attaches `geckodriver --connect-existing --allow-system-access --marionette-port 2828 --port 4455`, installs the add-on temporarily, and kills the Firefox it started (found by profile path) at the end. Leave the `--headed` flag on: headless has `navigator.gpu` but `requestAdapter()` is null.

## Gotchas
- Exec'ing the firefox binary (also via geckodriver) fails with "Could not find profile folder." on macOS 27 / Firefox 161; `open` works.
- WebDriver refuses `get("moz-extension://...")`. drive.py opens extension pages from chrome context (`gBrowser.addTab` with the system principal), which needs the env var and `--allow-system-access` above.
- Firefox 127+ grants MV3 host permissions at install, so the popup notice does not show after a fresh install (also with temporary install). drive.py revokes with `permissions.remove` first (like "Only when clicked"), then clicks the real `#grant-access`. Pref `extensions.webextOptionalPermissionPrompts=false` lets the click go through without a doorhanger.
- A background tab is throttled: YouTube must sit in its own window beside the control tab.
- Separate mode on this M-series Mac in Firefox 161: ML probe gives up with "too slow on this device (p90 about 300 ms)" and Preload fails with "the model stopped answering" at 99 % (model `compat`, 19 s video). So e (separation running, mix level) is not proven; do not read it as passing. Chrome numbers are not comparable.
- Check f reads Origin and status of `youtubei/v1/next` from an `nsHttp:5` log. The page's own requests are in the same log, so it proves no `moz-extension://` origin and a 200, not that the add-on made the request. The log slows Firefox: run it apart from a to e.
- Do not run `firefox -CreateProfile`: it starts the GUI and hangs.

## Evidence
`--out`: results.json, firefox-stdout.log, geckodriver.log, popup-before/after.png, youtube-separate.png, ytm.png. Cleanup: `pgrep -fl "firefox|geckodriver"` must be empty.
