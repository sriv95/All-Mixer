// SRI-148: lyrics panel resize/centering/status re-test (commit cdb5eb7). SITE=www|music VID=<id> node scripts/qa-sri144.mjs
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist'), SITE = process.env.SITE || 'www', VID = process.env.VID || 'dQw4w9WgXcQ';
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-qa-148-')), { headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1400, height: 900 }, ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setup = await ctx.newPage(); await setup.goto(`chrome-extension://${extId}/popup/popup.html`);
await setup.evaluate((k) => chrome.storage.local.set({ lyricsPrefs: { lyricsVisible: true, lyricsDisplayMode: 'window' }, [k]: { x: 20, y: 40, w: 340, h: 720, open: true } }), `lyricsPanel:${SITE === "music" ? "ytmusic" : "youtube"}`); await setup.close();
const PLAIN = process.env.PLAIN === '1';
if (PLAIN) await ctx.route('**://lrclib.net/**', async (route) => { const rec = { id: 1, trackName: 'Never Gonna Give You Up', artistName: 'Rick Astley', albumName: 'Whenever You Need Somebody', duration: 213, instrumental: false, syncedLyrics: null, plainLyrics: Array.from({ length: 60 }, (_, i) => `Plain line ${i + 1}: never gonna give you up, never gonna let you down`).join('\n') }; const u = route.request().url(); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(/\/search/.test(u) ? [rec] : rec) }); });
const page = await ctx.newPage(); page.on('dialog', (d) => d.accept());
await page.goto(`https://${SITE}.youtube.com/watch?v=${VID}`, { waitUntil: 'domcontentloaded' }); await sleep(3000);
for (const s of ['button:has-text("Accept all")', 'button:has-text("Reject all")']) { const b = page.locator(s).first(); if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(1500); break; } }
await page.waitForSelector('video', { timeout: 30000 });
await page.evaluate(() => { window.onbeforeunload = null; addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true); });
for (let i = 0; i < 40; i++) { const ad = await page.evaluate(() => { document.querySelector('.ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern')?.click(); return !!document.querySelector('.ad-showing'); }); if (!ad) break; await sleep(2000); }
await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 60; v.play().catch(() => {}); }); await sleep(6000);
const R = { site: SITE, vid: VID, plain: PLAIN, steps: {} };
if (SITE === 'music') {
  // Lyrics tab
  const tab = page.locator('tp-yt-paper-tab:has-text("Lyrics")').first();
  R.tabInfo = await tab.evaluate((e) => ({ disabled: e.hasAttribute('disabled'), aria: e.getAttribute('aria-disabled') })).catch((e) => ({ err: String(e) }));
  await tab.click({ force: true }).catch(() => {}); await sleep(3000);
  const M = () => page.evaluate(() => {
    const lh = document.querySelector('[data-am-lyrics]'); if (!lh) return { err: 'no lyrics host' };
    const sr = lh.shadowRoot, sc = sr.querySelector('.scroll'), r = (e) => e.getBoundingClientRect(); const cur = sr.querySelector('.line.current');
    const o = { hostH: r(lh).height, hostW: r(lh).width, scrollH: r(sc).height, panelMode: sc.classList.contains('synced'), lockBtn: !!sr.querySelector('.lock'), overflowY: getComputedStyle(sc).overflowY, textAlign: getComputedStyle(sr.querySelector('.line') || sc).textAlign, paddingTop: getComputedStyle(sc).paddingTop, lines: sr.querySelectorAll('.line').length, scrollTop: sc.scrollTop };
    if (cur) { o.curRelPos = (r(cur).top + r(cur).height / 2 - r(sc).top) / r(sc).height; o.curIdx = +cur.dataset.index; } return o; });
  const sample = async (t) => { await sleep(2500); const a = await M(); R.steps[t] = a; console.log(t, JSON.stringify(a)); };
  await sample('tab_1400x900');
  await page.screenshot({ path: path.join(root, 'scripts/qa-sri148-music-1.png') });
  for (const [w, hh] of [[900, 600], [1400, 500], [1400, 900]]) { await page.setViewportSize({ width: w, height: hh }); await sleep(1500); await sample(`viewport_${w}x${hh}`); if (w === 900) await page.screenshot({ path: path.join(root, 'scripts/qa-sri148-music-2.png') }); }
  R.panelHostPresent = await page.evaluate(() => !!document.getElementById('all-mixer-lyrics-panel'));
} else {
  const M = () => page.evaluate(() => {
    const h = document.getElementById('all-mixer-lyrics-panel'); if (!h) return { err: 'no panel host' };
    const panel = h.shadowRoot.querySelector('.panel'); const lh = h.shadowRoot.querySelector('[data-am-lyrics]'); if (!lh) return { err: 'no lyrics host' };
    const sr = lh.shadowRoot, sc = sr.querySelector('.scroll'), ft = sr.querySelector('.footer'), r = (e) => e.getBoundingClientRect(); const pl = sr.querySelector('.plain');
    const o = { panelH: r(panel).height, scrollH: r(sc).height, scrollHeight: sc.scrollHeight, scrollMax: sc.scrollHeight - sc.clientHeight, overflowY: getComputedStyle(sc).overflowY, synced: sc.classList.contains('synced'), hasPlain: !!pl, padTop: getComputedStyle(sc).paddingTop, padBottom: getComputedStyle(sc).paddingBottom, padLeft: getComputedStyle(sc).paddingLeft, inlinePad: sc.style.paddingBlock, lockBtn: !!sr.querySelector('.lock'), footerTop: r(ft).top, footerBottom: r(ft).bottom, panelBottom: r(panel).bottom, footerVisible: r(ft).bottom <= r(panel).bottom + 0.5 && r(ft).height > 0, plainText: pl?.textContent.slice(0, 60) };
    sc.scrollTop = 100000; o.scrolledTo = sc.scrollTop; sc.scrollTop = 0; return o; });
  const resize = async (w, hgt) => { const hd = await page.evaluate(() => { const b = document.getElementById('all-mixer-lyrics-panel').shadowRoot.querySelector('.resize').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    const p = await page.evaluate(() => { const b = document.getElementById('all-mixer-lyrics-panel').shadowRoot.querySelector('.panel').getBoundingClientRect(); return { w: b.width, h: b.height }; });
    await page.mouse.move(hd.x, hd.y); await page.mouse.down(); await page.mouse.move(hd.x + (w - p.w) / 2, hd.y + (hgt - p.h) / 2, { steps: 5 }); await page.mouse.move(hd.x + (w - p.w), hd.y + (hgt - p.h), { steps: 5 }); await page.mouse.up(); await sleep(1200); };
  const sample = async (t) => { await sleep(5000); const a = await M(); R.steps[t] = a; console.log(t, JSON.stringify(a)); };
  await sample('initial_340x720'); await page.screenshot({ path: path.join(root, 'scripts/qa-sri148-www-720.png') });
  await resize(340, 340); await sample('after_340x340'); await page.screenshot({ path: path.join(root, 'scripts/qa-sri148-www-340.png') });
}
fs.writeFileSync(path.join(root, `scripts/qa-sri148-${SITE}${PLAIN ? '-plain' : ''}-result.json`), JSON.stringify(R, null, 1));
await ctx.close(); process.exit(0);
