// Spracherkennung pro Absatz (extension/lang-detect.js): Absätze in Sprachen, die das Modell nicht kennt,
// bewertet der Auto-Scan nicht (Fehlalarme, TODO.md Punkt 2).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

await import("../../extension/lang-detect.js");
const { detect, name } = globalThis.AIVSAI_LANG;

const TEXTS = {
  en:
    "Photosynthesis is a biological process used by many cellular organisms to convert light energy into " +
    "chemical energy, which is stored in organic compounds that can later be metabolized through cellular " +
    "respiration to fuel the activities of the organism.",
  de:
    "Die Photosynthese ist ein physiologischer Prozess zur Erzeugung von energiereichen Biomolekülen aus " +
    "energieärmeren Stoffen mithilfe von Lichtenergie. Sie wird von Pflanzen, Algen und einigen Bakterien betrieben.",
  fr:
    "La photosynthèse est le processus bioénergétique qui permet à des organismes de synthétiser de la matière " +
    "organique en utilisant l'énergie lumineuse, de l'eau et du dioxyde de carbone.",
  ru: "Фотосинтез — сложный химический процесс преобразования энергии видимого света в энергию химических связей органических веществ.",
  ja: "光合成とは、主に植物や植物プランクトン、藻類など光合成色素をもつ生物が行う、光エネルギーを化学エネルギーに変換する生化学反応のことである。"
};

describe("AIVSAI_LANG.detect", () => {
  for (const [lang, text] of Object.entries(TEXTS)) {
    it(`erkennt ${lang}`, () => assert.equal(detect(text), lang));
  }

  it("deutscher Fachtext mit vielen englischen Begriffen bleibt Deutsch", () => {
    const text =
      "Die Konfiguration des Kubernetes-Clusters erfolgt über Helm-Charts, wobei das Deployment der Microservices " +
      "mit einem CI/CD-Pipeline-Setup in GitLab automatisiert wird. Für das Monitoring nutzen wir Prometheus und Grafana.";
    assert.equal(detect(text), "de");
  });

  it("englischer Text mit deutschem Zitat bleibt Englisch", () => {
    const text =
      "The chancellor said that the government would not change its position, and quoted the old saying " +
      "„Wer rastet, der rostet“ before the press conference ended in the early afternoon.";
    assert.equal(detect(text), "en");
  });

  it("zu kurz, Code oder Platzhaltertext: keine Aussage", () => {
    assert.equal(detect("Hello world this is short"), "");
    assert.equal(detect("npm install --save-dev playwright && npx playwright install chromium --with-deps"), "");
    assert.equal(detect("lorem ipsum dolor sit amet consectetur adipiscing elit sed do ".repeat(4)), "");
  });
});

describe("AIVSAI_LANG.name", () => {
  it("liefert deutsche Sprachnamen", () => {
    assert.equal(name("de"), "Deutsch");
    assert.equal(name("en"), "Englisch");
  });
});
