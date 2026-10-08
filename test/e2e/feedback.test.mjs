// Feedback in the result popover: label + basis, consent before the first save, undo,
// export/withdrawal only from the settings, switching off the buttons.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, longText, startBackend } from "./helpers.mjs";

const TEXT = "Our small bakery opened in 1998 and every loaf is still shaped by hand before sunrise each morning.";
const page = `<html lang="en"><body><p id="own">${TEXT}</p></body></html>`;
// Auto-scan with badges; one paragraph sits in a link (a click on the badge must not navigate)
const scanned =
  `<html><body style="padding:40px"><p id="plain">${longText("plain")}</p>` +
  `<a href="http://auto.test/elsewhere"><p id="linked">${longText("linked")}</p></a></body></html>`;

/** Center of the percent badge (::after, top right of the paragraph, see content.css) */
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
    await tab.keyboard.press("Escape"); // close the old popover, otherwise its result counts
    await tab.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector("#own"));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await ext.sendToTab("feedback.test", { type: "CHECK_SELECTION" });
    await tab.waitForFunction(() => /Hint, not proof/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
  }

  before(async () => {
    backend = await startBackend(() => 0.97); // model takes the human text for AI
    ext = await launchExtension({ pages: { "feedback.test": page, "auto.test": scanned } });
    await ext.configure({ provider: "local", localUrl: backend.url, scanMode: "manual" });
    tab = await ext.open("http://feedback.test/");
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  it("asks for consent before the first save and stores only afterwards", async () => {
    await checkParagraph();
    assert.match(await popoverText(), /Do you know where the text comes from\?/);
    await button("By a human").click();
    assert.match(await popoverText(), /how do you know\?/);
    await button("Written myself / author known").click();
    await tab.waitForFunction(() => /Save feedback\?/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    assert.equal((await info()).count, 0, "nothing may be stored before consent");

    await button("Agree, save").click();
    await tab.waitForFunction(() => /Thanks!/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    const r = await info();
    assert.equal(r.count, 1);
    assert.equal(r.human, 1);
    assert.equal(r.disagree, 1);
    assert.ok(r.consentAt > 0);
  });

  it("exports text, label, basis, score and model – but no address", async () => {
    const { ok, rows } = await ext.send({ type: "FEEDBACK_EXPORT" });
    assert.ok(ok);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.text, TEXT);
    assert.deepEqual([row.label, row.basis, row.p, row.source, row.lang], ["human", "own", 0.97, "selection", "en"]);
    assert.match(row.model, /^local:/);
    assert.doesNotMatch(JSON.stringify(row), /feedback\.test/);
  });

  it("undoes an entry and does not ask again once consent is given", async () => {
    await button("Undo").click();
    await tab.waitForFunction(() => /Do you know where/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    assert.equal((await info()).count, 0);

    await button("By an AI").click();
    await button("Just my impression").click();
    await tab.waitForFunction(() => /Thanks!/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    assert.match(await popoverText(), /reliable label/);
    const r = await info();
    assert.deepEqual([r.count, r.ai, r.guess, r.disagree], [1, 1, 1, 0]);
  });

  it("shows the state in the settings", async () => {
    await ext.options.reload();
    await ext.options.waitForFunction(() => /1 entry/.test(document.querySelector("#feedbackStatus").textContent));
    assert.equal(await ext.options.isDisabled("#feedbackExport"), false);
  });

  it("deletes everything on withdrawal and stores nothing without consent", async () => {
    ext.options.once("dialog", (d) => d.accept());
    await ext.options.click("#feedbackClear");
    await ext.options.waitForFunction(() => /No entries · No consent/.test(document.querySelector("#feedbackStatus").textContent));
    const r = await ext.send({ type: "FEEDBACK_SAVE", entry: { text: TEXT, label: "human", basis: "own" } });
    assert.equal(r.ok, false);
    assert.match(r.error, /consent/);
    assert.equal((await info()).count, 0);
  });

  it("offers no feedback on blocklisted sites", async () => {
    await ext.configure({ blockedSites: ["feedback.test"] });
    await checkParagraph();
    assert.match(await popoverText(), /blocklist/);
    assert.doesNotMatch(await popoverText(), /Do you know/);
    await ext.configure({ blockedSites: [] });
  });

  it("opens details and feedback via a click on the badge of an automatically scored paragraph", async () => {
    await ext.configure({ scanMode: "sites", sites: ["auto.test"] });
    const auto = await ext.open("http://auto.test/");
    await auto.waitForSelector("#plain.aivsai-badge");
    await auto.waitForSelector("#linked.aivsai-badge");
    const requests = backend.requests;
    const text = () => auto.evaluate(() => document.querySelector("aivsai-popover")?.shadowRoot.textContent || "");

    // Click into the text: nothing happens
    const r = await auto.$eval("#plain", (el) => el.getBoundingClientRect().toJSON());
    await auto.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    assert.equal(await text(), "");

    const { x, y } = await badgeCenter(auto, "#plain");
    await auto.mouse.click(x, y);
    await auto.waitForFunction(() => /Do you know where/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.match(await text(), /AI score 97/);
    assert.equal(backend.requests, requests, "details must not recompute");

    // Feedback flow as with the manual check, text = what the auto-scan scored
    await auto.getByRole("button", { name: "By a human", exact: true }).click();
    await auto.getByRole("button", { name: "Published before 2023", exact: true }).click();
    await auto.getByRole("button", { name: "Agree, save", exact: true }).click(); // withdrawn above
    await auto.waitForFunction(() => /Thanks!/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    const { rows } = await ext.send({ type: "FEEDBACK_EXPORT" });
    const row = rows.find((x) => x.text.startsWith("plain "));
    assert.deepEqual([row.label, row.basis, row.source], ["human", "date", "auto"]);

    // The answer is kept: after reloading the badge click shows it instead of asking again
    await auto.reload();
    await auto.waitForSelector("#plain.aivsai-badge");
    const again = await badgeCenter(auto, "#plain");
    await auto.mouse.click(again.x, again.y);
    const saved = /Your answer: by a human – Published before 2023/;
    await auto.waitForFunction((re) => new RegExp(re).test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""), saved.source);
    assert.doesNotMatch(await text(), /Do you know/);

    // Change replaces the entry, Undo restores the old answer, Remove deletes
    const click = (name) => auto.getByRole("button", { name, exact: true }).click();
    const plainRows = async () => (await ext.send({ type: "FEEDBACK_EXPORT" })).rows.filter((x) => x.text.startsWith("plain "));
    await click("Change");
    await click("By an AI");
    await click("Labeled as AI text");
    await auto.waitForFunction(() => /Thanks!/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    assert.deepEqual((await plainRows()).map((x) => [x.label, x.basis]), [["ai", "marked"]]);
    await click("Undo");
    await auto.waitForFunction((re) => new RegExp(re).test(document.querySelector("aivsai-popover").shadowRoot.textContent), saved.source);
    assert.deepEqual((await plainRows()).map((x) => [x.label, x.basis]), [["human", "date"]]);
    await click("Remove");
    await auto.waitForFunction(() => /Do you know where/.test(document.querySelector("aivsai-popover").shadowRoot.textContent));
    assert.equal((await plainRows()).length, 0);

    // Paragraph in a link: badge click opens details instead of navigating
    await auto.keyboard.press("Escape");
    const linked = await badgeCenter(auto, "#linked");
    await auto.mouse.click(linked.x, linked.y);
    await auto.waitForFunction(() => /Do you know where/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.equal(auto.url(), "http://auto.test/");
    await auto.close();
    await ext.configure({ scanMode: "manual" });
  });

  it("shows no feedback buttons when they are switched off", async () => {
    await ext.configure({ feedbackButtons: false });
    await checkParagraph();
    assert.doesNotMatch(await popoverText(), /Do you know/);
    await ext.configure({ feedbackButtons: true });
  });
});
