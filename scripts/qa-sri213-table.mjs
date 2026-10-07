import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const f = (x) => (x == null ? '   -' : String(Math.round(x)).padStart(5));
console.log('scen     label                                   | outOff outOn  elOn | ovOff ovOn vidOn |   A-O | silStart silEnd | lyric b/600/1500/2600/after | ov,delay cv eng');
for (const r of j.results) { if (!r.kind) { console.log(r.scen.padEnd(8), r.label.padEnd(40), JSON.stringify({ ov: r.ov, d1: r.d1, lat: r.lat && { engine: r.lat.engine, vd: r.lat.videoDelayMs }, before: r.before, after: r.after })); continue; }
  const l = r.lyric; console.log(r.scen.padEnd(8), r.label.padEnd(40), '|', f(r.outOff), f(r.outOn), f(r.elOn), '|', f(r.ovOff), f(r.ovOn), f(r.vidOn), '|', f(r.AO), '|', f(r.silStart), f(r.silEnd), '|', [l.before, l.at600, l.at1500, l.at2600, l.after].join('/'), '|', r.ov, Math.round(r.delayMs ?? 0), r.canvas, r.eng, 'rate', r.rate); }
