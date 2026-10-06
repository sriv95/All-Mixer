// SRI-202: per-event first edges after the action (page clock), from the saved probe log lines.
import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const E = j.logs.map((l) => { const m = l.match(/^(\d+) (\w+) (\{.*\})$/); if (!m) return null; try { return { kind: m[2], ...JSON.parse(m[3]) }; } catch { return null; } }).filter(Boolean);
const t = (e) => e.audibleAt ?? e.at;
const f = (x) => (x == null ? '   -   ' : x.toFixed(0).padStart(7));
console.log('event                              ad  eng  vidDelay ov(state,delay,queue) cv   | firstAudio  firstVideo firstOverlay | audio-video audio-overlay | ml eng at audio edge');
for (const e of j.events) {
  const a = e.actAt; const on = /play|seek/.test(e.label) && !/^pause/.test(e.label); const end = e.nowAt;
  const edge = (kinds) => E.filter((x) => kinds.includes(x.kind) && t(x) >= a - 50 && t(x) <= end + 3000).sort((p, q) => t(p) - t(q))[0];
  const kA = on ? ['audioOn'] : ['audioOff']; const kV = on ? ['videoOn'] : ['videoOff']; const kO = on ? ['overlayOn'] : ['overlayOff'];
  const A = edge(kA), V = edge(kV), O = edge(kO);
  const pic = O ?? V;
  console.log(e.label.padEnd(34), String(e.ad).padEnd(5), String(e.latency?.engine).padEnd(4), String(e.latency?.videoDelayMs?.toFixed(0)).padStart(5), `${e.overlay?.state},${e.overlay?.delayMs?.toFixed(0)},q${e.overlay?.stats?.queued}`.padEnd(18), e.dom.canvas.padEnd(6), '|', f(A && t(A) - a), f(V && t(V) - a), f(O && t(O) - a), '|', f(A && V && t(A) - t(V)), f(A && O && t(A) - t(O)), '|', A?.engine ?? '-');
}
