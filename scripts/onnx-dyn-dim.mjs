// Minimal protobuf rewriter: set the time axis (dim index 2) of every graph input/output
// of an ONNX ModelProto to the symbolic dimension "T" (dim_value 512 -> dim_param "T").
// Only the changed nested messages are re-encoded; every other byte is copied verbatim.

const enc = new TextEncoder();

function readVarint(buf, pos) {
  let result = 0;
  let mul = 1;
  for (;;) {
    const b = buf[pos++];
    result += (b & 0x7f) * mul;
    if (!(b & 0x80)) return [result, pos];
    mul *= 128;
  }
}

function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Uint8Array.from(out);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Split a message into fields: { num, wt, start, end (whole field), bodyStart, bodyEnd (LEN payload) }. */
function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const num = Math.floor(tag / 8);
    const wt = tag % 8;
    let bodyStart = pos;
    let bodyEnd;
    if (wt === 0) {
      [, pos] = readVarint(buf, pos);
      bodyEnd = pos;
    } else if (wt === 1) {
      pos += 8;
      bodyEnd = pos;
    } else if (wt === 5) {
      pos += 4;
      bodyEnd = pos;
    } else if (wt === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      bodyStart = pos;
      pos += len;
      bodyEnd = pos;
    } else {
      throw new Error(`unsupported protobuf wire type ${wt}`);
    }
    if (pos > buf.length) throw new Error('truncated protobuf message');
    out.push({ num, wt, start, end: pos, bodyStart, bodyEnd });
  }
  return out;
}

/** Rebuild `buf`, replacing the body of fields for which `fn(body, field)` returns a new Uint8Array. */
function rewrite(buf, num, fn) {
  const parts = [];
  let last = 0;
  let changed = false;
  let index = 0;
  for (const f of fields(buf)) {
    if (f.num !== num || f.wt !== 2) continue;
    const next = fn(buf.subarray(f.bodyStart, f.bodyEnd), index++);
    if (!next) continue;
    changed = true;
    parts.push(buf.subarray(last, f.start), tagBytes(num), varint(next.length), next);
    last = f.end;
  }
  if (!changed) return null;
  parts.push(buf.subarray(last));
  return concat(parts);
}

const tagBytes = (num) => varint(num * 8 + 2);

// TensorShapeProto.dim (1) -> Dimension: dim_value (1, varint) / dim_param (2, string)
function patchDim(dim, symbol) {
  const dimParam = concat([tagBytes(2), varint(symbol.length), enc.encode(symbol)]);
  const fs = fields(dim);
  if (fs.length === 1 && fs[0].num === 2) return null; // already symbolic
  const v = fs.find((f) => f.num === 1);
  if (!v) throw new Error('dim has neither dim_value nor dim_param');
  // Keep other fields (e.g. denotation, 3) verbatim; swap only dim_value.
  return concat([dim.subarray(0, v.start), dimParam, dim.subarray(v.end)]);
}

function patchValueInfo(vi, axis, symbol) {
  return rewrite(vi, 2, (type) =>
    rewrite(type, 1, (tensor) =>
      rewrite(tensor, 2, (shape) =>
        rewrite(shape, 1, (dim, i) => (i === axis ? patchDim(dim, symbol) : null)),
      ),
    ),
  );
}

/**
 * @param {Uint8Array} model serialized ModelProto
 * @param {{axis?: number, symbol?: string}} [opts]
 * @returns {Uint8Array} patched ModelProto (a copy; input is not modified)
 */
export function setDynamicDim(model, { axis = 2, symbol = 'T' } = {}) {
  const patched = rewrite(model, 7, (graph) => {
    let g = graph;
    for (const num of [11, 12]) {
      g = rewrite(g, num, (vi) => patchValueInfo(vi, axis, symbol)) ?? g;
    }
    return g === graph ? null : g;
  });
  if (!patched) throw new Error(`no graph input/output with a fixed dim ${axis} found`);
  return patched;
}
