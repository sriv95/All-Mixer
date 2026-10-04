// SRI-6 smoke test: load dist/ as an unpacked extension and check F1 / F2 on real pages.
// Usage: npm run build && node scripts/smoke-lyrics.mjs [youtube-url] [ytmusic-url]
// Needs Playwright (spike/node_modules) and network access. Writes screenshots to $OUT (default /tmp).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(root, 'spike/package.json'));
const { chromium } = require('playwright');
const ext = path.join(root, 'dist');
const OUT = process.env.OUT || os.tmpdir();
const YT = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const YTM = process.argv[3] || 'https://music.youtube.com/watch?v=fJ9rUzIMcZQ';

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-smoke-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: process.env.HEADED ? false : true,
  channel: 'chromium',
  locale: 'en-US',
  // YT Music refuses "Chrome for Testing"; present as regular Chrome.
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'],
  viewport: { width: 1500, height: 950 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-blink-features=AutomationControlled'],
});
const results = {};

async function consent(page) {
  for (const sel of ['button[aria-label*="Accept"]', 'button:has-text("Accept all")', 'button:has-text("Reject all")']) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {});
      await page.waitForTimeout(2000);
      return;
    }
  }
}

const panelState = (page) =>
  page.evaluate(() => {
    const host = document.getElementById('all-mixer-lyrics-panel');
    const view = host?.shadowRoot?.querySelector('[data-am-lyrics]');
    const r = view?.shadowRoot;
    const v = document.querySelector('#movie_player video');
    return {
      panelOpen: !!host && host.style.display !== 'none',
      lines: r?.querySelectorAll('.line').length ?? 0,
      words: r?.querySelectorAll('.word').length ?? 0,
      current: r?.querySelector('.line.current')?.textContent ?? null,
      status: r?.querySelector('.status')?.textContent ?? null,
      footer: r?.querySelector('.footer, footer')?.textContent ?? null,
      t: v?.currentTime ?? null,
      paused: v?.paused ?? null,
    };
  });

// ---- F2: youtube.com ----
{
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => m.text().includes('All Mixer') && logs.push(m.text()));
  await page.goto(YT, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await consent(page);
  await page.waitForSelector('#movie_player video', { timeout: 30000 });
  await page.evaluate(() => document.querySelector('#movie_player video')?.play().catch(() => {}));
  const btn = page.locator('[data-allmixer-lyrics-btn]');
  await btn.waitFor({ timeout: 15000 });
  await page.locator('#movie_player').hover();
  await btn.click();
  await page.waitForTimeout(9000);
  const a = await panelState(page);
  // Click-to-seek: click the 6th line.
  const seek = await page.evaluate(() => {
    const r = document.getElementById('all-mixer-lyrics-panel').shadowRoot.querySelector('[data-am-lyrics]').shadowRoot;
    const line = r.querySelectorAll('.line')[5];
    if (!line) return null;
    line.click();
    return line.textContent;
  });
  await page.waitForTimeout(1500);
  const b = await panelState(page);
  // Captions on: the player fetches timed text with its token; lyrics should re-align (footer mentions captions).
  await page.locator('#movie_player').hover();
  await page.keyboard.press('c');
  await page.waitForTimeout(6000);
  const cc = await panelState(page);
  await page.keyboard.press('c');
  await page.screenshot({ path: path.join(OUT, 'smoke-yt-panel.png') });
  // Theater + fullscreen keep the panel.
  await page.keyboard.press('t');
  await page.waitForTimeout(1000);
  const theater = await panelState(page);
  await page.evaluate(() => document.querySelector('#movie_player').requestFullscreen().catch((e) => String(e)));
  await page.waitForTimeout(1500);
  const fs1 = await page.evaluate(() => !!document.fullscreenElement?.querySelector('#all-mixer-lyrics-panel'));
  await page.screenshot({ path: path.join(OUT, 'smoke-yt-fullscreen.png') });
  await page.evaluate(() => document.exitFullscreen().catch(() => {}));
  // SPA navigation to another song via the YouTube router.
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = '/watch?v=fJ9rUzIMcZQ';
    document.querySelector('ytd-app')?.appendChild(a);
  });
  await page.goto('https://www.youtube.com/watch?v=fJ9rUzIMcZQ', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(10000);
  const nav = await panelState(page);
  results.youtube = { before: a, seekLine: seek, afterSeek: b, afterCC: cc, theater, fullscreenHasPanel: fs1, afterNav: nav, logs };
  await page.close();
}

// ---- F1: music.youtube.com ----
{
  const page = await ctx.newPage();
  await page.goto(YTM, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await consent(page);
  await page.waitForSelector('#movie_player video', { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('#movie_player video')?.play().catch(() => {}));
  await page.waitForTimeout(4000);
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('ytmusic-player-page tp-yt-paper-tab')].map((t) => ({
      text: t.textContent.trim(),
      disabled: t.hasAttribute('disabled'),
      selected: t.getAttribute('aria-selected'),
    })),
  );
  await page.locator('ytmusic-player-page tp-yt-paper-tab').nth(1).click({ force: true }).catch((e) => console.log('tab click', e.message));
  await page.waitForTimeout(9000);
  const tab = await page.evaluate(() => {
    const c = document.querySelector('ytmusic-player-page #tab-renderer');
    const view = c?.querySelector('[data-am-lyrics]');
    const r = view?.shadowRoot;
    return {
      mounted: !!view,
      viewHeight: view?.getBoundingClientRect().height ?? 0,
      lines: r?.querySelectorAll('.line').length ?? 0,
      current: r?.querySelector('.line.current')?.textContent ?? null,
      words: r?.querySelectorAll('.word').length ?? 0,
      footer: r?.querySelector('.footer, footer')?.textContent ?? null,
      native: c?.querySelector('ytmusic-description-shelf-renderer')?.textContent?.slice(0, 80) ?? null,
      t: document.querySelector('#movie_player video')?.currentTime,
    };
  });
  await page.screenshot({ path: path.join(OUT, 'smoke-ytm-tab.png') });
  results.ytmusic = { tabs, tab, button: await page.locator('[data-allmixer-lyrics-btn]').count() };
  await page.close();
}

console.log(JSON.stringify(results, null, 2));
await ctx.close();
