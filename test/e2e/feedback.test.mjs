// Feedback im Ergebnis-Popover: Label + Grundlage, Einwilligung vor dem ersten Speichern, Rückgängig,
// Export/Widerruf nur aus den Einstellungen, Abschalten der Knöpfe.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, longText, startBackend } from "./helpers.mjs";

const TEXT = "Our small bakery opened in 1998 and every loaf is still shaped by hand before sunrise each morning.";
const page = `<html lang="en"><body><p id="own">${TEXT}</p></body></html>`;
// Auto-Scan mit Badges; ein Absatz steckt in einem Link (Klick aufs Badge darf nicht navigieren)
const scanned =
  `<html><body style="padding:40px"><p id="plain">${longText("plain")}</p>` +
  `<a href="http://auto.test/elsewhere"><p id="linked">${longText("linked")}</p></a></body></html>`;

/** Mitte des Prozent-Badges (::after, oben rechts am Absatz, siehe content.css) */
const badgeCenter = (tab, sel) =>
  tab.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    const b = getComputedStyle(el, "::after");
    return { x: r.right + 6 - (parseFloat(b.width) + 12) / 2, y: r.top - 12 + parseFloat(b.height) / 2 };
  });

describe("Feedback", () => {
  let backend, ext, tab;

  const info = () => ext.send({ type: "FEEDBACK_INFO" });
  const popoverText = () => tab.evaluate(() => document.querySelector("aivsai-popover")?.shadowRoot.textContent || "");
  const button = (name) => tab.getByRole("button", { name, exact: true });

  async function checkParagraph() {
    await tab.keyboard.press("Escape"); // altes Popover schließen, sonst zählt dessen Ergebnis
    await tab.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector("#own"));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await ext.sendToTab("feedback.test", { type: "CHECK_SELECTION" });
    await tab.waitForFunction(() => /% KI/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
  }

  before(async () => {
    backend = await startBackend(() => 0.97); // Modell hält den menschlichen Text für KI
    ext = await launchExtension({ pages: { "feedback.test": page, "auto.test": scanned } });
    await ext.configure({ provider: "local", localUrl: backend.url, scanMode: "manual" });
    tab = await ext.open("http://feedback.test/");
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  it("fragt vor dem ersten Speichern nach der Einwilligung und speichert erst danach", async () => {
    await checkParagraph();
    assert.match(await popoverText(), /Weißt du, woher der Text stammt\?/);
    await button("Von einem Menschen").click();
    assert.match(await popoverText(), /woher weißt du das\?/);
    await button("Selbst geschrieben / Autor:in bekannt").click();
    await tab.waitForFunction(() => /Feedback speichern\?/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    assert.equal((await info()).count, 0, "vor der Einwilligung darf nichts gespeichert sein");

    await button("Einverstanden, speichern").click();
    await tab.waitForFunction(() => /Danke!/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    const r = await info();
    assert.equal(r.count, 1);
    assert.equal(r.human, 1);
    assert.equal(r.disagree, 1);
    assert.ok(r.consentAt > 0);
  });

  it("exportiert Text, Label, Grundlage, Score und Modell – aber keine Adresse", async () => {
    const { ok, rows } = await ext.send({ type: "FEEDBACK_EXPORT" });
    assert.ok(ok);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.text, TEXT);
    assert.deepEqual([row.label, row.basis, row.p, row.source, row.lang], ["human", "own", 0.97, "selection", "en"]);
    assert.match(row.model, /^local:/);
    assert.doesNotMatch(JSON.stringify(row), /feedback\.test/);
  });

  it("macht einen Eintrag rückgängig und fragt nach erteilter Einwilligung nicht erneut", async () => {
    await button("Rückgängig").click();
    await tab.waitForFunction(() => /Weißt du, woher/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    assert.equal((await info()).count, 0);

    await button("Von einer KI").click();
    await button("Nur mein Eindruck").click();
    await tab.waitForFunction(() => /Danke!/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    assert.match(await popoverText(), /nicht als gesichertes Label/);
    const r = await info();
    assert.deepEqual([r.count, r.ai, r.guess, r.disagree], [1, 1, 1, 0]);
  });

  it("zeigt den Stand in den Einstellungen", async () => {
    await ext.options.reload();
    await ext.options.waitForFunction(() => /1 Eintrag/.test(document.querySelector("#feedbackStatus").textContent));
    assert.equal(await ext.options.isDisabled("#feedbackExport"), false);
  });

  it("löscht beim Widerruf alles und speichert ohne Einwilligung nichts", async () => {
    ext.options.once("dialog", (d) => d.accept());
    await ext.options.click("#feedbackClear");
    await ext.options.waitForFunction(() => /Keine Einträge · Keine Einwilligung/.test(document.querySelector("#feedbackStatus").textContent));
    const r = await ext.send({ type: "FEEDBACK_SAVE", entry: { text: TEXT, label: "human", basis: "own" } });
    assert.equal(r.ok, false);
    assert.match(r.error, /Einwilligung/);
    assert.equal((await info()).count, 0);
  });

  it("bietet auf Seiten der Sperrliste kein Feedback an", async () => {
    await ext.configure({ blockedSites: ["feedback.test"] });
    await checkParagraph();
    assert.match(await popoverText(), /Sperrliste/);
    assert.doesNotMatch(await popoverText(), /Weißt du/);
    await ext.configure({ blockedSites: [] });
  });

  it("öffnet per Klick aufs Badge eines automatisch bewerteten Absatzes Details und Feedback", async () => {
    await ext.configure({ scanMode: "sites", sites: ["auto.test"] });
    const auto = await ext.open("http://auto.test/");
    await auto.waitForSelector("#plain.aivsai-badge");
    await auto.waitForSelector("#linked.aivsai-badge");
    const requests = backend.requests;
    const text = () => auto.evaluate(() => document.querySelector("aivsai-popover")?.shadowRoot.textContent || "");

    // Klick in den Text: nichts passiert
    const r = await auto.$eval("#plain", (el) => el.getBoundingClientRect().toJSON());
    await auto.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    assert.equal(await text(), "");

    const { x, y } = await badgeCenter(auto, "#plain");
    await auto.mouse.click(x, y);
    await auto.waitForFunction(() => /Weißt du, woher/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.match(await text(), /97 % KI/);
    assert.equal(backend.requests, requests, "Details dürfen nicht neu rechnen");

    // Feedback-Ablauf wie bei der manuellen Prüfung, Text = was der Auto-Scan bewertet hat
    await auto.getByRole("button", { name: "Von einem Menschen", exact: true }).click();
    await auto.getByRole("button", { name: "Vor 2023 veröffentlicht", exact: true }).click();
    await auto.getByRole("button", { name: "Einverstanden, speichern", exact: true }).click(); // oben widerrufen
    await auto.waitForFunction(() => /Danke!/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    const { rows } = await ext.send({ type: "FEEDBACK_EXPORT" });
    const row = rows.find((x) => x.text.startsWith("plain "));
    assert.deepEqual([row.label, row.basis, row.source], ["human", "date", "auto"]);

    // Angabe bleibt erhalten: nach dem Neuladen zeigt der Badge-Klick sie an statt neu zu fragen
    await auto.reload();
    await auto.waitForSelector("#plain.aivsai-badge");
    const again = await badgeCenter(auto, "#plain");
    await auto.mouse.click(again.x, again.y);
    const saved = /Deine Angabe: von einem Menschen – Vor 2023 veröffentlicht/;
    await auto.waitForFunction((re) => new RegExp(re).test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""), saved.source);
    assert.doesNotMatch(await text(), /Weißt du/);

    // Ändern ersetzt den Eintrag, Rückgängig stellt die alte Angabe wieder her, Entfernen löscht
    const click = (name) => auto.getByRole("button", { name, exact: true }).click();
    const plainRows = async () => (await ext.send({ type: "FEEDBACK_EXPORT" })).rows.filter((x) => x.text.startsWith("plain "));
    await click("Ändern");
    await click("Von einer KI");
    await click("Als KI-Text gekennzeichnet");
    await auto.waitForFunction(() => /Danke!/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    assert.deepEqual((await plainRows()).map((x) => [x.label, x.basis]), [["ai", "marked"]]);
    await click("Rückgängig");
    await auto.waitForFunction((re) => new RegExp(re).test(document.querySelector("aivsai-popover").shadowRoot.textContent), saved.source);
    assert.deepEqual((await plainRows()).map((x) => [x.label, x.basis]), [["human", "date"]]);
    await click("Entfernen");
    await auto.waitForFunction(() => /Weißt du, woher/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    assert.equal((await plainRows()).length, 0);

    // Absatz im Link: Badge-Klick öffnet Details statt zu navigieren
    await auto.keyboard.press("Escape");
    const linked = await badgeCenter(auto, "#linked");
    await auto.mouse.click(linked.x, linked.y);
    await auto.waitForFunction(() => /Weißt du, woher/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.equal(auto.url(), "http://auto.test/");
    await auto.close();
    await ext.configure({ scanMode: "manual" });
  });

  it("zeigt keine Feedback-Knöpfe, wenn sie abgeschaltet sind", async () => {
    await ext.configure({ feedbackButtons: false });
    await checkParagraph();
    assert.doesNotMatch(await popoverText(), /Weißt du/);
    await ext.configure({ feedbackButtons: true });
  });
});
