// Conversion of the desklib original -> 8-bit weights (extension/desklib_build.js) on a small,
// hand-built safetensors file. The values are chosen so that the scales are exact and the
// expected bytes are fixed by hand - including half values (rounding to the even number like numpy/ORT).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWeights } from "../../extension/desklib_build.js";

const f32 = (values) => new Uint8Array(new Float32Array(values).buffer);
const pad = (values, n) => [...values, ...Array(n - values.length).fill(0)];

// safetensors: 8-byte header length (u64 LE), JSON header, data area
function safetensors(tensors, { gapBefore = {}, dtype = {} } = {}) {
  const header = { __metadata__: { format: "pt" } };
  const parts = [];
  let off = 0;
  for (const [name, bytes] of Object.entries(tensors)) {
    if (gapBefore[name]) {
      parts.push(new Uint8Array(gapBefore[name]).fill(0xee));
      off += gapBefore[name];
    }
    header[name] = { dtype: dtype[name] || "F32", shape: [bytes.byteLength / 4], data_offsets: [off, off + bytes.byteLength] };
    parts.push(bytes);
    off += bytes.byteLength;
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(8);
  new DataView(len.buffer).setBigUint64(0, BigInt(json.byteLength), true);
  return concat([len, json, ...parts]);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) out.set(p, (off += p.byteLength) - p.byteLength);
  return out;
}

// Stream in small pieces - piece boundaries fall in the middle of the header and in the middle of float values
function streamOf(bytes, chunk = 3) {
  let pos = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (pos >= bytes.byteLength) return ctrl.close();
      ctrl.enqueue(bytes.slice(pos, (pos += chunk)));
    }
  });
}

// Rows of the nbits8 matrix (2 x 64, block size 32)
const W = [
  // Block 0: value with the largest magnitude -128 -> scale 1; half values round to the even number. Block 1: only zeros
  [...pad([-128, 2.5, 3.5, -2.5, -3.5, 0, 127], 32), ...pad([], 32)],
  // Block 0: maximum 64 (positive) -> scale -0.5, sign flips. Block 1: -2 -> scale 2/128
  [...pad([64, 32, -16, 1], 32), ...pad([-2, 1, 0.5], 32)]
];
// Word embeddings (3 x 4): scale = value with the largest magnitude / 127 per row
const EMB = [
  [127, -63.5, 0.5, 0],
  [0, 0, 0, 0],
  [-254, 1, 3, 0]
];

const recipe = {
  dataSize: 184,
  block: 32,
  tensors: {
    ln: { kind: "copy", targets: [0, 8] }, // used twice (shared weights)
    w: { kind: "nbits8", rows: 2, cols: 64, q: 16, scales: 144 },
    emb: { kind: "emb8", rows: 3, cols: 4, q: 160, scales: 172 }
  }
};

const model = (opts) =>
  safetensors({ ln: f32([1.5, -2]), unused: f32([9, 9, 9]), w: f32(W.flat()), emb: f32(EMB.flat()) }, opts);

describe("buildWeights", () => {
  it("copies, quantizes and skips tensors as in the build recipe", async () => {
    const bytes = model({ gapBefore: { w: 4 } });
    let progress = 0;
    const out = await buildWeights(streamOf(bytes), recipe, (n) => (progress = n));
    assert.equal(out.byteLength, recipe.dataSize);
    assert.equal(progress, bytes.byteLength);

    // copy: to both targets
    assert.deepEqual([...new Float32Array(out.buffer, 0, 4)], [1.5, -2, 1.5, -2]);

    // nbits8: uint8 with zero point 128, one scale per row and block
    const q = out.subarray(16, 144);
    assert.deepEqual([...q.subarray(0, 7)], [0, 130, 132, 126, 124, 128, 255]); // 127 -> 255
    assert.ok(q.subarray(7, 64).every((v) => v === 128));
    assert.deepEqual([...q.subarray(64, 68)], [0, 64, 160, 126]); // /-0.5: -128, -64, 32, -2
    assert.deepEqual([...q.subarray(96, 99)], [0, 192, 160]); // /0.015625: -128, 64, 32
    const scales = [...new Float32Array(out.buffer, 144, 4)];
    assert.deepEqual(scales.map((s) => (s === 0 ? 0 : s)), [1, 0, -0.5, 0.015625]);

    // emb8: int8 with one scale per row, zero row -> scale 1
    assert.deepEqual([...new Int8Array(out.buffer, 160, 12)], [127, -64, 0, 0, 0, 0, 0, 0, -127, 0, 2, 0]);
    assert.deepEqual([...new Float32Array(out.buffer, 172, 3)], [1, 1, 2]);
  });

  it("yields the same result regardless of the piece size of the download", async () => {
    const bytes = model();
    const a = await buildWeights(streamOf(bytes, 1), recipe);
    const b = await buildWeights(streamOf(bytes, 7), recipe);
    const c = await buildWeights(streamOf(bytes, bytes.byteLength), recipe);
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
  });

  it("aborts if the download ends prematurely", async () => {
    const bytes = model();
    await assert.rejects(buildWeights(streamOf(bytes.subarray(0, bytes.byteLength - 5)), recipe), /ended prematurely/);
  });

  it("aborts if the original file does not match the build recipe", async () => {
    const withoutEmb = safetensors({ ln: f32([1, 2]), w: f32(W.flat()) });
    await assert.rejects(buildWeights(streamOf(withoutEmb), recipe), /missing: emb/);

    await assert.rejects(buildWeights(streamOf(model({ dtype: { w: "F16" } })), recipe), /w: data type F16 instead of F32/);

    const short = { ...recipe, tensors: { ...recipe.tensors, emb: { ...recipe.tensors.emb, rows: 4 } } };
    await assert.rejects(buildWeights(streamOf(model()), short), /emb: 3 instead of 4 rows/);
  });
});
