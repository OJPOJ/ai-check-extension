// Copies transformers.js and the matching ONNX Runtime WASM into extension/vendor/.
// Manifest V3 forbids remotely loaded code - library and WASM must live inside the extension,
// only the model weights (data) are loaded from Hugging Face at runtime.
import fs from "fs";
import path from "path";
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")));
const out = path.join(root, "extension", "vendor");
const nm = path.join(root, "node_modules");
const tfDir = path.join(nm, "@huggingface", "transformers");
// transformers.js pins its own onnxruntime-web version - prefer the nested copy
const ortDir = [path.join(tfDir, "node_modules", "onnxruntime-web"), path.join(nm, "onnxruntime-web")].find((d) =>
  fs.existsSync(d)
);

const files = [
  [path.join(tfDir, "dist", "transformers.min.js"), "transformers.min.js"],
  [path.join(ortDir, "dist", "ort-wasm-simd-threaded.asyncify.mjs"), "ort-wasm-simd-threaded.asyncify.mjs"],
  [path.join(ortDir, "dist", "ort-wasm-simd-threaded.asyncify.wasm"), "ort-wasm-simd-threaded.asyncify.wasm"],
  [path.join(tfDir, "LICENSE"), "LICENSE.transformers.js.txt"],
];

fs.mkdirSync(out, { recursive: true });
for (const [src, name] of files) {
  if (!fs.existsSync(src)) throw new Error(`missing: ${src}`);
  fs.copyFileSync(src, path.join(out, name));
  console.log(`${name.padEnd(36)} ${(fs.statSync(src).size / 1e6).toFixed(1)} MB`);
}

// pdf.js for the PDF viewer (viewer.html): rendering + text layer. Only the pieces the viewer needs - not the
// sandbox for PDF scripts (JavaScript inside PDFs is never executed), not the source maps.
const pdfDir = path.join(nm, "pdfjs-dist");
const pdfOut = path.join(out, "pdfjs");
const pdfFiles = [
  ["build/pdf.min.mjs", "pdf.min.mjs"],
  ["build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["web/pdf_viewer.mjs", "pdf_viewer.mjs"],
  ["web/pdf_viewer.css", "pdf_viewer.css"],
  ["LICENSE", "LICENSE.pdfjs.txt"]
];
// Directories copied as a whole (data the worker loads at runtime: character maps, standard fonts, WASM decoders)
const pdfDirs = ["cmaps", "standard_fonts", "iccs", "web/images"];
const pdfWasm = ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"]; // + licenses below

fs.mkdirSync(pdfOut, { recursive: true });
let pdfBytes = 0;
const copyPdf = (rel, dest) => {
  const src = path.join(pdfDir, rel);
  if (!fs.existsSync(src)) throw new Error(`missing: ${src}`);
  fs.mkdirSync(path.dirname(path.join(pdfOut, dest)), { recursive: true });
  fs.copyFileSync(src, path.join(pdfOut, dest));
  pdfBytes += fs.statSync(src).size;
};
for (const [rel, dest] of pdfFiles) copyPdf(rel, dest);
for (const dir of pdfDirs) {
  for (const f of fs.readdirSync(path.join(pdfDir, dir))) {
    copyPdf(`${dir}/${f}`, `${dir === "web/images" ? "images" : dir}/${f}`);
  }
}
for (const f of fs.readdirSync(path.join(pdfDir, "wasm"))) {
  if (pdfWasm.includes(f) || f.startsWith("LICENSE")) copyPdf(`wasm/${f}`, `wasm/${f}`);
}
console.log(`${"pdfjs/ (viewer)".padEnd(36)} ${(pdfBytes / 1e6).toFixed(1)} MB`);

