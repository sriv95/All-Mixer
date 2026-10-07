// SRI-213 control: pause/play cycles on www; EXT=none|default|ml. Logs when .ytp-error appears.
import path from 'node:path'; import os from 'node:os'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist'); const EXT = process.env.EXT || 'none';
const args = ['--autoplay-policy=no-user-gesture-required', '--mute-audio']; if (EXT !== 'none') args.push(`--disable-extensions-except=${ext}`, `--load-extension=${ext}`);
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-ctl-')), { headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1400, height: 900 }, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const page = await ctx.newPage(); page.on('dialog', (d) => d.accept());
await page.goto(process.env.URL || 'https://www.youtube.com/watch?v=fJ9rUzIMcZQ', { waitUntil: 'domcontentloaded' }); await sleep(4000);
for (const s of ['button:has-text("Accept all")', 'button:has-text("Reject all")']) { const b = page.locator(s).first(); if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(2000); break; } }
await page.mouse.click(5, 450);
if (EXT === 'ml') { const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker'); const id = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => /youtube/.test(t.url))?.id); await sw.evaluate(([id]) => chrome.tabs.sendMessage(id, { type: 'apply-settings', settings: { mode: 'separate', masterPct: 100, vocalPct: 0, instrumentalPct: 100, separationQuality: 'auto' } }), [id]); await sleep(30000); }
const info = () => page.evaluate(() => { const e = document.querySelector('video'); return { t: +e.currentTime.toFixed(1), paused: e.paused, err: !!document.querySelector('.ytp-error'), ad: !!document.querySelector('#movie_player.ad-showing') }; });
for (let i = 1; i <= 8; i++) { await page.evaluate(() => document.querySelector('video').pause()); await sleep(3000); const a = await info(); await page.evaluate(() => document.querySelector('video').play().catch(() => {})); await sleep(6000); const b = await info(); console.log(EXT, i, JSON.stringify(a), JSON.stringify(b)); if (b.err) break; }
await ctx.close();
