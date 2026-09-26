// Scan, Anzeige und Bedienung: Auto-Scan, Badge, dynamische Inhalte, Caches, Schwellen,
// manuelle Prüfung (Auswahl/Rechtsklick), An/Aus, Lazy-Scan, Freigabe pro Seite, Sperrliste (eigene, mitgelieferte, Heuristik), Backend-Status.
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

describe("Scan und Bedienung", () => {
  let backend, ext, page;

  before(async () => {
    backend = await startBackend();
    ext = await launchExtension({
      pages: {
        "harness.test": harness,
        "tall.test": tall,
        "bank.test": tall,
        "sub.bank.test": tall,
        "www.chase.com": tall, // steht in der mitgelieferten Sperrliste
        "login.test": tall.replace("<body>", '<body><form><input type="password"></form>'),
        "news.test": tall.replace("<body>", '<body><div role="dialog"><input type="password"></div><input type="password" hidden>')
      }
    });
    await ext.configure({ provider: "local", localUrl: backend.url, sites: ["harness.test", "tall.test"], lazyScan: false });
    // STATS-Nachrichten mitschneiden (das Popup lebt davon statt von Polling)
    await ext.options.evaluate(() => {
      window.__stats = [];
      chrome.runtime.onMessage.addListener((m) => m.type === "STATS" && window.__stats.push(m.stats));
    });
    page = await ext.open("http://harness.test/");
    // harness.html fügt nach 2 s selbst einen Absatz ein - danach ist die Seite stabil
    await page.waitForFunction(() => document.querySelector("#dynamic-slot p")?.dataset.aivsaiLevel, null, { timeout: 20_000 });
    await page.waitForFunction(() => !document.querySelector(".aivsai-pending"));
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  it("zählt im Popup-Status genau die markierten Absätze", async () => {
    const stats = await ext.sendToTab("harness.test", { type: "GET_STATS" });
    const levels = await scored(page);
    const count = (l) => levels.filter((x) => x === l).length;
    assert.ok(levels.length >= 4);
    assert.deepEqual(
      [stats.red, stats.yellow, stats.green, stats.uncertain],
      [count("red"), count("yellow"), count("green"), count("uncertain")]
    );
    assert.ok((await page.$$(".aivsai-badge")).length > 0, "Prozent-Badges fehlen");
  });

  it("schickt STATS an Extension-Seiten und setzt das Icon-Badge", async () => {
    assert.ok((await ext.options.evaluate(() => window.__stats.length)) > 0);
    const tabId = await ext.tabId("harness.test");
    const badge = await ext.options.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
    assert.notEqual(badge, "");
  });

  it("bewertet nachgeladene Absätze", async () => {
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.id = "dyn";
      // echtes Englisch - die Harness-Seite ist lang="de", unklare Sprache würde übersprungen
      p.textContent = "This paragraph was inserted by a script after the page had loaded. ".repeat(4);
      document.body.append(p);
    });
    await page.waitForFunction(() => document.querySelector("#dyn")?.dataset.aivsaiLevel, null, { timeout: 5000 });
  });

  it("holt beim Neu-Scan alles aus dem Cache, ohne Backend-Anfrage", async () => {
    const before = backend.requests;
    await ext.sendToTab("harness.test", { type: "SCAN_NOW" });
    await page.waitForFunction(() => document.querySelectorAll("[data-aivsai-level]").length >= 5 && !document.querySelector(".aivsai-pending"));
    await sleep(500);
    assert.equal(backend.requests, before);
  });

  it("färbt nach geänderten Schwellen neu ein, ohne neu zu bewerten", async () => {
    const before = backend.requests;
    await ext.configure({ yellowFrom: 0.1, redFrom: 0.15 });
    await page.waitForFunction(() => !document.querySelector(".aivsai-green, .aivsai-yellow"));
    const stats = await ext.sendToTab("harness.test", { type: "GET_STATS" });
    assert.ok(stats.red > 0);
    assert.equal(stats.yellow + stats.green, 0);
    assert.equal(backend.requests, before);
    await ext.configure({ yellowFrom: 0.6, redFrom: 0.9 });
  });

  it("prüft markierten Text und zeigt das Ergebnis im Popover", async () => {
    await page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector("#long-example"));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await ext.sendToTab("harness.test", { type: "CHECK_SELECTION" });
    await page.waitForFunction(() => /Hinweis, kein Beweis/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.ok(await page.evaluate(() => ["green", "yellow", "red", "uncertain"].some((l) => CSS.highlights.get(`aivsai-${l}`)?.size)));
    await page.keyboard.press("Escape");
    assert.equal(await page.$("aivsai-popover"), null);
  });

  it("prüft per Rechtsklick auch kurze Blöcke und weist auf wenig Text hin", async () => {
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "short";
      d.textContent = "A short div with just enough words here.";
      document.body.append(d);
    });
    await page.click("#short", { button: "right" });
    await ext.sendToTab("harness.test", { type: "CHECK_ELEMENT" });
    await page.waitForFunction(() => document.querySelector("#short").dataset.aivsaiLevel);
    // grün mit Hinweis oder - bei hohem Score - „unsicher“ statt gelb/rot
    assert.match(await page.evaluate(() => document.querySelector("aivsai-popover").shadowRoot.textContent), /Kurzer Text|Nur 8 Wörter/);
  });

  it("zeigt kurze Absätze mit hohem Score als „unsicher“ statt gelb/rot", async () => {
    // Provider "Lokal" mit TMR, Schwellen seit dem Test oben 0.6/0.9
    const min = AIVSAI_MODELS.tmr.reliableWords;
    const wrong = await page.$$eval(
      "[data-aivsai-level]",
      // words: die Wortzahl, die tatsächlich über die Ampel entschieden hat (bei gruppierten Absätzen die
      // der ganzen Gruppe, siehe content.js style()) - nicht die des einzelnen Absatzes (el.innerText)
      (els, min) =>
        els
          .map((el) => ({ level: el.dataset.aivsaiLevel, p: Number(el.dataset.aivsaiScore), words: Number(el.dataset.aivsaiWords) }))
          .filter(({ level, p, words }) => (words < min && p >= 0.6 ? level !== "uncertain" : level === "uncertain")),
      min
    );
    assert.deepEqual(wrong, []);
    assert.ok(await page.$(".aivsai-uncertain[data-aivsai-label='unsicher']"), "kein Absatz „unsicher“ im Harness");
  });

  it("bewertet Absätze in anderer Sprache nicht und nennt sie im Popup-Status", async () => {
    const stats = await ext.sendToTab("harness.test", { type: "GET_STATS" });
    assert.equal(stats.skipped, 2); // Einleitung und Beispiel C
    assert.equal(await page.$$eval("[data-aivsai-skipped='de']", (els) => els.length), 2);
    assert.ok(!backend.texts.some((t) => t.includes("Wärmeleitfähigkeit")), "deutscher Text ging ans Backend");

    // Polnisch kennt die Funktionswort-Heuristik nicht - erkannt von Chromes CLD3 (chrome.i18n.detectLanguage),
    // sonst stünde hier das lang-Attribut der Seite ("de")
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

    // Rechtsklick: erst Hinweis, auf Wunsch trotzdem prüfen - Ergebnis dann „unsicher“, nie rot
    await page.click("text=Wärmeleitfähigkeit", { button: "right" });
    await ext.sendToTab("harness.test", { type: "CHECK_ELEMENT" });
    const popover = () => page.evaluate(() => document.querySelector("aivsai-popover")?.shadowRoot.textContent || "");
    await page.waitForFunction(() => /Trotzdem prüfen/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.match(await popover(), /Text auf Deutsch/);
    await page.getByRole("button", { name: "Trotzdem prüfen", exact: true }).click();
    await page.waitForFunction(() => /Nicht bewertbar/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.ok(backend.texts.some((t) => t.includes("Wärmeleitfähigkeit")));
    // erkannte Sprache geht als `lang` mit (Vertrag in server/README.md) - englische Absätze des Auto-Scans
    // als "en", der erzwungene deutsche als "de"
    const langOf = (word) => backend.langs[backend.batches.findIndex((b) => b.some((t) => t.includes(word)))];
    assert.equal(langOf("Wärmeleitfähigkeit"), "de");
    assert.ok(backend.langs.includes("en"), `lang der Anfragen: ${backend.langs}`);
    const levels = await page.$$eval("[data-aivsai-level]", (els) =>
      els.filter((el) => el.textContent.includes("Wärmeleitfähigkeit")).map((el) => el.dataset.aivsaiLevel)
    );
    assert.deepEqual(levels, ["uncertain"]);
    await page.keyboard.press("Escape");
  });

  it("entfernt beim Ausschalten alles und scannt nichts Neues", async () => {
    await ext.configure({ enabled: false });
    await page.waitForFunction(() => !document.querySelector("[data-aivsai-level], .aivsai-pending"));
    assert.equal(await ext.options.evaluate(() => chrome.action.getBadgeText({})), "AUS");
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

  it("holt beim Einschalten nach, was in der Zwischenzeit dazukam", async () => {
    await ext.configure({ enabled: true });
    await page.waitForFunction(() => document.querySelector("#off")?.dataset.aivsaiLevel, null, { timeout: 5000 });
  });

  it("bewertet mit Lazy-Scan nur die Nähe und den Rest beim Scrollen", async () => {
    await ext.configure({ lazyScan: true });
    const tallPage = await ext.open("http://tall.test/");
    await tallPage.waitForFunction(() => document.querySelector("#p0")?.dataset.aivsaiLevel && !document.querySelector(".aivsai-pending"));
    const stats = await ext.sendToTab("tall.test", { type: "GET_STATS" });
    assert.ok(stats.deferred > 0, "nichts zurückgestellt");
    assert.equal(await tallPage.$eval("#p59", (e) => e.dataset.aivsaiLevel ?? null), null);
    await tallPage.evaluate(() => document.querySelector("#p59").scrollIntoView());
    await tallPage.waitForFunction(() => document.querySelector("#p59")?.dataset.aivsaiLevel, null, { timeout: 15_000 });
    await tallPage.close();
  });

  it("scannt nicht freigegebene Seiten nicht", async () => {
    await ext.configure({ sites: ["harness.test"] });
    const tallPage = await ext.open("http://tall.test/");
    await sleep(1500);
    const stats = await ext.sendToTab("tall.test", { type: "GET_STATS" });
    assert.equal(stats.active, false);
    assert.equal(stats.red + stats.yellow + stats.green + stats.pending, 0);
    await tallPage.close();
  });

  it("scannt Seiten der Sperrliste weder automatisch noch auf Knopfdruck", async () => {
    await ext.configure({ scanMode: "all", blockedSites: ["bank.test"] });
    const before = backend.requests;
    const bank = await ext.open("http://sub.bank.test/");
    await sleep(1500);
    const stats = await ext.sendToTab("sub.bank.test", { type: "SCAN_NOW" });
    assert.equal(stats.blocked, true);
    assert.equal(stats.active, false);
    await sleep(1200);
    assert.equal(backend.requests, before, "Text von gesperrter Seite gesendet");
    assert.match(await bank.evaluate(() => document.querySelector("aivsai-popover").shadowRoot.textContent), /Sperrliste/);
    await bank.keyboard.press("Escape");

    // Einzelprüfung bleibt erlaubt, mit Hinweis
    await bank.click("#p0", { button: "right" });
    await ext.sendToTab("sub.bank.test", { type: "CHECK_ELEMENT" });
    await bank.waitForFunction(() => document.querySelector("#p0").dataset.aivsaiLevel);
    assert.match(await bank.evaluate(() => document.querySelector("aivsai-popover").shadowRoot.textContent), /Sperrliste – geprüft/);
    assert.equal(await bank.$$eval("[data-aivsai-level]", (els) => els.length), 1);
    await bank.close();
  });

  it("scannt nach dem Entfernen von der Sperrliste wieder", async () => {
    const bank = await ext.open("http://bank.test/");
    await ext.configure({ blockedSites: [] });
    await bank.waitForFunction(() => document.querySelector("#p0")?.dataset.aivsaiLevel, null, { timeout: 10_000 });
    await bank.close();
  });

  it("sperrt Domains der mitgelieferten Liste, mit Ausnahme pro Host", async () => {
    const info = await ext.options.evaluate(() => ({ count: AIVSAI_BLOCKLIST.count, reason: AIVSAI.blockReason("secure.chase.com", AIVSAI.DEFAULTS) }));
    assert.ok(info.count > 5000, "mitgelieferte Liste fehlt oder ist zu klein");
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

  it("scannt keine Seiten mit sichtbarem Passwortfeld, Login-Dialoge zählen nicht", async () => {
    const before = backend.requests;
    const login = await ext.open("http://login.test/");
    await sleep(1500);
    const stats = await ext.sendToTab("login.test", { type: "GET_STATS" });
    assert.equal(stats.blockReason, "sensitive");
    assert.equal(backend.requests, before);
    await login.close();

    // Passwortfeld nur im Dialog bzw. versteckt: normal scannen
    const news = await ext.open("http://news.test/");
    await news.waitForFunction(() => document.querySelector("#p0")?.dataset.aivsaiLevel, null, { timeout: 10_000 });

    // SPA wechselt auf eine Login-Ansicht: Markierungen verschwinden, nichts Neues wird gesendet
    await news.evaluate(() => document.body.insertAdjacentHTML("afterbegin", '<input type="password" id="pw">'));
    await news.waitForFunction(() => !document.querySelector("[data-aivsai-level]"), null, { timeout: 5000 });
    assert.equal((await ext.sendToTab("news.test", { type: "GET_STATS" })).blockReason, "sensitive");

    // Heuristik abschaltbar
    await ext.configure({ sensitiveHeuristic: false });
    await news.waitForFunction(() => document.querySelector("#p0")?.dataset.aivsaiLevel, null, { timeout: 10_000 });
    await ext.configure({ sensitiveHeuristic: true, scanMode: "sites" });
    await news.close();
  });

  it("meldet Backend-Status und Verbindungstest", async () => {
    assert.equal((await ext.send({ type: "HEALTH" })).ok, true);
    const test = await ext.send({ type: "TEST_PROVIDER" });
    assert.equal(test.ok, true);
    assert.equal(typeof test.score, "number");
  });

  it("erreicht das Offscreen-Dokument für das Browser-Modell", async () => {
    await ext.configure({ provider: "browser", browserModel: "tmr" });
    const status = await ext.send({ type: "MODEL_STATUS" });
    assert.equal(status.ok, true);
    assert.ok("tmr" in status.models && "desklib" in status.models);
    const health = await ext.send({ type: "HEALTH" });
    // ohne heruntergeladenes Modell: klarer Hinweis statt Fehler
    if (!status.models.tmr.downloaded) assert.match(health.error, /nicht heruntergeladen/);
  });

  it("zeigt Modell-Infos und Presets aus models.js in den Einstellungen", async () => {
    await ext.options.reload();
    await ext.options.check('input[name="browserModel"][value="desklib"]');
    assert.equal(await ext.options.inputValue("#yellowFrom"), "0.5");
    assert.equal(await ext.options.inputValue("#redFrom"), "0.87");
    assert.match(await ext.options.textContent("#browserModelInfo"), /1,7 GB/);
  });

  it("hat keine Konsolenfehler", () => {
    assert.deepEqual(ext.errors, []);
  });
});
