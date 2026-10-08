// Icons for the manifest/the store (WP-03): every icon file referenced in manifest.json exists
// and is a PNG with exactly the width/height the key promises. Catches typos in
// manifest.json and a broken/outdated scripts/build-icons.mjs (npm run build:icons) without
// needing a browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extDir = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));

// Read width/height from the IHDR chunk (PNG signature 8 bytes, then length+type, then the values).
function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${file}: no PNG signature`);
  assert.equal(buf.toString("ascii", 12, 16), "IHDR", `${file}: no IHDR chunk at the expected position`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("Icons (manifest.json)", () => {
  it("has 16/32/48/128 px under icons and action.default_icon", () => {
    for (const key of ["16", "32", "48", "128"]) {
      assert.ok(manifest.icons?.[key], `icons["${key}"] missing`);
      assert.ok(manifest.action?.default_icon?.[key], `action.default_icon["${key}"] missing`);
    }
  });

  it("every referenced file exists and is square at the promised size", () => {
    const refs = { ...manifest.icons, ...manifest.action?.default_icon };
    for (const [size, rel] of Object.entries(refs)) {
      const file = path.join(extDir, rel);
      assert.ok(fs.existsSync(file), `${rel} (key ${size}) missing under extension/`);
      const { width, height } = pngSize(file);
      assert.equal(width, Number(size), `${rel}: width ${width} != ${size}`);
      assert.equal(height, Number(size), `${rel}: height ${height} != ${size}`);
    }
  });

  it("icons and action.default_icon point to the same files", () => {
    assert.deepEqual(manifest.icons, manifest.action?.default_icon);
  });
});
