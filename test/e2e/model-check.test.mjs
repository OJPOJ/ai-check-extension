// „Modell prüfen“ in der echten Einstellungsseite: Pflicht vor dem Speichern eines eigenen Servers,
// Anzeige der Einzelergebnisse, Ampel-Vorschlag, Version im Modellschlüssel.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { REFERENCE_SET } from "../../extension/bg/reference-set.js";
import { launchExtension, startBackend } from "./helpers.mjs";

// Guter Detektor fürs Referenzset: KI-Texte hoch, Mensch-Texte niedrig; alles andere unauffällig
const aiOf = (t) => REFERENCE_SET.find((r) => r.text.startsWith(t))?.ai;
const good = (t) => ({ true: 0.92, false: 0.15, undefined: 0.3 })[aiOf(t)];

describe("Modell prüfen", () => {
  let backend, swapped, ext;
  const status = () => ext.options.textContent("#status");
  const waitStatus = (text) =>
    ext.options.waitForFunction((t) => document.querySelector("#status").textContent.includes(t), text, { timeout: 20_000 });

  before(async () => {
    backend = await startBackend(good, { info: { name: "Fake", version: "v7", suggestedThresholds: { yellowFrom: 0.4, redFrom: 0.8 } } });
    swapped = await startBackend((t) => 1 - good(t)); // liefert P(Mensch), ohne /v1/info
    ext = await launchExtension();
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
    await swapped?.close();
  });

  async function chooseCustom(url) {
    await ext.options.check('input[name="provider"][value="custom"]');
    await ext.options.fill("#customUrl", `${url}/v1/score`);
  }

  it("eigener Server: ohne bestandene Prüfung kein Speichern", async () => {
    await chooseCustom(backend.url);
    assert.match(await ext.options.textContent("#check-custom-status"), /Pflicht/);
    await ext.options.click("#save");
    assert.match(await status(), /zuerst „Modell prüfen“/);
    const saved = await ext.options.evaluate(() => chrome.storage.sync.get("provider"));
    assert.notEqual(saved.provider, "custom");
  });

  it("vertauschte Labels: nicht bestanden, Speichern bleibt gesperrt", async () => {
    await chooseCustom(swapped.url);
    await ext.options.click("#check-custom");
    await waitStatus("nicht bestanden");
    const fails = await ext.options.$$eval("#check-custom-list li.fail", (els) => els.map((e) => e.textContent));
    assert.equal(fails.length, 1);
    assert.match(fails[0], /P\(Mensch\) statt P\(KI\)/);
    await ext.options.click("#save");
    assert.match(await status(), /nicht bestanden/);
  });

  it("guter Server: bestanden, Ampel vom Server, Speichern mit Version im Modellschlüssel", async () => {
    await chooseCustom(backend.url);
    assert.match(await ext.options.textContent("#check-custom-status"), /Noch nicht geprüft/); // andere URL
    const before = backend.requests;
    await ext.options.click("#check-custom");
    await waitStatus("geprüft – bestanden");
    assert.equal(backend.texts.filter((t) => aiOf(t) !== undefined).length, 41); // Aufwärmen + 40
    assert.ok(backend.requests - before > 2, "Referenzset in mehreren Batches");
    assert.match(await ext.options.textContent("#check-custom-status"), /Bestanden am .*AUROC 1\.00.*Version v7/);
    const items = await ext.options.$$eval("#check-custom-list li", (els) => els.map((e) => [e.className, e.textContent]));
    assert.ok(items.some(([c, t]) => c === "ok" && /Trennschärfe: AUROC 1\.00/.test(t)));
    assert.ok(items.some(([c, t]) => c === "info" && /Vorschlag des Servers/.test(t)));
    assert.equal(await ext.options.inputValue("#yellowFrom"), "0.4");
    assert.equal(await ext.options.inputValue("#redFrom"), "0.8");

    await ext.options.click("#save");
    await waitStatus("Gespeichert.");
    const model = await ext.options.evaluate(async () => {
      const cfg = await chrome.storage.sync.get(null);
      return { key: AIVSAI.modelKey(cfg), check: cfg.modelChecks.custom };
    });
    assert.equal(model.key, `custom:${backend.url}/v1/score@v7`);
    assert.equal(model.check.ok, true);
    assert.equal(model.check.checks, undefined); // Einzelergebnisse nur zur Anzeige, nicht im Sync-Storage
  });

  it("neue URL entwertet die Prüfung", async () => {
    await ext.options.fill("#customUrl", `${backend.url}/anders/v1/score`);
    assert.match(await ext.options.textContent("#check-custom-status"), /Noch nicht geprüft/);
    assert.equal(await ext.options.$$eval("#check-custom-list li", (els) => els.length), 0);
  });
});
