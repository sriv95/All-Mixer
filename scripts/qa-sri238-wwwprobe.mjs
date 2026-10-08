// SRI-238: does www reset to ct 0 paused ~55 s into play? EXT=1|0 SEP=1|0
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist'), EXT = process.env.EXT !== '0', SEP = process.env.SEP === '1';
const args = ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run']; if (EXT) args.push(`--disable-extensions-except=${ext}`, `--load-extension=${ext}`);
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-qa-238p-')), { headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1400, height: 900 }, ignoreDefaultArgs: ['--enable-automation'], args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await ctx.newPage(); page.on('dialog', (d) => d.accept());
page.on('console', (m) => { if (/error/i.test(m.type()) && /allmixer|All Mixer/i.test(m.text())) console.error('CONSOLE', m.text().slice(0, 200)); });
await page.goto(`https://www.youtube.com/watch?v=${process.env.VID || 'fJ9rUzIMcZQ'}`, { waitUntil: 'domcontentloaded' }); await sleep(4000);
await page.evaluate(() => { window.onbeforeunload = null; addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true); document.querySelector('video').play().catch(() => {}); });
if (EXT && SEP) { const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker'); const id = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
  await sw.evaluate(([id]) => chrome.tabs.sendMessage(id, { type: 'apply-settings', settings: { mode: 'separate', masterPct: 100, vocalPct: 100, instrumentalPct: 100, separationQuality: 'auto' } }), [id]); }
for (let i = 0; i < +(process.env.N || 100); i++) { const s = await page.evaluate(() => { const v = document.querySelector('video'); return { ct: +v.currentTime.toFixed(1), p: v.paused, end: v.ended, err: !!document.querySelector('.ytp-error'), ad: !!document.querySelector('.ad-showing'), url: location.search }; }).catch((e) => ({ x: String(e).slice(0, 80) })); if (i % 5 === 0 || s.p || s.err) console.log(i * 2, JSON.stringify(s)); await sleep(2000); }
await ctx.close();
