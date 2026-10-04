// Spins and publishes performance.now() (ms) into a SharedArrayBuffer so the AudioWorklet can time itself.
let a;
onmessage = (e) => { a = new Float64Array(e.data); for (;;) a[0] = performance.now(); };
