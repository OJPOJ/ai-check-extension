// Shared helpers for the E2E tests: the real extension in Chromium (Playwright) against a fake backend
// that speaks the contract of shim_server.py (POST {texts} -> {scores}) and records what arrives.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXT = path.join(ROOT, "extension");

/** Deterministic score from the text length - distributes paragraphs reproducibly across green/yellow/red. */
export const scoreByLength = (text) => [0.2, 0.7, 0.95][text.length % 3];

/**
 * Fake backend on a random port (does not collide with a running shim_server.py).
 * `info` = response to GET /v1/info (without: 404, like a server that does not have the optional endpoint).
 * @returns {Promise<{url: string, texts: string[], batches: string[][], langs: (string|undefined)[], requests: number,
 *   close: () => Promise<void>}>}  langs: `lang` per request
 */
export async function startBackend(score = scoreByLength, { info } = {}) {
  const backend = { texts: [], batches: [], langs: [], requests: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") return res.end("ok");
    if (req.url.startsWith("/v1/info")) {
      res.statusCode = info ? 200 : 404;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(info ?? { detail: "Not Found" }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { texts, lang } = JSON.parse(body);
      backend.langs.push(lang);
      backend.requests++;
      backend.texts.push(...texts);
      backend.batches.push(texts);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ scores: texts.map(score) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  backend.url = `http://127.0.0.1:${server.address().port}`;
  backend.close = () => new Promise((resolve) => server.close(resolve));
  return backend;
}

/**
 * Starts Chromium with the unpacked extension. `pages` maps made-up hosts to HTML
 * (content scripts do not run on localhost, hence own hostnames).
 */
export async function launchExtension({ pages = {}, viewport = { width: 900, height: 900 } } = {}) {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium", // new headless mode that supports extensions
    headless: !process.env.HEADED,
    viewport,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  let sw, options;
  try {
    for (const [host, html] of Object.entries(pages)) {
      await ctx.route(`http://${host}/**`, (r) => r.fulfill({ contentType: "text/html", body: html }));
    }
    [sw] = ctx.serviceWorkers();
    sw ||= await ctx.waitForEvent("serviceworker");
    // onInstalled opens the setup page - sometimes as a new tab, sometimes in the empty start tab. From there on to
    // the settings like a user (checks the link along the way); the page then serves as the
    // extension context for messages.
    const setup = await until(() => ctx.pages().find((p) => p.url().endsWith("/setup.html")), {
      message: "Setup page was not opened"
    });
    await setup.waitForLoadState();
    await setup.click("a[href^='options.html']");
    options = await until(() => ctx.pages().find((p) => p.url().includes("/options.html")), {
      message: "Settings page was not opened"
    });
    await options.waitForLoadState();
    await options.waitForFunction(() => document.querySelector("#modelStatus")?.textContent !== "Checking…");
  } catch (err) {
    await ctx.close(); // otherwise the open browser keeps the test process alive
    throw err;
  }

  const errors = [];
  const watch = (page, label) =>
    page.on("console", (m) => m.type() === "error" && errors.push(`${label}: ${m.text()}`));
  watch(options, "options");

  // Without the "tabs" permission chrome.tabs.query returns no URLs (activeTab only applies after a click on the
  // icon) - hence bring the tab to the front and find it as the active tab
  async function tabId(host) {
    const page = ctx.pages().find((p) => p.url().startsWith(`http://${host}/`));
    if (!page) throw new Error(`no tab for ${host}`);
    await page.bringToFront();
    return options.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  }

  return {
    ctx,
    options,
    errors,
    /** current service worker (a new object after a restart) */
    sw: () => ctx.serviceWorkers()[0] ?? sw,
    async open(url) {
      const page = await ctx.newPage();
      watch(page, url);
      await page.goto(url);
      return page;
    },
    configure: (cfg) => options.evaluate((c) => chrome.storage.sync.set(c), cfg),
    send: (msg) => options.evaluate((m) => chrome.runtime.sendMessage(m), msg),
    /** Unfolds "Advanced settings" on the settings page (backends, thresholds, blocklist, ...) */
    openAdvanced: () => options.evaluate(() => (document.getElementById("advanced").open = true)),
    tabId,
    /** Message to the content script of the tab with this host */
    sendToTab: async (host, msg) =>
      options.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [await tabId(host), msg]),
    close: () => ctx.close()
  };
}

/** Waits until `fn()` returns truthy (conditions on the Node side, e.g. backend counters); throws otherwise. */
export async function until(fn, { timeout = 10_000, interval = 100, message = "Condition not met" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`${message} (after ${timeout} ms)`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Direct look into the persistent score store (the extension's IndexedDB). */
export const storedScores = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        indexedDB.open("aivsai").onsuccess = (e) => {
          e.target.result.transaction("scores").objectStore("scores").getAll().onsuccess = (ev) =>
            resolve(ev.target.result);
        };
      })
  );

/**
 * Paragraph text with an identifier, long enough for the auto-scan (>= 40 words) and for yellow/red instead of "uncertain"
 * (~165 words, AIVSAI.reliableWords).
 */
export const longText = (tag) => `${tag} ` + "words about gardening soil water light and patience in the spring ".repeat(15);

/**
 * Minimal one-page PDF with one line of text per entry of `lines` (Helvetica, no compression) - enough for
 * pdf.js to render a text layer. Returns a Buffer.
 */
export function makePdf(lines = ["Hello PDF viewer"]) {
  const esc = (s) => s.replace(/[\()]/g, "\$&");
  const stream = `BT /F1 14 Tf 20 ${40 + lines.length * 20} Td 18 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 ${60 + lines.length * 20}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}
