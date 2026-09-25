// ZIP-Schreiber für npm run package (scripts/zip.mjs): lesbar, verlustfrei, reproduzierbar.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createZip, readZip } from "../../scripts/zip.mjs";

const entries = [
  { name: "manifest.json", data: Buffer.from('{"name":"x"}\n'.repeat(50)) }, // komprimierbar -> Deflate
  { name: "vendor/random.bin", data: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251)) },
  { name: "bg/ümlaut.js", data: Buffer.from("// ä\n") },
  { name: "leer.txt", data: Buffer.alloc(0) }
];
const mtime = new Date("2026-09-25T12:34:56Z");

describe("createZip", () => {
  it("liest jede Datei unverändert zurück, sortiert nach Namen", () => {
    const back = readZip(createZip(entries, { mtime }));
    assert.deepEqual(back.map((e) => e.name), ["bg/ümlaut.js", "leer.txt", "manifest.json", "vendor/random.bin"]);
    for (const e of entries) assert.ok(back.find((b) => b.name === e.name).data.equals(e.data), e.name);
  });

  it("komprimiert nur, wenn es kleiner wird", () => {
    const back = readZip(createZip(entries, { mtime }));
    assert.equal(back.find((b) => b.name === "manifest.json").method, 8);
    assert.equal(back.find((b) => b.name === "leer.txt").method, 0);
  });

  it("ist reproduzierbar: gleiche Eingabe (auch umsortiert) = gleiche Bytes", () => {
    const a = createZip(entries, { mtime });
    const b = createZip([...entries].reverse(), { mtime });
    assert.ok(a.equals(b));
    assert.ok(!a.equals(createZip(entries, { mtime: new Date("2026-09-26T00:00:00Z") })));
  });

  it("lehnt Windows-Pfade und absolute Namen ab", () => {
    assert.throws(() => createZip([{ name: "bg\\a.js", data: Buffer.alloc(1) }]));
    assert.throws(() => createZip([{ name: "/a.js", data: Buffer.alloc(1) }]));
  });

  it("ist für ein fremdes Programm lesbar (tar/bsdtar bzw. unzip, falls vorhanden)", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aivsai-zip-"));
    const file = path.join(dir, "t.zip");
    fs.writeFileSync(file, createZip(entries, { mtime }));
    let listing;
    for (const [cmd, args] of [["tar", ["-tf", file]], ["unzip", ["-Z1", file]]]) {
      try {
        listing = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        break;
      } catch {
        // Programm fehlt oder kann kein Zip (GNU tar) - nächstes versuchen
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (!listing) return t.skip("weder bsdtar noch unzip verfügbar");
    // Nicht-ASCII-Namen verstümmelt die Konsolenausgabe (Codepage), nicht das Zip - die prüft readZip oben
    for (const e of entries.filter((x) => /^[\x20-\x7e]+$/.test(x.name))) {
      assert.ok(listing.includes(e.name), `${e.name} in:\n${listing}`);
    }
    assert.equal(listing.trim().split(/\r?\n/).length, entries.length);
  });
});
