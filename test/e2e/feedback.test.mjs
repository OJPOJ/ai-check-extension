// Feedback im Ergebnis-Popover: Label + Grundlage, Einwilligung vor dem ersten Speichern, Rückgängig,
// Export/Widerruf nur aus den Einstellungen, Abschalten der Knöpfe.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, startBackend } from "./helpers.mjs";

const TEXT = "Our small bakery opened in 1998 and every loaf is still shaped by hand before sunrise each morning.";
const page = `<html lang="en"><body><p id="own">${TEXT}</p></body></html>`;

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
    ext = await launchExtension({ pages: { "feedback.test": page } });
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

  it("zeigt keine Feedback-Knöpfe, wenn sie abgeschaltet sind", async () => {
    await ext.configure({ feedbackButtons: false });
    await checkParagraph();
    assert.doesNotMatch(await popoverText(), /Weißt du/);
    await ext.configure({ feedbackButtons: true });
  });
});
