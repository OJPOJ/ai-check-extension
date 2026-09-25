// Was geht ans Modell? Eine Seite voller Grenzfälle; das Fake-Backend schreibt jeden gesendeten Text
// mit. Jeder Fall trägt eine eindeutige Kennung im Text. Läuft mit und ohne Lazy-Scan.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, longText as W, sleep, startBackend } from "./helpers.mjs";

// [Kennung im Text, soll ans Modell?, HTML, Begründung]
const CASES = [
  ["NORMALP", true, `<p>${W("NORMALP")}</p>`, "normaler Absatz"],
  ["ARTP", true, `<article><p>${W("ARTP")}</p><p>short</p></article>`, "Absatz im Artikel (nur der Absatz, nicht der Artikel)"],
  ["LILONG", true, `<ul><li>${W("LILONG")}</li></ul>`, "langer Listeneintrag"],
  ["SUPREF", true, `<p>${W("SUPREF")} <a href="#">link</a><sup>[1]</sup></p>`, "Absatz mit Link und Fußnote"],
  ["SCRIPTP", true, `<p>${W("SCRIPTP")}<script>var SECRETJS = 1;</script><style>.SECRETCSS{}</style></p>`, "Absatz mit Script/Style"],
  ["ICONP", true, `<p>${W("ICONP")} <span aria-hidden="true" class="material-icons">chevron_right ICONTEXT</span></p>`, "Absatz mit Icon-Font"],
  ["ARIAHIDDEN", true, `<div aria-hidden="true"><p>${W("ARIAHIDDEN")}</p></div>`, "aria-hidden am Vorfahren (Seiten verstecken so alles, solange ein Modal offen ist)"],
  ["FORMP", true, `<form><p>${W("FORMP")}</p><input></form>`, "form (ASP.NET packt ganze Seiten in ein <form>)"],
  ["NAVLI", false, `<nav><ul><li>${W("NAVLI")}</li></ul></nav>`, "nav"],
  ["ROLENAV", false, `<div role="navigation"><ul><li>${W("ROLENAV")}</li></ul></div>`, "role=navigation"],
  ["HEADERP", false, `<header><p>${W("HEADERP")}</p></header>`, "header"],
  ["FOOTERP", false, `<footer><p>${W("FOOTERP")}</p></footer>`, "footer"],
  ["CONTENTINFO", false, `<div role="contentinfo"><p>${W("CONTENTINFO")}</p></div>`, "role=contentinfo"],
  ["COOKIE", false, `<div role="dialog" aria-label="Cookies"><p>${W("COOKIE")}</p></div>`, "Cookie-Banner (role=dialog)"],
  ["DIALOGEL", false, `<dialog open><p>${W("DIALOGEL")}</p></dialog>`, "<dialog>"],
  ["DISPNONE", false, `<p style="display:none">${W("DISPNONE")}</p>`, "display:none"],
  ["HIDDENATTR", false, `<p hidden>${W("HIDDENATTR")}</p>`, "hidden-Attribut"],
  ["DETAILS", false, `<details><summary>Mehr</summary><p>${W("DETAILS")}</p></details>`, "zugeklappte <details>"],
  ["EDITABLE", false, `<div contenteditable="true"><p>${W("EDITABLE")}</p></div>`, "contenteditable"],
  ["TEXTAREA", false, `<textarea>${W("TEXTAREA")}</textarea>`, "textarea"],
  ["CODELI", false, `<ul><li><pre><code>${W("CODELI")}</code></pre></li></ul>`, "Code-Block im Listeneintrag"],
  ["TEMPLATE", false, `<template><p>${W("TEMPLATE")}</p></template>`, "template"],
  ["TOOSHORT", false, `<p>TOOSHORT to matter.</p>`, "unter 40 Wörtern"]
];

const fixture =
  `<html><body><main>${CASES.map(([id, , html]) => `<section>${html}</section>`).join("\n")}` +
  `<p id="later" style="display:none">${W("LATERSHOWN")}</p></main>` +
  `<div id="shadowhost"></div><script>document.getElementById("shadowhost").attachShadow({mode:"open"})` +
  `.innerHTML = "<p>SHADOWP ${"x ".repeat(50)}</p>";</script></body></html>`;

for (const lazyScan of [false, true]) {
  describe(`Textauswahl (lazyScan=${lazyScan})`, () => {
    let backend, ext, page;
    const sent = (tag) => backend.texts.some((t) => t.includes(tag));

    before(async () => {
      backend = await startBackend(() => 0.5);
      // hoher Viewport: alle Fälle liegen im sichtbaren Bereich, Lazy-Scan stellt nichts zurück
      ext = await launchExtension({ pages: { "fixture.test": fixture }, viewport: { width: 900, height: 5000 } });
      await ext.configure({ provider: "local", localUrl: backend.url, sites: ["fixture.test"], lazyScan, scoreRetentionDays: 0 });
      page = await ext.open("http://fixture.test/");
      await page.waitForFunction(() => document.querySelectorAll("[data-aivsai-level]").length >= 8, null, { timeout: 15_000 });
      await sleep(800); // letzte Batches abwarten
    });

    after(async () => {
      await ext?.close();
      await backend?.close();
    });

    for (const [tag, expected, , why] of CASES) {
      it(`${expected ? "sendet" : "sendet nicht"}: ${why}`, () => {
        assert.equal(sent(tag), expected, `${tag} ${expected ? "fehlt" : "wurde gesendet"}`);
      });
    }

    it("sendet keinen Script-/Style-Inhalt und keinen Icon-Text", () => {
      assert.ok(!backend.texts.some((t) => /SECRETJS|SECRETCSS|ICONTEXT|chevron_right|<\w/.test(t)));
    });

    it("sendet unsichtbare Absätze erst, wenn sie sichtbar werden", async () => {
      assert.equal(sent("LATERSHOWN"), false);
      await page.evaluate(() => (document.getElementById("later").style.display = "block"));
      await page.waitForFunction(() => document.getElementById("later").dataset.aivsaiLevel, null, { timeout: 5000 });
      assert.equal(sent("LATERSHOWN"), true);
    });

    it("erreicht Shadow DOM (bekannte Grenze) nicht", () => {
      assert.equal(sent("SHADOWP"), false);
    });

    it("hat keine Konsolenfehler", () => {
      assert.deepEqual(ext.errors, []);
    });
  });
}
