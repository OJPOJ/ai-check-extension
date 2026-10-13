// Issue #46, work package 6: latency of the candidate encoders for our own model, measured where the
// extension runs them - ONNX Runtime Web (WASM) in Chromium, the library version transformers.js pins,
// threads as in extension/offscreen.js. The graphs have random weights and are built by
// training/model/export_candidates.py; this script only runs them and writes raw numbers.
//
// npm run measure:latency [-- --only ettin-32m,roberta-base] [-- --precision q8] [-- --lengths 32,128,512]
//                         [-- --threads 4] [-- --passes 3] [-- --no-real] [-- --headed]
//
// Writes training/data/latency/results.json (not committed); the tables are made from it by
// training/model/latency_report.py. A run with --only or --precision replaces only those candidates
// and precisions in the file, and stops if the rest of the file was measured under another
// environment (machine, browser, library, backend, threads, lengths).
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { ROOT } from "../test/e2e/helpers.mjs";

const DATA = path.join(ROOT, "training", "data", "latency");
const ORT = path.join(ROOT, "node_modules", "onnxruntime-web");
const RESULTS = path.join(DATA, "results.json");
// The real TMR file of the extension next to the random RoBERTa-base: if both take the same time,
// random weights are a valid stand-in.
const REAL = "tmr-real";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback);
const ONLY = option("--only", "")
  .split(",")
  .filter(Boolean);
const PRECISIONS = option("--precision", "q8,fp32").split(",");
const LENGTHS = option("--lengths", "32,64,128,256,512").split(",").map(Number);
const THREADS = option("--threads", null);
// A backend other than WASM (issue #19, WebGPU) can reuse the script: --backend webgpu
const BACKEND = option("--backend", "wasm");
// Everything is measured this often, each time in a new page, and the fastest pass of a chain is kept:
// now and then a whole page runs at about half speed (seen on a laptop CPU; the runs inside it agree
// with each other, so the median of one page does not show it). The passes go over all candidates
// one after the other, so that a disturbance of some minutes does not hit both passes of a chain.
const PASSES = Number(option("--passes", 2));

const TYPES = { ".mjs": "text/javascript", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".html": "text/html" };

// Threads need a cross-origin isolated page (the extension gets that from its manifest)
function serve() {
  const roots = { "/ort/": path.join(ORT, "dist"), "/models/": DATA };
  const server = http.createServer((req, res) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/") {
      res.setHeader("content-type", TYPES[".html"]);
      return res.end("<!doctype html><title>latency</title>");
    }
    const prefix = Object.keys(roots).find((p) => url.startsWith(p));
    const file = prefix && path.join(roots[prefix], url.slice(prefix.length));
    if (!file || !file.startsWith(roots[prefix]) || !fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
    res.setHeader("content-length", fs.statSync(file).size);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/**
 * Runs in the page. `chain`: the graphs that are called one after the other for one text (one for a
 * model without early exit, one per stage otherwise); each stage gets the hidden states and the
 * mask of the one before. Returns per length the time of every stage.
 */
async function measureInPage({ chain, lengths, vocab, threads, backend }) {
  const ort = await import("/ort/ort.webgpu.min.mjs");
  ort.env.wasm.wasmPaths = "/ort/";
  ort.env.wasm.numThreads = threads ?? (self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1);
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  const sessions = [];
  const loadMs = [];
  for (const url of chain) {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const t0 = performance.now();
    sessions.push(await ort.InferenceSession.create(bytes, { executionProviders: [backend] }));
    loadMs.push(performance.now() - t0);
  }

  const out = { threads: ort.env.wasm.numThreads, isolated: self.crossOriginIsolated, loadMs, lengths: {} };
  for (const tokens of lengths) {
    const ids = BigInt64Array.from({ length: tokens }, (_, i) => BigInt(5 + ((i * 7919) % (vocab - 5))));
    let feeds = {
      input_ids: new ort.Tensor("int64", ids, [1, tokens]),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(tokens).fill(1n), [1, tokens])
    };
    const stages = [];
    for (const session of sessions) {
      const given = Object.fromEntries(session.inputNames.map((n) => [n, feeds[n]]));
      let result;
      for (let i = 0; i < 2; i++) result = await session.run(given); // warm-up
      // at least 7 runs; more while they are cheap (up to 25 runs or 2 s)
      const times = [];
      const start = performance.now();
      while (times.length < 7 || (times.length < 25 && performance.now() - start < 2000)) {
        const t0 = performance.now();
        result = await session.run(given);
        times.push(performance.now() - t0);
      }
      stages.push({ ms: median(times), min: Math.min(...times), runs: times.length, tokensIn: given.attention_mask.dims[1] });
      if (result.hidden_out) feeds = { hidden: result.hidden_out, attention_mask: result.attention_mask_out };
    }
    out.lengths[tokens] = stages;
  }
  for (const session of sessions) await session.release();
  return out;
}

async function realAnchor() {
  await import("../extension/models.js");
  const { repo, revision, marker } = globalThis.AIVSAI_MODELS.tmr.browser;
  const file = path.join(DATA, REAL, "full.q8.onnx");
  if (!fs.existsSync(file)) {
    console.log(`downloading ${repo}@${revision.slice(0, 7)}/${marker} (once)`);
    const resp = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/${marker}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
  }
  return {
    repo, revision, anchor: "TMR as the extension runs it (real weights)", vocab: 50265,
    graphs: { full: { files: { q8: { path: `${REAL}/full.q8.onnx`, bytes: fs.statSync(file).size } } } }
  };
}

/** The chains measured for a candidate: name -> graphs called one after the other. */
function chains(candidate) {
  const g = Object.keys(candidate.graphs);
  const stages = g.filter((v) => /^stage\d+$/.test(v)).sort();
  const reduced = stages.map((v, i) => (i === 0 ? v : `${v}-tr`));
  return {
    full: ["full"],
    ...(g.includes("full-tr") && { "full-tr": ["full-tr"] }),
    ...(stages.length && { stages: stages }),
    // our own variants have their token reduction built in and no second set of stages
    ...(stages.length && reduced.every((v) => g.includes(v)) && { "stages-tr": reduced })
  };
}

const manifestPath = path.join(DATA, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error("No exported graphs. Run in training/: .venv/Scripts/python.exe model/export_candidates.py");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const candidates = { ...manifest.candidates };
if (!args.includes("--no-real") && (!ONLY.length || ONLY.includes(REAL))) {
  try {
    candidates[REAL] = await realAnchor();
  } catch (err) {
    console.log(`real TMR file skipped: ${err.message}`);
  }
}
const names = Object.keys(candidates).filter((n) => !ONLY.length || ONLY.includes(n));

const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "chromium", headless: !args.includes("--headed") });
const results = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, "utf8")) : { candidates: {} };
const wasmFiles = new Set();

