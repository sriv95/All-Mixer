import { describe, expect, it } from 'vitest';
import { setDynamicDim } from './onnx-dyn-dim.mjs';

const te = new TextEncoder();
const vi = (n) => (n < 128 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);
const len = (num, body) => [(num << 3) | 2, ...vi(body.length), ...body];
const str = (num, s) => len(num, [...te.encode(s)]);
const dimValue = (n) => [0x08, ...vi(n)];
const valueInfo = (name, dims) =>
  [...str(1, name), ...len(2, len(1, len(2, dims.flatMap((d) => len(1, d)))))];
const model = (inputs, outputs) => {
  const graph = [
    ...len(1, [...str(1, 'node')]), // unrelated NodeProto, must stay verbatim
    ...inputs.flatMap(([n, d]) => len(11, valueInfo(n, d))),
    ...outputs.flatMap(([n, d]) => len(12, valueInfo(n, d))),
  ];
  return Uint8Array.from([0x08, 8, ...len(7, graph), ...str(2, 'tail')]); // ir_version, graph, producer
};

// Minimal decoder for assertions.
function fields(buf) {
  const out = [];
  for (let p = 0; p < buf.length; ) {
    const tag = buf[p++];
    const num = tag >> 3;
    if ((tag & 7) === 0) { let v = 0, s = 0, b; do { b = buf[p++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); out.push({ num, v }); continue; }
    let l = 0, s = 0, b;
    do { b = buf[p++]; l |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    out.push({ num, body: buf.subarray(p, p + l) });
    p += l;
  }
  return out;
}
const dimsOf = (valueInfoBytes) => {
  const type = fields(valueInfoBytes).find((f) => f.num === 2).body;
  const tensor = fields(type).find((f) => f.num === 1).body;
  const shape = fields(tensor).find((f) => f.num === 2).body;
  return fields(shape).filter((f) => f.num === 1).map((f) => {
    const d = fields(f.body)[0];
    return d.num === 1 ? d.v : new TextDecoder().decode(d.body);
  });
};
const graphOf = (m) => fields(m).find((f) => f.num === 7).body;

describe('setDynamicDim', () => {
  const m = model([['x', [2, 1, 512, 1024].map(dimValue)]], [['y', [2, 1, 512, 1024].map(dimValue)]]);
  const out = setDynamicDim(m);

  it('turns dim 2 of inputs and outputs into dim_param "T" and keeps the others', () => {
    const g = fields(graphOf(out));
    expect(dimsOf(g.find((f) => f.num === 11).body)).toEqual([2, 1, 'T', 1024]);
    expect(dimsOf(g.find((f) => f.num === 12).body)).toEqual([2, 1, 'T', 1024]);
  });

  it('copies untouched bytes verbatim', () => {
    expect(Array.from(out.subarray(0, 2))).toEqual([0x08, 8]);
    expect(Array.from(out.subarray(out.length - 6))).toEqual(Array.from(m.subarray(m.length - 6)));
    const node = (b) => fields(graphOf(b)).find((f) => f.num === 1).body;
    expect(Array.from(node(out))).toEqual(Array.from(node(m)));
  });

  it('re-encodes length prefixes when the graph grows past 127 bytes', () => {
    const big = model([['a', [1, 1, 512, 1].map(dimValue)], ['b'.repeat(200), [2, 1, 512, 1024].map(dimValue)]], []);
    const r = setDynamicDim(big);
    const ins = fields(graphOf(r)).filter((f) => f.num === 11);
    expect(ins.map((f) => dimsOf(f.body))).toEqual([[1, 1, 'T', 1], [2, 1, 'T', 1024]]);
  });

  it('leaves the input untouched and throws when there is nothing to patch', () => {
    const copy = Uint8Array.from(m);
    setDynamicDim(m);
    expect(m).toEqual(copy);
    expect(() => setDynamicDim(out)).toThrow();
  });
});
