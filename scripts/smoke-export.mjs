// Export section against a real page: loads dist/ as an unpacked extension, starts an export through the same message the popup sends,
// polls the progress the popup shows, saves the download and prints what ffprobe says about it.
// Usage: bun run build && node scripts/smoke-export.mjs <format: mp3|mp4> <tracks: single|separate> [page url] [out dir]
//   env: HEADED=1 to watch, SETTINGS='{"vocalPct":0}' for the audio levels, TEXT='{"karaokeColor":"#ffeb3b"}' for the karaoke text,
//        MODEL=mdx|roformer|deux|sw (the downloadable ones need MODEL_DIR=<models-out/hf from bun run model-manifest>, served on :8765 and installed through the background),
//        NOFAST=1 records in real time instead of reading the audio the player downloaded (src/export/fast-audio.ts),
//        STALL_MS=400 holds every model block (slow GPU), HEIGHT=360|480|720|1080, SHOTS=1 to save screenshots of the page before and in the middle of the export.
// The default page is a local file server on :8123 serving a test video (any short mp4 served from a folder); pass a YouTube URL for the real thing.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist');
const [format = 'mp3', tracks = 'single', url = 'http://127.0.0.1:8123/', outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-export-'))] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const settings = JSON.parse(process.env.SETTINGS || '{}');
const text = JSON.parse(process.env.TEXT || '{}');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// A local model server for the downloadable models (the Hugging Face repo layout), like the QA harness of the model download.
const modelDir = process.env.MODEL_DIR;
if (modelDir) {
  const server = http.createServer((req, res) => {
    const p = path.join(modelDir, decodeURIComponent(req.url.split('?')[0]));
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (!p.startsWith(modelDir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return res.writeHead(404, cors).end();
    const size = fs.statSync(p).size, m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '');
    if (!m) return res.writeHead(200, { ...cors, 'Content-Length': size }) && fs.createReadStream(p).pipe(res);
    const a = +m[1], b = Math.min(+(m[2] ?? size - 1), size - 1);
    res.writeHead(206, { ...cors, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
    fs.createReadStream(p, { start: a, end: b }).pipe(res);
  });
  await new Promise((r) => server.listen(8765, '127.0.0.1', r));
}

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-smoke-')), {
  headless: !process.env.HEADED, channel: 'chromium', locale: 'en-US', acceptDownloads: true, viewport: { width: 1400, height: 900 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
await sw.evaluate((v) => chrome.storage.local.set({ 'debug.noFastAudio': v }), !!process.env.NOFAST);
if (process.env.STALL_MS) await sw.evaluate((ms) => chrome.storage.local.set({ 'debug.mlStallMs': ms, 'debug.mlStallAfterMs': 2000 }), Number(process.env.STALL_MS)); // slow model: the last chunks take long after the recording
const page = await ctx.newPage();
if (modelDir) {
  await sw.evaluate(() => chrome.storage.local.set({ 'debug.modelBaseUrl': 'http://127.0.0.1:8765' }));
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
  const need = [process.env.MODEL, ...(settings.splitInstrumental ? ['drums'] : []), ...(settings.splitGuitar ? ['guitar'] : [])].filter((m) => m && m !== 'mdx');
  for (const id of need) {
    await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'model-install', id }), id);
    for (let i = 0; i < 300; i++) {
      const o = await sw.evaluate((id) => chrome.storage.local.get([`modelInstalled.${id}`, `modelProgress.${id}`]), id);
      if (o[`modelInstalled.${id}`]) { log(id, 'installed'); break; }
      if (o[`modelProgress.${id}`]?.phase === 'error') throw new Error('download: ' + o[`modelProgress.${id}`].error);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await popup.close();
}
page.on('console', (m) => /All Mixer|export|ml\]/i.test(m.text()) && log('console:', m.text().slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('video', { timeout: 30000 });
await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && Number.isFinite(v.duration); }, null, { timeout: 60000 });
await page.waitForTimeout(2500); // the content script, the lyrics

const send = (msg) => sw.evaluate(async (m) => { const [tab] = await chrome.tabs.query({ active: true }); return chrome.tabs.sendMessage(tab.id, m); }, msg);
const status = async () => (await send({ type: 'get-status' }))?.export;
if (format === 'mp4' && /youtube/.test(url)) {
  // The karaoke text needs the synced lyrics (LRCLIB or captions) to be on screen.
  for (let i = 0; i < 40 && !(await send({ type: 'get-status' }))?.lyricsSynced; i++) await page.waitForTimeout(1000);
  log('lyrics synced:', (await send({ type: 'get-status' }))?.lyricsSynced);
}
const defaults = await sw.evaluate(() => chrome.storage.local.get('lyricsPrefs'));
const prefs = defaults.lyricsPrefs ?? {};
const options = {
  format, tracks,
  audio: { mlModel: process.env.MODEL || 'mdx', ...settings },
  text: { karaokeColor: prefs.karaokeColor ?? '#ffffff', karaokeFontSize: prefs.karaokeFontSize ?? 100, karaokeFont: prefs.karaokeFont ?? 'default', karaokeOutline: prefs.karaokeOutline ?? 'normal', karaokeBackground: prefs.karaokeBackground ?? 0, karaokeLines: prefs.karaokeLines ?? 1, karaokePosition: prefs.karaokePosition ?? { x: 0.5, y: 0.82 }, ...text },
  height: Number(process.env.HEIGHT || 720),
};
const downloaded = new Promise((resolve) => page.once('download', resolve));
if (process.env.SHOTS) await page.screenshot({ path: path.join(outDir, 'before.png') });
const urlStart = page.url();
const t0 = Date.now();
log('start', JSON.stringify({ format, tracks, audio: options.audio }));
const ans = await send({ type: 'export-start', options });
log('answer', JSON.stringify(ans));
if (!ans?.ok) process.exit(2);
let last = '', n = 0;
for (;;) {
  const p = await status();
  const line = p ? `${p.state} ${p.stage} ${p.percent.toFixed(0)}% ${p.detail}` : 'none';
  if (line !== last && n++ % 4 === 0) log(line);
  last = line;
  if (process.env.SHOTS && p?.stage === 'recording' && p.percent > 30 && !fs.existsSync(path.join(outDir, 'mid.png'))) await page.screenshot({ path: path.join(outDir, 'mid.png') });
  if (p && p.state !== 'running') { log('final', JSON.stringify(p)); if (p.state !== 'done') process.exit(3); break; }
  await new Promise((r) => setTimeout(r, 500));
}
// The recording ends at the end of the video: the page must stay on it (YouTube autoplays the next video from a video left at its end).
const urlNow = page.url();
log('page url unchanged:', urlNow === urlStart, urlNow);
if (urlNow !== urlStart) { console.log('FAIL the page left the video'); process.exit(4); }
const dl = await downloaded;
const file = path.join(outDir, dl.suggestedFilename());
await dl.saveAs(file);
log('saved', file, `${((fs.statSync(file).size) / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await ctx.close();
if (file.endsWith('.zip')) {
  execFileSync('unzip', ['-o', '-q', file, '-d', outDir]);
  for (const f of fs.readdirSync(outDir, { recursive: true })) if (String(f).endsWith('.mp3')) console.log(path.join(outDir, String(f)));
}
console.log(file);
