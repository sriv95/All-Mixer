// Model menu + High quality (Duality) download and live separation in the real extension, from a local model server.
// Usage: bun run build && MODEL_DIR=<models-out/hf> node scripts/smoke-duality.mjs [videoId]   (HEADED=1 to watch)
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const ext = path.join(root, 'dist');
const modelDir = process.env.MODEL_DIR;
if (!modelDir) throw new Error('MODEL_DIR=<models-out/hf> required');
const ID = process.argv[2] || 'dQw4w9WgXcQ';
const MODEL = process.env.MODEL || 'duality'; // control runs: MODEL=deux|kara2
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, info = '') => { console.log(ok ? 'PASS' : 'FAIL', name, info); if (!ok) failed++; };

const server = http.createServer((req, res) => {
  log('server', req.method, req.url, req.headers.range || '');
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

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'am-dual-')), {
  headless: !process.env.HEADED, channel: 'chromium', locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'], viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-blink-features=AutomationControlled', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--remote-debugging-port=9333'],
});
const levels = [];
const onMl = (m) => { const t = m.text(); if (/all-mixer ml\]/.test(t)) { log('ml:', t.slice(0, 300)); if (/level/.test(t)) levels.push(t); } };
ctx.on('console', onMl);
// Playwright does not surface the ML worker's console (extension iframe -> dedicated worker): attach over raw CDP, recursively, to every target.
const ws = new WebSocket((await (await fetch('http://127.0.0.1:9333/json/version')).json()).webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let cid = 0;
const send = (method, params = {}, sessionId) => ws.send(JSON.stringify({ id: ++cid, method, params, sessionId }));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Target.attachedToTarget') {
    const sid = m.params.sessionId;
    send('Runtime.enable', {}, sid);
    send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid);
    send('Runtime.runIfWaitingForDebugger', {}, sid);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    onMl({ text: () => m.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
  }
};
send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
await sw.evaluate(() => chrome.storage.local.set({ 'debug.modelBaseUrl': 'http://127.0.0.1:8765', 'debug.mlTiming': true }));
const page = await ctx.newPage();
await page.goto(`https://www.youtube.com/watch?v=${ID}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#movie_player video', { timeout: 30000 });
await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && Number.isFinite(v.duration); }, null, { timeout: 60000 });
await page.waitForTimeout(2500);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://www.youtube.com/*' }))[0].id);
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 380, height: 900 });
await popup.addInitScript(({ tabId, url }) => { chrome.tabs.query = async () => [{ id: tabId, url }]; }, { tabId, url: page.url() });
await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
log('gpu', await popup.evaluate(async () => { const a = await navigator.gpu?.requestAdapter(); return a ? JSON.stringify({ ...a.info, fallback: a.isFallbackAdapter, f16: a.features.has('shader-f16') }) : 'no adapter'; }));
await popup.click('#tab-separate');
await popup.click('#advanced-toggle');
await popup.click('#ml-model');
await sleep(500);
const order = await popup.$$eval('#ml-model-list [role=option] > span > span:first-child', (els) => els.map((e) => e.textContent));
check('(1) menu order', order.join('|') === 'Fast (Default)|Best Karaoke|High quality|Best Vocal|Best Instrumental', order.join(' / '));

const pick = async (v) => { if ((await popup.getAttribute('#ml-model', 'aria-expanded')) !== 'true') await popup.$eval('#ml-model', (e) => e.click()); await sleep(500); await popup.$eval(`#ml-model-option-${v}`, (e) => e.click()); await sleep(1200); };
await pick('kara2');
check('(3a) Best Karaoke: Backing vocal visible', await popup.locator('#backing').isVisible());
await pick(MODEL);
if (MODEL === 'duality') check('(3b) High quality: Backing vocal hidden', (await popup.locator('#backing').count()) === 0 || !(await popup.locator('#backing').isVisible()));

if (process.env.MAX_DELAY) { // the probe judges the GPU against the Delay limit: raise it to the model's maximum
  await popup.$eval('#ml-delay', (e) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, e.max); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
  await sleep(300); await popup.$eval('#ml-delay-apply', (e) => e.click()); log('delay limit', await popup.$eval('#ml-delay', (e) => e.value));
}
await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
if (process.env.PAUSE_PROBE) await page.evaluate(() => document.querySelector('video').pause()); // less GPU/CPU contention while the probe times the model
const t0 = Date.now();
await popup.waitForSelector('#model-btn', { timeout: 15000 });
log('model line:', await popup.locator('#model-text').innerText());
await popup.click('#model-btn');
for (;;) {
  const o = await sw.evaluate((ks) => chrome.storage.local.get(ks), [`modelInstalled.${MODEL}`, `modelProgress.${MODEL}`]);
  if (o[`modelInstalled.${MODEL}`]) break;
  if (o[`modelProgress.${MODEL}`]?.phase === 'error') throw new Error('download: ' + o[`modelProgress.${MODEL}`].error);
  if (Date.now() - t0 > 240000) throw new Error('download timeout');
  await sleep(1000);
}
log(MODEL, 'installed in', ((Date.now() - t0) / 1000).toFixed(0), 's');
const status = () => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'get-status' }), tabId);
let st;
for (let i = 0; i < 300; i++) { st = await status(); if (st?.separation?.state === 'on' || st?.separation?.state === 'error') break; await sleep(1000); }
log('separation', JSON.stringify(st.separation));
for (let i = 0; i < 180 && (await status())?.separation?.choice?.state === 'warming'; i++) await sleep(1000);
if (process.env.PAUSE_PROBE) await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
await sleep(20000);
st = await status();
log('final', JSON.stringify(st.separation));
const lat = st.separation.latency;
check('(2) separation live', st.separation.state === 'on' && st.separation.choice?.state === 'on' && !st.separation.error && Number.isFinite(lat.processingMs), JSON.stringify(st.separation));
check('(2) no NaN in output', levels.length > 0 && !levels.some((l) => /NOT FINITE|NaN/.test(l)), `${levels.length} level lines: ${levels.slice(-2).join(' ; ')}`);
await ctx.close(); server.close();
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
