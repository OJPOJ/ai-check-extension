// Icons fürs Manifest/den Store (WP-03): jede in manifest.json referenzierte Icon-Datei existiert
// und ist ein PNG mit genau der Breite/Höhe, die der Schlüssel verspricht. Fängt Tippfehler in
// manifest.json und ein kaputtes/veraltetes scripts/build-icons.mjs (npm run build:icons) ab, ohne
// dafür einen Browser zu brauchen.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extDir = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));

// Breite/Höhe aus dem IHDR-Chunk lesen (PNG-Signatur 8 Byte, dann Länge+Typ, dann die Werte).
function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${file}: keine PNG-Signatur`);
  assert.equal(buf.toString("ascii", 12, 16), "IHDR", `${file}: kein IHDR-Chunk an der erwarteten Stelle`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("Icons (manifest.json)", () => {
  it("hat 16/32/48/128 px unter icons und action.default_icon", () => {
    for (const key of ["16", "32", "48", "128"]) {
      assert.ok(manifest.icons?.[key], `icons["${key}"] fehlt`);
      assert.ok(manifest.action?.default_icon?.[key], `action.default_icon["${key}"] fehlt`);
    }
  });

  it("jede referenzierte Datei existiert und ist quadratisch in der versprochenen Größe", () => {
    const refs = { ...manifest.icons, ...manifest.action?.default_icon };
    for (const [size, rel] of Object.entries(refs)) {
      const file = path.join(extDir, rel);
      assert.ok(fs.existsSync(file), `${rel} (Schlüssel ${size}) fehlt unter extension/`);
      const { width, height } = pngSize(file);
      assert.equal(width, Number(size), `${rel}: Breite ${width} != ${size}`);
      assert.equal(height, Number(size), `${rel}: Höhe ${height} != ${size}`);
    }
  });

  it("icons und action.default_icon verweisen auf dieselben Dateien", () => {
    assert.deepEqual(manifest.icons, manifest.action?.default_icon);
  });
});
