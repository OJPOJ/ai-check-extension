// Umwandlung desklib-Original -> 8-Bit-Gewichte (extension/desklib_build.js) an einer kleinen,
// von Hand gebauten safetensors-Datei. Die Werte sind so gewählt, dass die Skalen exakt sind und die
// erwarteten Bytes von Hand feststehen - inklusive halber Werte (Rundung zur geraden Zahl wie numpy/ORT).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWeights } from "../../extension/desklib_build.js";

const f32 = (values) => new Uint8Array(new Float32Array(values).buffer);
const pad = (values, n) => [...values, ...Array(n - values.length).fill(0)];

// safetensors: 8 Byte Header-Länge (u64 LE), JSON-Header, Datenbereich
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

// Stream in kleinen Stücken - Stückgrenzen liegen mitten im Header und mitten in Float-Werten
function streamOf(bytes, chunk = 3) {
  let pos = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (pos >= bytes.byteLength) return ctrl.close();
      ctrl.enqueue(bytes.slice(pos, (pos += chunk)));
    }
  });
}

// Zeilen der nbits8-Matrix (2 x 64, Blockgröße 32)
const W = [
  // Block 0: betragsgrößter Wert -128 -> Skala 1; halbe Werte runden zur geraden Zahl. Block 1: nur Nullen
  [...pad([-128, 2.5, 3.5, -2.5, -3.5, 0, 127], 32), ...pad([], 32)],
  // Block 0: Maximum 64 (positiv) -> Skala -0.5, Vorzeichen dreht sich. Block 1: -2 -> Skala 2/128
  [...pad([64, 32, -16, 1], 32), ...pad([-2, 1, 0.5], 32)]
];
// Wort-Embeddings (3 x 4): Skala = betragsgrößter Wert / 127 pro Zeile
const EMB = [
  [127, -63.5, 0.5, 0],
  [0, 0, 0, 0],
  [-254, 1, 3, 0]
];

const recipe = {
  dataSize: 184,
  block: 32,
  tensors: {
    ln: { kind: "copy", targets: [0, 8] }, // zweimal verwendet (geteilte Gewichte)
    w: { kind: "nbits8", rows: 2, cols: 64, q: 16, scales: 144 },
    emb: { kind: "emb8", rows: 3, cols: 4, q: 160, scales: 172 }
  }
};

const model = (opts) =>
  safetensors({ ln: f32([1.5, -2]), unbenutzt: f32([9, 9, 9]), w: f32(W.flat()), emb: f32(EMB.flat()) }, opts);

describe("buildWeights", () => {
  it("kopiert, quantisiert und überspringt Tensoren wie in der Bauanleitung", async () => {
    const bytes = model({ gapBefore: { w: 4 } });
    let progress = 0;
    const out = await buildWeights(streamOf(bytes), recipe, (n) => (progress = n));
    assert.equal(out.byteLength, recipe.dataSize);
    assert.equal(progress, bytes.byteLength);

    // copy: an beide Ziele
    assert.deepEqual([...new Float32Array(out.buffer, 0, 4)], [1.5, -2, 1.5, -2]);

    // nbits8: uint8 mit Nullpunkt 128, eine Skala pro Zeile und Block
    const q = out.subarray(16, 144);
    assert.deepEqual([...q.subarray(0, 7)], [0, 130, 132, 126, 124, 128, 255]); // 127 -> 255
    assert.ok(q.subarray(7, 64).every((v) => v === 128));
    assert.deepEqual([...q.subarray(64, 68)], [0, 64, 160, 126]); // /-0.5: -128, -64, 32, -2
    assert.deepEqual([...q.subarray(96, 99)], [0, 192, 160]); // /0.015625: -128, 64, 32
    const scales = [...new Float32Array(out.buffer, 144, 4)];
    assert.deepEqual(scales.map((s) => (s === 0 ? 0 : s)), [1, 0, -0.5, 0.015625]);

    // emb8: int8 mit einer Skala pro Zeile, Nullzeile -> Skala 1
    assert.deepEqual([...new Int8Array(out.buffer, 160, 12)], [127, -64, 0, 0, 0, 0, 0, 0, -127, 0, 2, 0]);
    assert.deepEqual([...new Float32Array(out.buffer, 172, 3)], [1, 1, 2]);
  });

  it("liefert dasselbe Ergebnis unabhängig von der Stückgröße des Downloads", async () => {
    const bytes = model();
    const a = await buildWeights(streamOf(bytes, 1), recipe);
    const b = await buildWeights(streamOf(bytes, 7), recipe);
    const c = await buildWeights(streamOf(bytes, bytes.byteLength), recipe);
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
  });

  it("bricht ab, wenn der Download vorzeitig endet", async () => {
    const bytes = model();
    await assert.rejects(buildWeights(streamOf(bytes.subarray(0, bytes.byteLength - 5)), recipe), /vorzeitig beendet/);
  });

  it("bricht ab, wenn die Originaldatei nicht zur Bauanleitung passt", async () => {
    const ohneEmb = safetensors({ ln: f32([1, 2]), w: f32(W.flat()) });
    await assert.rejects(buildWeights(streamOf(ohneEmb), recipe), /fehlt: emb/);

    await assert.rejects(buildWeights(streamOf(model({ dtype: { w: "F16" } })), recipe), /w: Datentyp F16 statt F32/);

    const kurz = { ...recipe, tensors: { ...recipe.tensors, emb: { ...recipe.tensors.emb, rows: 4 } } };
    await assert.rejects(buildWeights(streamOf(model()), kurz), /emb: 3 statt 4 Zeilen/);
  });
});
