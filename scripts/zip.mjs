// Minimaler ZIP-Schreiber (Deflate, kein ZIP64) ohne Abhängigkeiten - für scripts/package.mjs.
// Reproduzierbar: Einträge sortiert, feste Zeitstempel, keine Rechte/Extra-Felder. Gleiche Dateien
// + gleiche mtime = byte-gleiches Zip.
import zlib from "zlib";

// DOS-Zeitformat, 2-Sekunden-Auflösung, ab 1980. UTC, damit das Zip nicht von der Zeitzone abhängt.
function dosDateTime(date) {
  const d = new Date(Math.max(date.getTime(), Date.UTC(1980, 0, 1)));
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const day = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, day };
}

// entries: [{name: "a/b.js", data: Buffer}], name mit "/" und ohne führenden Slash
export function createZip(entries, { mtime = new Date(Date.UTC(1980, 0, 1)) } = {}) {
  const { time, day } = dosDateTime(mtime);
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const local = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of sorted) {
    if (!name || name.startsWith("/") || name.includes("\\")) throw new Error(`ungültiger Name im Zip: ${name}`);
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length; // schon komprimiert (z.B. .wasm) -> unverändert ablegen
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = zlib.crc32(data);
    if (offset + body.length > 0xffffffff) throw new Error("Zip größer als 4 GB (kein ZIP64)");

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // benötigte Version 2.0
    lh.writeUInt16LE(0x0800, 6); // Bit 11: Namen in UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(day, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // erstellt mit 2.0 (MS-DOS-Attribute)
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(day, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    // Extra, Kommentar, Disk, interne/externe Attribute: 0
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cdSize = central.reduce((n, b) => n + b.length, 0);
  if (sorted.length > 0xffff) throw new Error("zu viele Einträge (kein ZIP64)");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, eocd]);
}

// Gegenstück zum Prüfen (Tests, package.mjs): liest das zentrale Verzeichnis und entpackt jeden Eintrag.
export function readZip(buf) {
  const eocdAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdAt < 0) throw new Error("kein Zip (Endeintrag fehlt)");
  const count = buf.readUInt16LE(eocdAt + 10);
  let p = buf.readUInt32LE(eocdAt + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`Verzeichniseintrag ${i} beschädigt`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    if (zlib.crc32(data) !== crc) throw new Error(`CRC falsch: ${name}`);
    out.push({ name, data, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
