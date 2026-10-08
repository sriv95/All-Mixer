#!/bin/sh
# Make an instrumented copy of dist (dist-qa) that records output RMS (pre-destination) into <html data-am-rms>.
set -e
rm -rf "$2"; cp -R "$1" "$2"
node -e '
const fs=require("fs");const f=process.argv[1]+"/content.js";let s=fs.readFileSync(f,"utf8");
const a="n.output.connect(e.destination)";if(!s.includes(a))throw new Error("anchor");
const probe="(()=>{const an=e.createAnalyser();an.fftSize=2048;n.output.connect(an);const b=new Float32Array(2048);const h=[];setInterval(()=>{an.getFloatTimeDomainData(b);let m=0,p=0;for(const x of b){m+=x*x;const q=Math.abs(x);if(q>p)p=q}const v=document.querySelector(\"video\");h.push([+(v?v.currentTime:-1).toFixed(2),+(10*Math.log10(m/b.length+1e-12)).toFixed(1),+(20*Math.log10(p+1e-9)).toFixed(1)]);if(h.length>6000)h.shift();document.documentElement.dataset.amRms=JSON.stringify(h.slice(-1500))},50)})()";
s=s.replace(a,a+","+probe);fs.writeFileSync(f,s)' "$2"
