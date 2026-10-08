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
