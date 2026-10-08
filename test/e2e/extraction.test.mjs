// What goes to the model? A page full of edge cases; the fake backend records every text sent.
// Every case carries a unique identifier in the text. Runs with and without lazy scan.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, longText as W, sleep, startBackend } from "./helpers.mjs";

// [identifier in the text, should go to the model?, HTML, reason]
const CASES = [
  ["NORMALP", true, `<p>${W("NORMALP")}</p>`, "normal paragraph"],
  ["ARTP", true, `<article><p>${W("ARTP")}</p><p>short</p></article>`, "paragraph in an article (only the paragraph, not the article)"],
  ["LILONG", true, `<ul><li>${W("LILONG")}</li></ul>`, "long list item"],
  ["SUPREF", true, `<p>${W("SUPREF")} <a href="#">link</a><sup>[1]</sup></p>`, "paragraph with link and footnote"],
  ["SCRIPTP", true, `<p>${W("SCRIPTP")}<script>var SECRETJS = 1;</script><style>.SECRETCSS{}</style></p>`, "paragraph with script/style"],
  ["ICONP", true, `<p>${W("ICONP")} <span aria-hidden="true" class="material-icons">chevron_right ICONTEXT</span></p>`, "paragraph with icon font"],
  ["ARIAHIDDEN", true, `<div aria-hidden="true"><p>${W("ARIAHIDDEN")}</p></div>`, "aria-hidden on the ancestor (sites hide everything this way while a modal is open)"],
  ["FORMP", true, `<form><p>${W("FORMP")}</p><input></form>`, "form (ASP.NET wraps whole pages in a <form>)"],
  ["NAVLI", false, `<nav><ul><li>${W("NAVLI")}</li></ul></nav>`, "nav"],
  ["ROLENAV", false, `<div role="navigation"><ul><li>${W("ROLENAV")}</li></ul></div>`, "role=navigation"],
  ["HEADERP", false, `<header><p>${W("HEADERP")}</p></header>`, "header"],
  ["FOOTERP", false, `<footer><p>${W("FOOTERP")}</p></footer>`, "footer"],
  ["CONTENTINFO", false, `<div role="contentinfo"><p>${W("CONTENTINFO")}</p></div>`, "role=contentinfo"],
  ["COOKIE", false, `<div role="dialog" aria-label="Cookies"><p>${W("COOKIE")}</p></div>`, "cookie banner (role=dialog)"],
  ["DIALOGEL", false, `<dialog open><p>${W("DIALOGEL")}</p></dialog>`, "<dialog>"],
  ["DISPNONE", false, `<p style="display:none">${W("DISPNONE")}</p>`, "display:none"],
  ["HIDDENATTR", false, `<p hidden>${W("HIDDENATTR")}</p>`, "hidden attribute"],
  ["DETAILS", false, `<details><summary>More</summary><p>${W("DETAILS")}</p></details>`, "collapsed <details>"],
  ["EDITABLE", false, `<div contenteditable="true"><p>${W("EDITABLE")}</p></div>`, "contenteditable"],
  ["TEXTAREA", false, `<textarea>${W("TEXTAREA")}</textarea>`, "textarea"],
  ["CODELI", false, `<ul><li><pre><code>${W("CODELI")}</code></pre></li></ul>`, "code block in a list item"],
  ["TEMPLATE", false, `<template><p>${W("TEMPLATE")}</p></template>`, "template"],
  ["TOOSHORT", false, `<p>TOOSHORT to matter.</p>`, "under 40 words"]
];

const fixture =
  `<html><body><main>${CASES.map(([id, , html]) => `<section>${html}</section>`).join("\n")}` +
  `<p id="later" style="display:none">${W("LATERSHOWN")}</p></main>` +
  `<div id="shadowhost"></div><script>document.getElementById("shadowhost").attachShadow({mode:"open"})` +
  `.innerHTML = "<p>SHADOWP ${"x ".repeat(50)}</p>";</script></body></html>`;

for (const lazyScan of [false, true]) {
  describe(`Text selection (lazyScan=${lazyScan})`, () => {
    let backend, ext, page;
    const sent = (tag) => backend.texts.some((t) => t.includes(tag));

    before(async () => {
      backend = await startBackend(() => 0.5);
      // tall viewport: all cases are in the visible area, lazy scan defers nothing
      ext = await launchExtension({ pages: { "fixture.test": fixture }, viewport: { width: 900, height: 5000 } });
      await ext.configure({ provider: "local", localUrl: backend.url, sites: ["fixture.test"], lazyScan, scoreRetentionDays: 0 });
      page = await ext.open("http://fixture.test/");
      await page.waitForFunction(() => document.querySelectorAll("[data-aivsai-level]").length >= 8, null, { timeout: 15_000 });
      await sleep(800); // wait for the last batches
    });

    after(async () => {
      await ext?.close();
      await backend?.close();
    });

    for (const [tag, expected, , why] of CASES) {
      it(`${expected ? "sends" : "does not send"}: ${why}`, () => {
        assert.equal(sent(tag), expected, `${tag} ${expected ? "is missing" : "was sent"}`);
      });
    }

    it("sends no script/style content and no icon text", () => {
      assert.ok(!backend.texts.some((t) => /SECRETJS|SECRETCSS|ICONTEXT|chevron_right|<\w/.test(t)));
    });

    it("sends invisible paragraphs only when they become visible", async () => {
      assert.equal(sent("LATERSHOWN"), false);
      await page.evaluate(() => (document.getElementById("later").style.display = "block"));
      await page.waitForFunction(() => document.getElementById("later").dataset.aivsaiLevel, null, { timeout: 5000 });
      assert.equal(sent("LATERSHOWN"), true);
    });

    it("does not reach shadow DOM (known limitation)", () => {
      assert.equal(sent("SHADOWP"), false);
    });

    it("has no console errors", () => {
      assert.deepEqual(ext.errors, []);
    });
  });
}
