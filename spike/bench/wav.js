// Minimal WAV I/O for the benchmark (PCM16 / float32 in, float32 out).
import fs from 'node:fs';

export function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt, data;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  const bps = fmt.bits / 8, frames = data.length / (bps * fmt.ch);
  const ch = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
  const isFloat = fmt.format === 3 || (fmt.format === 0xfffe && fmt.bits === 32);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < fmt.ch; c++) {
      const o = (i * fmt.ch + c) * bps;
      ch[c][i] = isFloat ? data.readFloatLE(o) : data.readInt16LE(o) / 32768;
    }
  return { sampleRate: fmt.sr, channels: ch };
}

export function writeWav(file, sampleRate, channels) {
  const n = channels[0].length, nc = channels.length, b = Buffer.alloc(44 + n * nc * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * nc * 4, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(nc, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * nc * 4, 28); b.writeUInt16LE(nc * 4, 32);
  b.writeUInt16LE(32, 34); b.write('data', 36); b.writeUInt32LE(n * nc * 4, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) b.writeFloatLE(channels[c][i], 44 + (i * nc + c) * 4);
  fs.writeFileSync(file, b);
}
