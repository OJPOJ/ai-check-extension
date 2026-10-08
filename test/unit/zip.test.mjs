// ZIP writer for npm run package (scripts/zip.mjs): readable, lossless, reproducible.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createZip, readZip } from "../../scripts/zip.mjs";

const entries = [
  { name: "manifest.json", data: Buffer.from('{"name":"x"}\n'.repeat(50)) }, // compressible -> deflate
  { name: "vendor/random.bin", data: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251)) },
  { name: "bg/ümlaut.js", data: Buffer.from("// ä\n") },
  { name: "empty.txt", data: Buffer.alloc(0) }
];
const mtime = new Date("2026-09-25T12:34:56Z");

describe("createZip", () => {
  it("reads every file back unchanged, sorted by name", () => {
    const back = readZip(createZip(entries, { mtime }));
    assert.deepEqual(back.map((e) => e.name), ["bg/ümlaut.js", "empty.txt", "manifest.json", "vendor/random.bin"]);
    for (const e of entries) assert.ok(back.find((b) => b.name === e.name).data.equals(e.data), e.name);
  });

  it("compresses only if it gets smaller", () => {
    const back = readZip(createZip(entries, { mtime }));
    assert.equal(back.find((b) => b.name === "manifest.json").method, 8);
    assert.equal(back.find((b) => b.name === "empty.txt").method, 0);
  });

  it("is reproducible: same input (even reordered) = same bytes", () => {
    const a = createZip(entries, { mtime });
    const b = createZip([...entries].reverse(), { mtime });
    assert.ok(a.equals(b));
    assert.ok(!a.equals(createZip(entries, { mtime: new Date("2026-09-26T00:00:00Z") })));
  });

  it("rejects Windows paths and absolute names", () => {
    assert.throws(() => createZip([{ name: "bg\\a.js", data: Buffer.alloc(1) }]));
    assert.throws(() => createZip([{ name: "/a.js", data: Buffer.alloc(1) }]));
  });

  it("is readable by a third-party program (tar/bsdtar or unzip, if available)", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aivsai-zip-"));
    const file = path.join(dir, "t.zip");
    fs.writeFileSync(file, createZip(entries, { mtime }));
    let listing;
    for (const [cmd, args] of [["tar", ["-tf", file]], ["unzip", ["-Z1", file]]]) {
      try {
        listing = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        break;
      } catch {
        // program missing or cannot read zip (GNU tar) - try the next one
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (!listing) return t.skip("neither bsdtar nor unzip available");
    // The console output (code page) mangles non-ASCII names, not the zip - readZip above checks those
    for (const e of entries.filter((x) => /^[\x20-\x7e]+$/.test(x.name))) {
      assert.ok(listing.includes(e.name), `${e.name} in:\n${listing}`);
    }
    assert.equal(listing.trim().split(/\r?\n/).length, entries.length);
  });
});
