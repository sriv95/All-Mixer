// Load generator for SRI-236: second Chromium playing a 1080p YouTube video + busy-loop worker pages.
import { createRequire } from 'node:module'; import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { chromium } = createRequire(path.join(root, 'spike/package.json'))('playwright');
const b = await chromium.launch({ headless: false, channel: 'chromium', args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ'); await p.waitForTimeout(4000);
await p.evaluate(() => document.querySelector('video')?.play());
for (let i = 0; i < 3; i++) { const q = await b.newPage(); await q.goto('about:blank'); await q.evaluate(() => { new Worker(URL.createObjectURL(new Blob(['for(;;){Math.sqrt(Math.random())}']))); }); }
console.log('loaded'); await new Promise(r => setTimeout(r, 1800000));
