(function(){
  const OC = AudioNode.prototype.connect; window.__out = []; window.__el = [];
  const mk = (ac, node, arr) => { const a = new AnalyserNode(ac, { fftSize: 256 }); OC.call(node, a); const b = new Float32Array(256);
    setInterval(() => { a.getFloatTimeDomainData(b); let s = 0; for (const x of b) s += x * x; arr.push([performance.now(), Math.sqrt(s / b.length)]); if (arr.length > 20000) arr.shift(); }, 5); };
  const oc = AudioNode.prototype.connect; const seen = new WeakSet();
  AudioNode.prototype.connect = function (d, ...r) { if (d && d === this.context.destination && !seen.has(this)) { seen.add(this); if (this.context.__tapped === undefined) { this.context.__tapped = 1; setTimeout(() => mk(this.context, this, window.__out), 0); } } return oc.call(this, d, ...r); };
  const ce = AudioContext.prototype.createMediaElementSource; AudioContext.prototype.createMediaElementSource = function (e) { const n = ce.call(this, e); if (!window.__elTapped) { window.__elTapped = 1; setTimeout(() => mk(this, n, window.__el), 0); } return n; };

  document.addEventListener('am-dump', () => document.documentElement.setAttribute('data-am-dump', JSON.stringify({ out: window.__out, el: window.__el })));
})();
