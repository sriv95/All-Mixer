import fs from 'node:fs';
for (const d of process.argv.slice(2)) { const {results}=JSON.parse(fs.readFileSync(d+'/qa-sri224-music.json','utf8')); console.log('==',d); let late=0,plays=0,vf=[];
 for (const r of results){ if(r.kind!=='play') continue; const f=r.vfc; plays++; if(f&&f.at>100)late++; if(f)vf.push(Math.round(f.at));
  console.log([r.scen,r.label,'AO='+r.AO,'ovOn='+r.ovOn,'outOn='+r.outOn,'vfc='+(f?Math.round(f.at):'-'),'mt-ct='+(f?(-f.lag*1000).toFixed(0)+'ms':'-')].join(' | ')); }
 console.log('plays',plays,'first-rVFC>100ms:',late,'max',Math.max(...vf)); }
