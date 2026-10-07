// SRI-235: variant x play table. node scripts/sri224/summarize-variants.mjs
import fs from 'fs';
const D = 'scripts/sri224/variants';
const med = a => { const s=[...a].sort((x,y)=>x-y); return s.length? s[s.length>>1]:null; };
for (const V of ['V0','V1','V2','V3','V4']) {
  const f = `${D}/${V}/qa-sri224-music${V === 'V4' ? '-def' : ''}.json`;
  if (!fs.existsSync(f)) { console.log(V, 'missing'); continue; }
  const r = JSON.parse(fs.readFileSync(f)).results.filter(x => x.kind === 'play' && /^(short3s|pseek)/.test(x.label) || x.kind==='play'&&x.scen==='pseek');
  const d = r.map(x => x.vfc?.at).filter(v => v != null);
  console.log(`\n${V}: first-rVFC median ${med(d)?.toFixed(0)} max ${Math.max(...d).toFixed(0)} n=${d.length}/${r.length}`);
  for (const x of r) console.log(`  ${x.scen}/${x.label}: rVFC ${x.vfc?x.vfc.at.toFixed(0):'none'} ms, mt-ct ${x.vfc?(x.vfc.lag*1000).toFixed(0):'-'} ms, vidOn ${x.vidOn}, outOn ${x.outOn}, AO ${x.AO}`);
}
