// Scan, display and operation: auto-scan, badge, dynamic content, caches, thresholds,
// manual check (selection/right-click), on/off, lazy scan, permission per site, blocklist (own, shipped, heuristic), backend status.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ROOT, launchExtension, sleep, startBackend } from "./helpers.mjs";

await import("../../extension/models.js"); // globalThis.AIVSAI_MODELS

const harness = fs.readFileSync(path.join(ROOT, "test", "harness.html"), "utf8");
const para = (i) => `<p id="p${i}">Paragraph ${i} ` + "lorem ipsum dolor sit amet consectetur adipiscing elit sed do ".repeat(16) + "</p>";
const tall = `<html><body>${Array.from({ length: 60 }, (_, i) => para(i)).join("\n")}</body></html>`;
const scored = (page) => page.$$eval("[data-aivsai-level]", (els) => els.map((e) => e.dataset.aivsaiLevel));

describe("Scan and operation", () => {
  let backend, ext, page;

  before(async () => {
    backend = await startBackend();
    ext = await launchExtension({
      pages: {
        "harness.test": harness,
        "tall.test": tall,
        "bank.test": tall,
        "sub.bank.test": tall,
        "www.chase.com": tall, // is on the bundled blocklist
        "login.test": tall.replace("<body>", '<body><form><input type="password"></form>'),
        "news.test": tall.replace("<body>", '<body><div role="dialog"><input type="password"></div><input type="password" hidden>')
      }
    });
    await ext.configure({ provider: "local", localUrl: backend.url, sites: ["harness.test", "tall.test"], lazyScan: false });
    // Record STATS messages (the popup relies on them instead of polling)
    await ext.options.evaluate(() => {
      window.__stats = [];
      chrome.runtime.onMessage.addListener((m) => m.type === "STATS" && window.__stats.push(m.stats));
    });
    page = await ext.open("http://harness.test/");
    // harness.html inserts a paragraph itself after 2 s - the page is stable after that
    await page.waitForFunction(() => document.querySelector("#dynamic-slot p")?.dataset.aivsaiLevel, null, { timeout: 20_000 });
    await page.waitForFunction(() => !document.querySelector(".aivsai-pending"));
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  it("counts exactly the marked paragraphs in the popup status", async () => {
    const stats = await ext.sendToTab("harness.test", { type: "GET_STATS" });
    const levels = await scored(page);
    const count = (l) => levels.filter((x) => x === l).length;
    assert.ok(levels.length >= 4);
    assert.deepEqual(
      [stats.red, stats.yellow, stats.green, stats.uncertain],
      [count("red"), count("yellow"), count("green"), count("uncertain")]
    );
    assert.ok((await page.$$(".aivsai-badge")).length > 0, "percent badges are missing");
  });

  it("sends STATS to extension pages and sets the icon badge", async () => {
    assert.ok((await ext.options.evaluate(() => window.__stats.length)) > 0);
    const tabId = await ext.tabId("harness.test");
    const badge = await ext.options.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
    assert.notEqual(badge, "");
  });

  it("scores lazy-loaded paragraphs", async () => {
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.id = "dyn";
      // real English - the harness page is lang="en", an unclear language would be skipped
      p.textContent = "This paragraph was inserted by a script after the page had loaded. ".repeat(4);
      document.body.append(p);
    });
    await page.waitForFunction(() => document.querySelector("#dyn")?.dataset.aivsaiLevel, null, { timeout: 5000 });
  });

  it("takes everything from the cache on rescan, without a backend request", async () => {
    const before = backend.requests;
    await ext.sendToTab("harness.test", { type: "SCAN_NOW" });
    await page.waitForFunction(() => document.querySelectorAll("[data-aivsai-level]").length >= 5 && !document.querySelector(".aivsai-pending"));
    await sleep(500);
    assert.equal(backend.requests, before);
  });

  it("recolors after changed thresholds without rescoring", async () => {
    const before = backend.requests;
    await ext.configure({ yellowFrom: 0.1, redFrom: 0.15 });
    await page.waitForFunction(() => !document.querySelector(".aivsai-green, .aivsai-yellow"));
    const stats = await ext.sendToTab("harness.test", { type: "GET_STATS" });
    assert.ok(stats.red > 0);
    assert.equal(stats.yellow + stats.green, 0);
    assert.equal(backend.requests, before);
    await ext.configure({ yellowFrom: 0.6, redFrom: 0.9 });
  });

  it("checks selected text and shows the result in the popover", async () => {
    await page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector("#long-example"));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await ext.sendToTab("harness.test", { type: "CHECK_SELECTION" });
    await page.waitForFunction(() => /Hint, not proof/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.ok(await page.evaluate(() => ["green", "yellow", "red", "uncertain"].some((l) => CSS.highlights.get(`aivsai-${l}`)?.size)));
    await page.keyboard.press("Escape");
    assert.equal(await page.$("aivsai-popover"), null);
  });

  it("checks short blocks via right-click too and points out little text", async () => {
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "short";
      d.textContent = "A short div with just enough words here.";
      document.body.append(d);
    });
    await page.click("#short", { button: "right" });
    await ext.sendToTab("harness.test", { type: "CHECK_ELEMENT" });
    await page.waitForFunction(() => document.querySelector("#short").dataset.aivsaiLevel);
    // the level is set before the popover switches from "Checking for AI…" to the result (openWithFeedback is async)
    await page.waitForFunction(() => /Hint, not proof/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    // green with a note or - at a high score - "uncertain" instead of yellow/red
    assert.match(await page.evaluate(() => document.querySelector("aivsai-popover").shadowRoot.textContent), /Short text|Only 8 words/);
  });

  it("shows short paragraphs with a high score as “uncertain” instead of yellow/red", async () => {
    // Provider "Local" with TMR, thresholds 0.6/0.9 since the test above
    const min = AIVSAI_MODELS.tmr.reliableWords;
    const wrong = await page.$$eval(
      "[data-aivsai-level]",
      // words: the word count that actually decided the traffic light (for grouped paragraphs that
      // of the whole group, see content.js style()) - not that of the single paragraph (el.innerText)
      (els, min) =>
        els
          .map((el) => ({ level: el.dataset.aivsaiLevel, p: Number(el.dataset.aivsaiScore), words: Number(el.dataset.aivsaiWords) }))
          .filter(({ level, p, words }) => (words < min && p >= 0.6 ? level !== "uncertain" : level === "uncertain")),
      min
    );
    assert.deepEqual(wrong, []);
    assert.ok(await page.$(".aivsai-uncertain[data-aivsai-label='uncertain']"), "no paragraph \"uncertain\" in the harness");
  });

  it("does not score paragraphs in another language and names them in the popup status", async () => {
    const stats = await ext.sendToTab("harness.test", { type: "GET_STATS" });
    assert.equal(stats.skipped, 1); // example C (the harness intro is English now)
    assert.equal(await page.$$eval("[data-aivsai-skipped='de']", (els) => els.length), 1);
    assert.ok(!backend.texts.some((t) => t.includes("Wärmeleitfähigkeit")), "German text went to the backend");

    // The function-word heuristic does not know Polish - detected by Chrome's CLD3 (chrome.i18n.detectLanguage),
    // otherwise the page's lang attribute ("en") would be here
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.id = "polish";
      p.textContent =
        "Biblioteka miejska została przeniesiona do starej giełdy zbożowej w 1962 roku, po długiej dyskusji w radzie " +
        "miasta o tym, czy budynek z tak małą liczbą okien może być przyjemnym miejscem do czytania. Architekci " +
        "rozwiązali ten problem, wycinając w dachu rząd świetlików i obniżając stoły, tak aby światło padało na nie po południu.";
      document.body.append(p);
    });
    await page.waitForFunction(() => document.querySelector("#polish")?.dataset.aivsaiSkipped, null, { timeout: 5000 });
    assert.equal(await page.$eval("#polish", (el) => el.dataset.aivsaiSkipped), "pl");
    await page.evaluate(() => document.querySelector("#polish").remove());

    // Right-click: note first, check anyway on request - result then "uncertain", never red
    await page.click("text=Wärmeleitfähigkeit", { button: "right" });
    await ext.sendToTab("harness.test", { type: "CHECK_ELEMENT" });
    const popover = () => page.evaluate(() => document.querySelector("aivsai-popover")?.shadowRoot.textContent || "");
    await page.waitForFunction(() => /Check anyway/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.match(await popover(), /Text in German/);
    await page.getByRole("button", { name: "Check anyway", exact: true }).click();
    await page.waitForFunction(() => /Cannot be scored/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.ok(backend.texts.some((t) => t.includes("Wärmeleitfähigkeit")));
    // the detected language goes along as `lang` (contract in server/README.md) - English paragraphs of the auto-scan
    // as "en", the forced German one as "de"
    const langOf = (word) => backend.langs[backend.batches.findIndex((b) => b.some((t) => t.includes(word)))];
    assert.equal(langOf("Wärmeleitfähigkeit"), "de");
    assert.ok(backend.langs.includes("en"), `lang of the requests: ${backend.langs}`);
    const levels = await page.$$eval("[data-aivsai-level]", (els) =>
      els.filter((el) => el.textContent.includes("Wärmeleitfähigkeit")).map((el) => el.dataset.aivsaiLevel)
    );
    assert.deepEqual(levels, ["uncertain"]);
    await page.keyboard.press("Escape");
  });

  it("removes everything on switching off and scans nothing new", async () => {
    await ext.configure({ enabled: false });
    await page.waitForFunction(() => !document.querySelector("[data-aivsai-level], .aivsai-pending"));
    assert.equal(await ext.options.evaluate(() => chrome.action.getBadgeText({})), "OFF");
    const before = backend.requests;
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.id = "off";
      p.textContent = "This paragraph was added while the extension was switched off. ".repeat(4);
      document.body.append(p);
    });
    await sleep(1200);
    assert.equal(backend.requests, before);
    assert.equal(await page.$eval("#off", (e) => e.className), "");
  });

  it("catches up on switching on with what was added in the meantime", async () => {
    await ext.configure({ enabled: true });
    await page.waitForFunction(() => document.querySelector("#off")?.dataset.aivsaiLevel, null, { timeout: 5000 });
  });

  it("scores only the vicinity with lazy scan and the rest on scrolling", async () => {
    await ext.configure({ lazyScan: true });
    const tallPage = await ext.open("http://tall.test/");
    await tallPage.waitForFunction(() => document.querySelector("#p0")?.dataset.aivsaiLevel && !document.querySelector(".aivsai-pending"));
    const stats = await ext.sendToTab("tall.test", { type: "GET_STATS" });
    assert.ok(stats.deferred > 0, "nothing deferred");
    assert.equal(await tallPage.$eval("#p59", (e) => e.dataset.aivsaiLevel ?? null), null);
    await tallPage.evaluate(() => document.querySelector("#p59").scrollIntoView());
    await tallPage.waitForFunction(() => document.querySelector("#p59")?.dataset.aivsaiLevel, null, { timeout: 15_000 });
    await tallPage.close();
  });

  it("does not scan sites that are not allowed", async () => {
    await ext.configure({ sites: ["harness.test"] });
    const tallPage = await ext.open("http://tall.test/");
    await sleep(1500);
    const stats = await ext.sendToTab("tall.test", { type: "GET_STATS" });
    assert.equal(stats.active, false);
    assert.equal(stats.red + stats.yellow + stats.green + stats.pending, 0);
    await tallPage.close();
  });

  it("scans blocklisted sites neither automatically nor on button press", async () => {
    await ext.configure({ scanMode: "all", blockedSites: ["bank.test"] });
    const before = backend.requests;
    const bank = await ext.open("http://sub.bank.test/");
    await sleep(1500);
    const stats = await ext.sendToTab("sub.bank.test", { type: "SCAN_NOW" });
    assert.equal(stats.blocked, true);
    assert.equal(stats.active, false);
    await sleep(1200);
    assert.equal(backend.requests, before, "text from blocked site was sent");
    assert.match(await bank.evaluate(() => document.querySelector("aivsai-popover").shadowRoot.textContent), /blocklist/);
    await bank.keyboard.press("Escape");

    // Single check remains allowed, with a note
    await bank.click("#p0", { button: "right" });
    await ext.sendToTab("sub.bank.test", { type: "CHECK_ELEMENT" });
    await bank.waitForFunction(() => document.querySelector("#p0").dataset.aivsaiLevel);
    assert.match(await bank.evaluate(() => document.querySelector("aivsai-popover").shadowRoot.textContent), /blocklist – checked/);
    assert.equal(await bank.$$eval("[data-aivsai-level]", (els) => els.length), 1);
    await bank.close();
  });

  it("scans again after removal from the blocklist", async () => {
    const bank = await ext.open("http://bank.test/");
    await ext.configure({ blockedSites: [] });
    await bank.waitForFunction(() => document.querySelector("#p0")?.dataset.aivsaiLevel, null, { timeout: 10_000 });
    await bank.close();
  });

  it("blocks domains of the bundled list, with an exception per host", async () => {
    const info = await ext.options.evaluate(() => ({ count: AIVSAI_BLOCKLIST.count, reason: AIVSAI.blockReason("secure.chase.com", AIVSAI.DEFAULTS) }));
    assert.ok(info.count > 5000, "bundled list is missing or too small");
    assert.equal(info.reason, "builtin");

    const before = backend.requests;
    const bank = await ext.open("http://www.chase.com/");
    await sleep(1500);
    const stats = await ext.sendToTab("www.chase.com", { type: "GET_STATS" });
    assert.equal(stats.blockReason, "list");
    assert.equal(backend.requests, before);

    await ext.configure({ unblockedSites: ["www.chase.com"] });
    await bank.waitForFunction(() => document.querySelector("#p0")?.dataset.aivsaiLevel, null, { timeout: 10_000 });
    await ext.configure({ unblockedSites: [], builtinBlocklist: false });
    assert.equal((await ext.sendToTab("www.chase.com", { type: "GET_STATS" })).blocked, false);
    await ext.configure({ builtinBlocklist: true });
    await bank.close();
  });

  it("does not scan sites with a visible password field, login dialogs do not count", async () => {
    const before = backend.requests;
    const login = await ext.open("http://login.test/");
    await sleep(1500);
    const stats = await ext.sendToTab("login.test", { type: "GET_STATS" });
    assert.equal(stats.blockReason, "sensitive");
    assert.equal(backend.requests, before);
    await login.close();

    // Password field only in a dialog or hidden: scan normally
    const news = await ext.open("http://news.test/");
    await news.waitForFunction(() => document.querySelector("#p0")?.dataset.aivsaiLevel, null, { timeout: 10_000 });

    // SPA switches to a login view: markings disappear, nothing new is sent
    await news.evaluate(() => document.body.insertAdjacentHTML("afterbegin", '<input type="password" id="pw">'));
    await news.waitForFunction(() => !document.querySelector("[data-aivsai-level]"), null, { timeout: 5000 });
    assert.equal((await ext.sendToTab("news.test", { type: "GET_STATS" })).blockReason, "sensitive");

    // Heuristic can be switched off
    await ext.configure({ sensitiveHeuristic: false });
    await news.waitForFunction(() => document.querySelector("#p0")?.dataset.aivsaiLevel, null, { timeout: 10_000 });
    await ext.configure({ sensitiveHeuristic: true, scanMode: "sites" });
    await news.close();
  });

  it("reports backend status and connection test", async () => {
    assert.equal((await ext.send({ type: "HEALTH" })).ok, true);
    const test = await ext.send({ type: "TEST_PROVIDER" });
    assert.equal(test.ok, true);
    assert.equal(typeof test.score, "number");
  });

  it("reaches the offscreen document for the browser model", async () => {
    await ext.configure({ provider: "browser", browserModel: "tmr" });
    const status = await ext.send({ type: "MODEL_STATUS" });
    assert.equal(status.ok, true);
    assert.ok("tmr" in status.models && "desklib" in status.models);
    const health = await ext.send({ type: "HEALTH" });
    // without a downloaded model: clear note instead of error
    if (!status.models.tmr.downloaded) assert.match(health.error, /not downloaded/);
  });

  it("shows model info and presets from models.js in the settings", async () => {
    await ext.options.reload();
    await ext.options.check('input[name="browserModel"][value="desklib"]');
    assert.equal(await ext.options.inputValue("#yellowFrom"), "0.5");
    assert.equal(await ext.options.inputValue("#redFrom"), "0.94");
    assert.match(await ext.options.textContent("#browserModelInfo"), /1\.7 GB/);
  });

  it("has no console errors", () => {
    assert.deepEqual(ext.errors, []);
  });
});
