// Gemeinsame Helfer für die E2E-Tests: echte Extension in Chromium (Playwright) gegen ein Fake-Backend,
// das den Vertrag von shim_server.py spricht (POST {texts} -> {scores}) und mitschreibt, was ankommt.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXT = path.join(ROOT, "extension");

/** Deterministischer Score aus der Textlänge - verteilt Absätze reproduzierbar auf grün/gelb/rot. */
export const scoreByLength = (text) => [0.2, 0.7, 0.95][text.length % 3];

/**
 * Fake-Backend auf zufälligem Port (kollidiert nicht mit einem laufenden shim_server.py).
 * @returns {Promise<{url: string, texts: string[], batches: string[][], requests: number, close: () => Promise<void>}>}
 */
export async function startBackend(score = scoreByLength) {
  const backend = { texts: [], batches: [], requests: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") return res.end("ok");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { texts } = JSON.parse(body);
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
 * Startet Chromium mit der entpackten Extension. `pages` bildet erfundene Hosts auf HTML ab
 * (Content-Scripts laufen nicht auf localhost, deshalb eigene Hostnamen).
 */
export async function launchExtension({ pages = {}, viewport = { width: 900, height: 900 } } = {}) {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium", // neuer Headless-Modus, der Extensions unterstützt
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
    // onInstalled öffnet die Einstellungen (dient als Extension-Kontext für Nachrichten) - mal als
    // neuen Tab, mal im leeren Starttab. Nicht selbst öffnen: openOptionsPage() würde diesen Tab
    // wiederverwenden und unsere Navigation abbrechen.
    options = await until(() => ctx.pages().find((p) => p.url().endsWith("/options.html")), {
      message: "Einstellungsseite wurde nicht geöffnet"
    });
    await options.waitForLoadState();
    await options.waitForFunction(() => document.querySelector("#modelStatus")?.textContent !== "Prüfe…");
  } catch (err) {
    await ctx.close(); // sonst hält der offene Browser den Testprozess am Leben
    throw err;
  }

  const errors = [];
  const watch = (page, label) =>
    page.on("console", (m) => m.type() === "error" && errors.push(`${label}: ${m.text()}`));
  watch(options, "options");

  return {
    ctx,
    options,
    errors,
    /** aktueller Service Worker (nach einem Neustart ein neues Objekt) */
    sw: () => ctx.serviceWorkers()[0] ?? sw,
    async open(url) {
      const page = await ctx.newPage();
      watch(page, url);
      await page.goto(url);
      return page;
    },
    configure: (cfg) => options.evaluate((c) => chrome.storage.sync.set(c), cfg),
    send: (msg) => options.evaluate((m) => chrome.runtime.sendMessage(m), msg),
    /** Nachricht an das Content-Script des Tabs mit diesem Host */
    sendToTab: (host, msg) =>
      options.evaluate(
        async ([h, m]) => {
          const [tab] = await chrome.tabs.query({ url: `http://${h}/*` });
          return chrome.tabs.sendMessage(tab.id, m);
        },
        [host, msg]
      ),
    close: () => ctx.close()
  };
}

/** Wartet, bis `fn()` truthy liefert (Bedingungen auf Node-Seite, z.B. Backend-Zähler); wirft sonst. */
export async function until(fn, { timeout = 10_000, interval = 100, message = "Bedingung nicht erfüllt" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`${message} (nach ${timeout} ms)`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Direkter Blick in den dauerhaften Score-Speicher (IndexedDB der Extension). */
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

/** Absatztext mit Kennung, lang genug für den Auto-Scan (>= 40 Wörter). */
export const longText = (tag) => `${tag} ` + "words about gardening soil water light and patience in the spring ".repeat(5);