// One environment is stored for the whole file. Numbers that stay in it from an earlier run (other
// candidates, or the other precision) must therefore have been measured under the same one.
const environment = {
  date: new Date().toISOString().slice(0, 10),
  cpu: os.cpus()[0].model.trim(),
  logicalCores: os.cpus().length,
  browser: `Chromium ${browser.version()}`,
  onnxruntimeWeb: JSON.parse(fs.readFileSync(path.join(ORT, "package.json"), "utf8")).version,
  backend: BACKEND,
  threads: undefined, // known after the first chain that ran
  lengths: LENGTHS
};
const kept = Object.entries(results.candidates).some(
  ([name, per]) => !names.includes(name) || Object.keys(per).some((p) => !PRECISIONS.includes(p))
);
function checkEnvironment() {
  if (!kept || !results.environment) return;
  const differs = ["cpu", "logicalCores", "browser", "onnxruntimeWeb", "backend", "threads", "lengths"].filter(
    (k) => environment[k] !== undefined && JSON.stringify(environment[k]) !== JSON.stringify(results.environment[k])
  );
  if (!differs.length) return;
  const shown = differs.map((k) => `${k}: ${JSON.stringify(results.environment[k])} -> ${JSON.stringify(environment[k])}`);
  throw new Error(
    `${path.relative(ROOT, RESULTS)} keeps numbers measured under another environment (${shown.join("; ")}). ` +
      "Measure everything again (no --only, both precisions) or delete the file."
  );
}

const totalMs = (entry) => Object.values(entry.lengths).reduce((sum, stages) => sum + stages.reduce((a, s) => a + s.ms, 0), 0);

try {
  checkEnvironment();
  const fresh = new Set(); // name/precision that this run has started to replace
  for (let pass = 1; pass <= PASSES; pass++) {
    for (const name of names) {
      const candidate = candidates[name];
      results.candidates[name] ??= {};
      for (const precision of PRECISIONS) {
        for (const [chainName, variants] of Object.entries(chains(candidate))) {
          const files = variants.map((v) => candidate.graphs[v].files[precision]);
          if (files.some((f) => !f)) continue;
          // replaces what the file had for this precision, once a chain exists for it
          if (!fresh.has(`${name}/${precision}`)) {
            fresh.add(`${name}/${precision}`);
            results.candidates[name][precision] = {};
          }
          const measured = results.candidates[name][precision];
          if (files.some((f) => f.external)) {
            measured[chainName] = { error: "weights in a separate file (too large for one ONNX file)" };
            continue;
          }
          // a new page per chain: the WASM memory of a page never shrinks
          const page = await browser.newPage();
          page.on("request", (r) => r.url().endsWith(".wasm") && wasmFiles.add(path.basename(r.url())));
          let entry;
          try {
            await page.goto(origin);
            entry = await page.evaluate(measureInPage, {
              chain: files.map((f) => `/models/${f.path}`),
              lengths: LENGTHS,
              vocab: candidate.vocab,
              threads: THREADS && Number(THREADS),
              backend: BACKEND
            });
            entry.bytes = files.map((f) => f.bytes);
          } catch (err) {
            entry = { error: String(err?.message || err).split("\n")[0] };
          }
          await page.close();
          if (!entry.error && environment.threads === undefined) {
            environment.threads = entry.threads;
            checkEnvironment();
          }
          const before = measured[chainName];
          if (!entry.error) {
            // the sum over all lengths of every pass stays in the file, to see how far the passes agree
            entry.passesMs = [...(before?.passesMs ?? []), Math.round(totalMs(entry))];
            if (before && !before.error && totalMs(before) <= totalMs(entry)) {
              before.passesMs = entry.passesMs;
              entry = before;
            }
          } else if (before && !before.error) {
            entry = before;
          }
          measured[chainName] = entry;
          const shown = entry.error
            ? `failed: ${entry.error}`
            : LENGTHS.map((l) => `${l}: ${entry.lengths[l].map((s) => s.ms.toFixed(0)).join("+")} ms`).join("   ");
          console.log(`${pass}/${PASSES} ${name.padEnd(20)} ${precision.padEnd(5)} ${chainName.padEnd(10)} ${shown}`);
        }
      }
      results.environment = { ...environment, passes: PASSES, wasm: [...wasmFiles] };
      fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2) + "\n");
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`-> ${path.relative(ROOT, RESULTS)}`);
