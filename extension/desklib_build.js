// Baut die Gewichtsdatei für das desklib-Modell aus dem Original (model.safetensors, fp32) nach der
// Bauanleitung models/desklib/recipe.json (erzeugt von scripts/build_desklib_skeleton.py).
// Die 1,7 GB werden als Stream gelesen und zeilenweise quantisiert - es liegt nie das ganze
// Original im Speicher, nur das Ergebnis (~475 MB).

// numpy/ORT runden halbe Werte zur geraden Zahl, Math.round immer nach oben
function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// MatMulNBits, 8 Bit symmetrisch (wie onnxruntime.quantization): pro Block Skala = betragsgrößter
// Wert / -128, gespeichert als uint8 mit Nullpunkt 128.
function quantizeNbits8Row(row, n, t, out, block) {
  const cols = row.length;
  const blocks = cols / block;
  const q = out.subarray(t.q + n * cols, t.q + (n + 1) * cols);
  const scales = new Float32Array(out.buffer, out.byteOffset + t.scales + n * blocks * 4, blocks);
  for (let b = 0; b < blocks; b++) {
    let max = 0;
    let maxAbs = 0;
    for (let j = b * block; j < (b + 1) * block; j++) {
      const a = Math.abs(row[j]);
      if (a > maxAbs) {
        maxAbs = a;
        max = row[j];
      }
    }
    const scale = Math.fround(max / -128);
    scales[b] = scale;
    for (let j = b * block; j < (b + 1) * block; j++) {
      const v = scale === 0 ? 0 : roundHalfEven(Math.fround(row[j] / scale));
      q[j] = Math.min(255, Math.max(0, v + 128));
    }
  }
}

// Wort-Embeddings: int8 mit einer Skala pro Zeile (betragsgrößter Wert / 127)
function quantizeEmbRow(row, n, t, out) {
  const cols = row.length;
  let maxAbs = 0;
  for (let j = 0; j < cols; j++) maxAbs = Math.max(maxAbs, Math.abs(row[j]));
  const scale = maxAbs === 0 ? 1 : Math.fround(maxAbs / 127);
  new Float32Array(out.buffer, out.byteOffset + t.scales + n * 4, 1)[0] = scale;
  const q = new Int8Array(out.buffer, out.byteOffset + t.q + n * cols, cols);
  for (let j = 0; j < cols; j++) q[j] = Math.min(127, Math.max(-127, roundHalfEven(Math.fround(row[j] / scale))));
}

// Liest exakt n Bytes nacheinander aus einem ReadableStream-Reader
class ByteReader {
  constructor(reader, onBytes) {
    this.reader = reader;
    this.onBytes = onBytes;
    this.chunk = new Uint8Array(0);
    this.pos = 0;
  }

  async next() {
    const { done, value } = await this.reader.read();
    if (done) throw new Error("Download vorzeitig beendet");
    this.chunk = value;
    this.pos = 0;
    this.onBytes(value.byteLength);
  }

  // ruft sink(teilstück) für aufeinanderfolgende Stücke auf, bis n Bytes gelesen sind
  async read(n, sink) {
    while (n > 0) {
      if (this.pos >= this.chunk.byteLength) await this.next();
      const take = Math.min(n, this.chunk.byteLength - this.pos);
      sink(this.chunk.subarray(this.pos, this.pos + take));
      this.pos += take;
      n -= take;
    }
  }

  async readAll(n) {
    const buf = new Uint8Array(n);
    let off = 0;
    await this.read(n, (part) => {
      buf.set(part, off);
      off += part.byteLength;
    });
    return buf;
  }
}

/**
 * @param {ReadableStream<Uint8Array>} stream  Inhalt von model.safetensors
 * @param {object} recipe  recipe.json
 * @param {(loaded: number) => void} onProgress  gelesene Bytes insgesamt
 * @returns {Promise<Uint8Array>} Inhalt der .onnx_data-Datei
 */
export async function buildWeights(stream, recipe, onProgress = () => {}) {
  let loaded = 0;
  const bytes = new ByteReader(stream.getReader(), (n) => onProgress((loaded += n)));
  const headerLen = Number(new DataView((await bytes.readAll(8)).buffer).getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(await bytes.readAll(headerLen)));
  delete header.__metadata__;

  const out = new Uint8Array(recipe.dataSize);
  const tensors = Object.entries(header).sort((a, b) => a[1].data_offsets[0] - b[1].data_offsets[0]);
  const missing = Object.keys(recipe.tensors).filter((k) => !header[k]);
  if (missing.length) throw new Error(`Originaldatei passt nicht zur Bauanleitung (fehlt: ${missing[0]})`);

  let pos = 0; // Position im Datenbereich
  for (const [name, info] of tensors) {
    const [begin, end] = info.data_offsets;
    await bytes.read(begin - pos, () => {}); // Lücke überspringen (gibt es normalerweise nicht)
    const size = end - begin;
    const t = recipe.tensors[name];
    if (!t) {
      await bytes.read(size, () => {});
    } else if (info.dtype !== "F32") {
      throw new Error(`${name}: Datentyp ${info.dtype} statt F32`);
    } else if (t.kind === "copy") {
      let off = 0;
      await bytes.read(size, (part) => {
        for (const target of t.targets) out.set(part, target + off);
        off += part.byteLength;
      });
    } else {
      // zeilenweise: Zeile sammeln (Stücke können mitten in einer Zahl enden), dann quantisieren
      const rowBytes = t.cols * 4;
      const rowBuf = new Uint8Array(rowBytes);
      const row = new Float32Array(rowBuf.buffer);
      let fill = 0;
      let n = 0;
      await bytes.read(size, (part) => {
        let p = 0;
        while (p < part.byteLength) {
          const take = Math.min(rowBytes - fill, part.byteLength - p);
          rowBuf.set(part.subarray(p, p + take), fill);
          fill += take;
          p += take;
          if (fill === rowBytes) {
            if (t.kind === "nbits8") quantizeNbits8Row(row, n, t, out, recipe.block);
            else quantizeEmbRow(row, n, t, out);
            n++;
            fill = 0;
          }
        }
      });
      if (n !== t.rows) throw new Error(`${name}: ${n} statt ${t.rows} Zeilen`);
    }
    pos = end;
  }
  return out;
}
