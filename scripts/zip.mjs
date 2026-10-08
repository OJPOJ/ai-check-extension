// Minimal ZIP writer (deflate, no ZIP64) without dependencies - for scripts/package.mjs.
// Reproducible: entries sorted, fixed timestamps, no permissions/extra fields. Same files
// + same mtime = byte-identical zip.
import zlib from "zlib";

// DOS time format, 2-second resolution, from 1980. UTC, so the zip does not depend on the time zone.
function dosDateTime(date) {
  const d = new Date(Math.max(date.getTime(), Date.UTC(1980, 0, 1)));
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const day = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, day };
}

// entries: [{name: "a/b.js", data: Buffer}], name with "/" and without a leading slash
export function createZip(entries, { mtime = new Date(Date.UTC(1980, 0, 1)) } = {}) {
  const { time, day } = dosDateTime(mtime);
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const local = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of sorted) {
    if (!name || name.startsWith("/") || name.includes("\\")) throw new Error(`invalid name in zip: ${name}`);
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length; // already compressed (e.g. .wasm) -> store unchanged
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = zlib.crc32(data);
    if (offset + body.length > 0xffffffff) throw new Error("zip larger than 4 GB (no ZIP64)");

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // required version 2.0
    lh.writeUInt16LE(0x0800, 6); // bit 11: names in UTF-8
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
    ch.writeUInt16LE(20, 4); // created with 2.0 (MS-DOS attributes)
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(day, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    // extra, comment, disk, internal/external attributes: 0
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cdSize = central.reduce((n, b) => n + b.length, 0);
  if (sorted.length > 0xffff) throw new Error("too many entries (no ZIP64)");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, eocd]);
}

// Counterpart for verification (tests, package.mjs): reads the central directory and unpacks every entry.
export function readZip(buf) {
  const eocdAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdAt < 0) throw new Error("not a zip (end record missing)");
  const count = buf.readUInt16LE(eocdAt + 10);
  let p = buf.readUInt32LE(eocdAt + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`directory entry ${i} corrupted`);
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
    if (zlib.crc32(data) !== crc) throw new Error(`CRC mismatch: ${name}`);
    out.push({ name, data, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
