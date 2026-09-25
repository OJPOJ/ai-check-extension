// Baut das auslieferbare Zip der Extension: dist/ai-content-flag-<version>.zip (npm run package).
// Inhalt = die im Git erfassten Dateien unter extension/ plus extension/vendor/ (per npm run vendor,
// nicht im Git). Nichts sonst - lokale Experimente, Editor-Dateien usw. landen nicht im Paket.
//
// Bricht ab, wenn
//   - Dateien unter extension/ nicht committet sind (Paket soll einem Commit entsprechen;
//     --allow-dirty baut trotzdem, der Dateiname bekommt dann "-dirty")
//   - vendor/ fehlt oder eine Datei, auf die Manifest, HTML oder ein Import verweist, nicht im Paket ist
// Warnt (ohne Abbruch) bei Punkten, die erst für den Web Store nötig sind, und bei alter Sperrliste.
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

// --- Dateiliste -------------------------------------------------------------------------------
const tracked = git("ls-files", "-z", "--", "extension").split("\0").filter(Boolean);
const dirty = git("status", "--porcelain", "--", "extension").split("\n").filter(Boolean);
const untracked = dirty.filter((l) => l.startsWith("??")).map((l) => l.slice(3));
const modified = dirty.filter((l) => !l.startsWith("??")).map((l) => l.slice(3));

if (modified.length) {
  const msg = `nicht committete Änderungen unter extension/:\n    ${modified.join("\n    ")}`;
  (allowDirty ? warnings : errors).push(msg);
}
if (untracked.length) warnings.push(`nicht im Git, kommt NICHT ins Paket:\n    ${untracked.join("\n    ")}`);

const vendorDir = path.join(extDir, "vendor");
const vendor = fs.existsSync(vendorDir)
  ? fs.readdirSync(vendorDir).map((f) => `extension/vendor/${f}`)
  : [];
if (!vendor.length) errors.push("extension/vendor/ fehlt oder ist leer – npm run vendor");

// gelöschte, aber noch erfasste Dateien überspringen (fallen oben ohnehin als Änderung auf)
const files = [...tracked, ...vendor].filter((f) => fs.existsSync(path.join(root, f)));
const inZip = new Set(files.map((f) => f.slice("extension/".length)));

// --- Verweise prüfen --------------------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
const refs = []; // [datei im Paket, woher]
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
// Dateien, die per chrome.runtime.getURL geladen werden (offscreen-client.js, offscreen.js)
ref("offscreen.html", "bg/offscreen-client.js");
for (const m of Object.values(await loadModels())) {
  for (const p of Object.values(m.browser?.build?.shipped ?? {})) ref(p, "models.js");
  ref(m.browser?.build?.recipe, "models.js");
}

for (const [p, from] of refs) {
  if (!inZip.has(p)) errors.push(`${p} fehlt im Paket (verwiesen von ${from})`);
}

// --- Hinweise für den Web Store ---------------------------------------------------------------
if (!manifest.icons?.["128"]) warnings.push("Store: kein 128-px-Icon im Manifest (\"icons\")");
const privacy = fs.readFileSync(path.join(extDir, "privacy.html"), "utf8");
if (/\[Name und Kontaktadresse/.test(privacy)) warnings.push("Store: Kontakt in privacy.html ist noch ein Platzhalter");

const blocklistSrc = fs.readFileSync(path.join(extDir, "generated", "blocklist.js"), "utf8");
const generated = blocklistSrc.match(/generated:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1];
if (!generated) errors.push("generated/blocklist.js: Stand (generated) nicht lesbar");
else {
  const age = (Date.now() - Date.parse(generated)) / 86_400_000;
  if (age > BLOCKLIST_MAX_AGE_DAYS) {
    warnings.push(`Sperrliste ist ${Math.floor(age)} Tage alt (${generated}) – npm run build:blocklist, Diff prüfen, committen`);
  }
}

// --- Ausgabe ----------------------------------------------------------------------------------
for (const w of warnings) console.warn(`WARNUNG: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`FEHLER: ${e}`);
  process.exit(1);
}

// Zeitstempel aller Einträge = Commit-Zeit -> gleicher Commit ergibt byte-gleiches Zip
const mtime = new Date(git("log", "-1", "--format=%cI").trim());
const commit = git("rev-parse", "--short", "HEAD").trim();
const entries = files.map((f) => ({ name: f.slice("extension/".length), data: fs.readFileSync(path.join(root, f)) }));
const zip = createZip(entries, { mtime });

// Gegenprobe: Zip lesbar, jede Datei unverändert
const back = readZip(zip);
if (back.length !== entries.length) throw new Error("Gegenprobe: Anzahl Einträge stimmt nicht");
const byName = new Map(entries.map((e) => [e.name, e.data]));
for (const { name, data } of back) {
  if (!byName.get(name)?.equals(data)) throw new Error(`Gegenprobe: ${name} weicht ab`);
}

const suffix = modified.length ? "-dirty" : "";
const outDir = path.join(root, "dist");
const out = path.join(outDir, `ai-content-flag-${manifest.version}${suffix}.zip`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, zip);

const raw = entries.reduce((n, e) => n + e.data.length, 0);
console.log(`${path.relative(root, out)}`);
console.log(`  Version ${manifest.version}, Commit ${commit}${suffix}, ${entries.length} Dateien`);
console.log(`  ${(raw / 1e6).toFixed(1)} MB → ${(zip.length / 1e6).toFixed(1)} MB gepackt`);
console.log(`  Sperrliste vom ${generated}`);
console.log(`  SHA-256 ${crypto.createHash("sha256").update(zip).digest("hex")}`);

// models.js ist ein klassisches Skript, das globalThis.AIVSAI_MODELS setzt
async function loadModels() {
  const src = fs.readFileSync(path.join(extDir, "models.js"), "utf8");
  const g = {};
  new Function("globalThis", src)(g);
  return g.AIVSAI_MODELS ?? {};
}
