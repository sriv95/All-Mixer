// SRI-195 retest: karaoke drag/hit-test. SITE=www|music VID=<id>
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist'), SITE = process.env.SITE || 'music', VID = process.env.VID || 'fJ9rUzIMcZQ';
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-qa-195-')), { headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1400, height: 900 }, ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const page = await ctx.newPage(); page.on('dialog', (d) => d.accept());
const R = {}; const log = (k, v) => { R[k] = v; console.log(k, JSON.stringify(v)); }; const shot = (n) => page.screenshot({ path: path.join(root, `scripts/qa-sri195-${SITE}-${n}.png`) });
const prep = async () => { await page.evaluate(() => { window.onbeforeunload = null; addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true); });
  for (let i = 0; i < 40; i++) { const ad = await page.evaluate(() => { document.querySelector('.ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern')?.click(); return !!document.querySelector('.ad-showing'); }); if (!ad) break; await sleep(2000); } };
await page.goto(`https://${SITE}.youtube.com/watch?v=${VID}`, { waitUntil: 'domcontentloaded' }); await sleep(3000);
for (const s of ['button:has-text("Accept all")', 'button:has-text("Reject all")']) { const b = page.locator(s).first(); if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(1500); break; } }
await page.waitForSelector('video', { timeout: 30000 }); await prep();
await page.evaluate(() => { const e = document.querySelector('video'); e.currentTime = 30; e.play().catch(() => {}); }); await sleep(8000); await prep();
const vt = () => page.evaluate(() => document.querySelector('ytmusic-av-toggle .video-button')?.click());
if (SITE === 'music') { await vt(); await sleep(4000); }
const state = () => page.evaluate(() => { const rs = document.querySelectorAll('#all-mixer-karaoke'); const k = rs[0]; const b = k?.querySelector('.am-k-block'); if (!b) return { roots: rs.length, block: false };
  const r = b.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2; const hit = document.elementFromPoint(cx, cy);
  return { roots: rs.length, parent: k.parentElement.tagName + '#' + k.parentElement.id, fsEl: document.fullscreenElement ? document.fullscreenElement.tagName + '#' + document.fullscreenElement.id : null, cx: Math.round(cx), cy: Math.round(cy), w: Math.round(r.width), disp: getComputedStyle(b).display, hitIsBlock: !!hit && (hit === b || b.contains(hit)), hit: hit && `${hit.tagName}#${hit.id}`,
    lines: [...b.querySelectorAll('.am-k-line')].map((e) => e.textContent).join(' / ').slice(0, 80) }; });
const drag = async (dx, dy) => { const s = await state(); if (!s.cx) return null; await page.mouse.move(s.cx, s.cy); await page.mouse.down(); await page.mouse.move(s.cx + dx, s.cy + dy, { steps: 10 }); await page.mouse.up(); await sleep(600); const e = await state(); return { dx: e.cx - s.cx, dy: e.cy - s.cy, hitIsBlock: s.hitIsBlock }; };
await page.mouse.move(700, 300); await sleep(500);
log('1_normal_state', await state()); log('1_normal_drag', await drag(-120, -60)); await shot('1-normal');
log('1b_normal_drag_back', await drag(120, 60));
// theater
if (SITE === 'www') { await page.keyboard.press('t'); await sleep(2000); log('2_theater_state', await state()); log('2_theater_drag', await drag(-80, -40)); await shot('2-theater'); await page.keyboard.press('t'); await sleep(1500); }
// fullscreen via real UI button
await page.mouse.move(700, 400); await sleep(300);
const fsBtn = page.locator(SITE === 'music' ? 'ytmusic-player .fullscreen-button, .ytp-fullscreen-button, button[aria-label*="ull screen" i]' : '.ytp-fullscreen-button').first();
await fsBtn.click({ timeout: 5000 }).catch(async (e) => { log('fs_btn_err', String(e).slice(0, 100)); await page.evaluate(() => document.querySelector('#movie_player').requestFullscreen()).catch(() => {}); }); await sleep(2500);
log('3_fs_state', await state()); log('3_fs_drag', await drag(-150, -80)); await shot('3-fs');
const v1 = await page.evaluate(() => document.querySelector('video').currentTime); await sleep(4000); const s2 = await state(); log('3_fs_sync', { advanced: (await page.evaluate(() => document.querySelector('video').currentTime)) - v1, lines: s2.lines });
await page.evaluate(() => document.fullscreenElement && document.exitFullscreen()); await sleep(2000);
log('4_exitfs_state', await state()); log('4_exitfs_drag', await drag(60, 30)); await shot('4-exitfs');
if (SITE === 'www') { // controls not covered
  await page.mouse.move(700, 400); await sleep(500);
  log('5_controls', await page.evaluate(() => { const o = {}; for (const [n, s] of [['play', '.ytp-play-button'], ['progress', '.ytp-progress-bar'], ['settings', '.ytp-settings-button'], ['volume', '.ytp-mute-button']]) { const e = document.querySelector(s); if (!e) { o[n] = 'missing'; continue; } const r = e.getBoundingClientRect(); const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); o[n] = h && (h === e || e.contains(h) || h.closest(s)) ? 'ok' : 'COVERED by ' + h?.tagName + '#' + h?.id + '.' + String(h?.className).slice(0, 40); } return o; }));
  const t0 = await page.evaluate(() => document.querySelector('video').paused); await page.locator('.ytp-play-button').click(); await sleep(500); log('5_play_click_toggled', t0 !== await page.evaluate(() => document.querySelector('video').paused)); await page.locator('.ytp-play-button').click();
}
if (SITE === 'music') { await vt(); await sleep(3000); log('6_audioonly', await state()); await shot('6-audio'); await vt(); await sleep(3000); log('6b_video_again', await state());
  // SPA nav: click next
  await page.evaluate(() => document.querySelector('.next-button')?.click()); await sleep(7000); await prep(); log('7_after_next', { ...(await state()), url: page.url() }); await shot('7-next'); }
fs.writeFileSync(path.join(root, `scripts/qa-sri195-${SITE}-result.json`), JSON.stringify(R, null, 1)); await ctx.close(); process.exit(0);
