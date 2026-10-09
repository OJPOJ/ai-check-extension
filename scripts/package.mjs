// Builds the shippable zip of the extension: dist/ai-content-flag-<version>.zip (npm run package).
// Contents = the files tracked in Git under extension/ plus extension/vendor/ (via npm run vendor,
// not in Git). Nothing else - local experiments, editor files etc. do not end up in the package.
//
// Aborts if
//   - files under extension/ are not committed (the package should correspond to a commit;
//     --allow-dirty builds anyway, the file name then gets "-dirty")
//   - vendor/ is missing or a file referenced by the manifest, HTML or an import is not in the package
// Warns (without aborting) about items only needed for the Web Store, and about an old blocklist.
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createZip, readZip } from "./zip.mjs";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")));
const extDir = path.join(root, "extension");
const allowDirty = process.argv.includes("--allow-dirty");
const BLOCKLIST_MAX_AGE_DAYS = 30;

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const errors = [];
const warnings = [];

// --- File list --------------------------------------------------------------------------------
const tracked = git("ls-files", "-z", "--", "extension").split("\0").filter(Boolean);
const dirty = git("status", "--porcelain", "--", "extension").split("\n").filter(Boolean);
const untracked = dirty.filter((l) => l.startsWith("??")).map((l) => l.slice(3));
const modified = dirty.filter((l) => !l.startsWith("??")).map((l) => l.slice(3));

if (modified.length) {
  const msg = `uncommitted changes under extension/:\n    ${modified.join("\n    ")}`;
  (allowDirty ? warnings : errors).push(msg);
}
if (untracked.length) warnings.push(`not in Git, will NOT go into the package:\n    ${untracked.join("\n    ")}`);

const vendorDir = path.join(extDir, "vendor");
const vendor = fs.existsSync(vendorDir)
  ? fs.readdirSync(vendorDir).map((f) => `extension/vendor/${f}`)
  : [];
if (!vendor.length) errors.push("extension/vendor/ is missing or empty – npm run vendor");

// skip deleted but still tracked files (they show up as a change above anyway)
const files = [...tracked, ...vendor].filter((f) => fs.existsSync(path.join(root, f)));
const inZip = new Set(files.map((f) => f.slice("extension/".length)));

// --- Check references -------------------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
const refs = []; // [file in the package, referenced from]
const ref = (p, from) => p && refs.push([p.replace(/^\.?\//, ""), from]);

ref(manifest.background?.service_worker, "manifest background");
for (const cs of manifest.content_scripts ?? []) {
  for (const p of [...(cs.js ?? []), ...(cs.css ?? [])]) ref(p, "manifest content_scripts");
}
ref(manifest.options_ui?.page, "manifest options_ui");
ref(manifest.action?.default_popup, "manifest action");
for (const p of Object.values(manifest.icons ?? {})) ref(p, "manifest icons");
for (const p of Object.values(manifest.action?.default_icon ?? {})) ref(p, "manifest action.default_icon");

for (const f of inZip) {
  const full = path.join(extDir, f);
  const dir = path.posix.dirname(f);
  if (f.endsWith(".html")) {
    const html = fs.readFileSync(full, "utf8");
    for (const [, p] of html.matchAll(/\s(?:src|href)="([^"#?]+)[^"]*"/g)) {
      if (!/^[a-z]+:/i.test(p)) ref(path.posix.join(dir, p), f);
    }
  } else if (f.endsWith(".js") && !f.startsWith("vendor/") && !f.startsWith("generated/")) {
    const js = fs.readFileSync(full, "utf8");
    for (const [, p] of js.matchAll(/(?:^|\n)\s*import\s[^;]*?["'](\.{1,2}\/[^"']+)["']/g)) {
      ref(path.posix.join(dir, p), f);
    }
  }
}
// Files loaded via chrome.runtime.getURL (offscreen-client.js, offscreen.js)
ref("offscreen.html", "bg/offscreen-client.js");
ref("setup.html", "background.js");
for (const m of Object.values(await loadModels())) {
  for (const p of Object.values(m.browser?.build?.shipped ?? {})) ref(p, "models.js");
  ref(m.browser?.build?.recipe, "models.js");
}

for (const [p, from] of refs) {
  if (!inZip.has(p)) errors.push(`${p} missing from the package (referenced by ${from})`);
}

// --- Notes for the Web Store ------------------------------------------------------------------
if (!manifest.icons?.["128"]) warnings.push("Store: no 128 px icon in the manifest (\"icons\")");
const descLen = [...(manifest.description ?? "")].length;
if (descLen > 132) warnings.push(`Store: manifest description has ${descLen} characters (Chrome allows 132)`);

const blocklistSrc = fs.readFileSync(path.join(extDir, "generated", "blocklist.js"), "utf8");
const generated = blocklistSrc.match(/generated:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1];
if (!generated) errors.push("generated/blocklist.js: date (generated) not readable");
else {
  const age = (Date.now() - Date.parse(generated)) / 86_400_000;
  if (age > BLOCKLIST_MAX_AGE_DAYS) {
    warnings.push(`blocklist is ${Math.floor(age)} days old (${generated}) – npm run build:blocklist, check the diff, commit`);
  }
}

// --- Output -----------------------------------------------------------------------------------
for (const w of warnings) console.warn(`WARNING: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`ERROR: ${e}`);
  process.exit(1);
}

// Timestamp of all entries = commit time -> same commit yields a byte-identical zip
const mtime = new Date(git("log", "-1", "--format=%cI").trim());
const commit = git("rev-parse", "--short", "HEAD").trim();
const entries = files.map((f) => ({ name: f.slice("extension/".length), data: fs.readFileSync(path.join(root, f)) }));
const zip = createZip(entries, { mtime });

// Cross-check: zip readable, every file unchanged
const back = readZip(zip);
if (back.length !== entries.length) throw new Error("cross-check: number of entries does not match");
const byName = new Map(entries.map((e) => [e.name, e.data]));
for (const { name, data } of back) {
  if (!byName.get(name)?.equals(data)) throw new Error(`cross-check: ${name} differs`);
}

const suffix = modified.length ? "-dirty" : "";
const outDir = path.join(root, "dist");
const out = path.join(outDir, `ai-content-flag-${manifest.version}${suffix}.zip`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, zip);

const raw = entries.reduce((n, e) => n + e.data.length, 0);
console.log(`${path.relative(root, out)}`);
console.log(`  Version ${manifest.version}, commit ${commit}${suffix}, ${entries.length} files`);
console.log(`  ${(raw / 1e6).toFixed(1)} MB → ${(zip.length / 1e6).toFixed(1)} MB packed`);
console.log(`  Blocklist from ${generated}`);
console.log(`  SHA-256 ${crypto.createHash("sha256").update(zip).digest("hex")}`);

// models.js is a classic script that sets globalThis.AIVSAI_MODELS
async function loadModels() {
  const src = fs.readFileSync(path.join(extDir, "models.js"), "utf8");
  const g = {};
  new Function("globalThis", src)(g);
  return g.AIVSAI_MODELS ?? {};
}
