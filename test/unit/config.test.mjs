// Reine Entscheidungslogik aus extension/config.js: Ampel, Sperrliste, Scan-Freigabe, Modell-Schlüssel,
// dazu die Beschreibungen der Provider und des Modellkatalogs (models.js).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Kleine Ersatzliste statt der echten (die prüft blocklist.test.mjs) - Format wie generated/blocklist.js
globalThis.AIVSAI_BLOCKLIST = { domains: "\nbank.example\nmail.anbieter.example\n" };
await import("../../extension/models.js");
await import("../../extension/config.js");
const A = globalThis.AIVSAI;
const cfg = (over = {}) => ({ ...A.DEFAULTS, ...A.SECRET_DEFAULTS, ...over });

describe("level", () => {
  it("teilt an den Schwellen: Schwelle selbst gehört zur höheren Stufe", () => {
    const c = { yellowFrom: 0.6, redFrom: 0.9 };
    assert.equal(A.level(0, c), "green");
    assert.equal(A.level(0.599, c), "green");
    assert.equal(A.level(0.6, c), "yellow");
    assert.equal(A.level(0.899, c), "yellow");
    assert.equal(A.level(0.9, c), "red");
    assert.equal(A.level(1, c), "red");
  });

  it("kurzer Text: gelb/rot werden „unsicher“, grün bleibt grün", () => {
    const c = cfg({ yellowFrom: 0.6, redFrom: 0.9 });
    const min = A.reliableWords(c);
    assert.equal(A.level(0.95, c, min - 1), "uncertain");
    assert.equal(A.level(0.7, c, min - 1), "uncertain");
    assert.equal(A.level(0.2, c, min - 1), "green");
    assert.equal(A.level(0.95, c, min), "red");
    assert.equal(A.level(0.95, c), "red"); // ohne Wortzahl wie bisher
  });

  it("desklib: kurzer Text ab shortRedFrom rot, darunter „unsicher“; TMR und unbekannte Modelle nie rot", () => {
    const desklib = cfg({ provider: "browser", browserModel: "desklib", yellowFrom: 0.5, redFrom: 0.87 });
    const short = A.reliableWords(desklib) - 1;
    assert.equal(A.shortRedFrom(desklib), 0.98);
    assert.equal(A.level(0.98, desklib, short), "red");
    assert.equal(A.level(0.979, desklib, short), "uncertain");
    assert.equal(A.level(0.6, desklib, short), "uncertain");
    assert.equal(A.level(0.4, desklib, short), "green");
    assert.equal(A.level(0.9, desklib, short + 1), "red"); // ab reliableWords die normale Schwelle
    // nie lockerer als die eingestellte Rot-Schwelle
    assert.equal(A.shortRedFrom({ ...desklib, redFrom: 0.99 }), 0.99);
    assert.equal(A.level(0.985, { ...desklib, redFrom: 0.99 }, short), "uncertain");

    const tmr = cfg({ provider: "browser", browserModel: "tmr", yellowFrom: 0.95, redFrom: 0.98 });
    assert.equal(A.shortRedFrom(tmr), null);
    assert.equal(A.level(0.999, tmr, 50), "uncertain");
    assert.equal(A.shortRedFrom(cfg({ provider: "custom", customUrl: "https://x.example/v1/score" })), null);
  });

  it("Mindestlänge und Sprachen kommen vom Modell, bei unbekannten Modellen Standard bzw. keine Angabe", () => {
    for (const key of ["tmr", "desklib"]) {
      const c = cfg({ provider: "browser", browserModel: key });
      assert.equal(A.reliableWords(c), A.MODELS[key].reliableWords);
      assert.deepEqual(A.languages(c), ["en"]);
    }
    const custom = cfg({ provider: "custom", customUrl: "https://x.example/v1/score" });
    assert.equal(A.reliableWords(custom), 120);
    assert.equal(A.languages(custom), null);
  });
});

describe("siteMatches", () => {
  it("trifft die Domain selbst und Subdomains, aber keine bloße Namens-Endung", () => {
    assert.ok(A.siteMatches("example.com", ["example.com"]));
    assert.ok(A.siteMatches("a.b.example.com", ["example.com"]));
    assert.ok(!A.siteMatches("notexample.com", ["example.com"]));
    assert.ok(!A.siteMatches("example.com", ["a.example.com"]));
    assert.ok(!A.siteMatches("example.com", []));
  });
});

describe("builtinMatch", () => {
  it("findet Host und Eltern-Domains, liefert die gelistete Domain", () => {
    assert.equal(A.builtinMatch("bank.example"), "bank.example");
    assert.equal(A.builtinMatch("login.online.bank.example"), "bank.example");
    assert.equal(A.builtinMatch("mail.anbieter.example"), "mail.anbieter.example");
  });

  it("sperrt nicht die Eltern-Domain einer gelisteten Subdomain und keine Teilstrings", () => {
    assert.equal(A.builtinMatch("anbieter.example"), null);
    assert.equal(A.builtinMatch("news.anbieter.example"), null);
    assert.equal(A.builtinMatch("mybank.example"), null);
    assert.equal(A.builtinMatch("example"), null);
  });
});

describe("blockReason", () => {
  it("eigene Einträge gehen vor, auch wenn die mitgelieferte Liste aus ist", () => {
    assert.equal(A.blockReason("x.privat.example", cfg({ blockedSites: ["privat.example"] })), "user");
    assert.equal(A.blockReason("bank.example", cfg({ blockedSites: ["bank.example"], builtinBlocklist: false })), "user");
  });

  it("mitgelieferte Liste: an/aus und Ausnahmen (auch für Subdomains)", () => {
    assert.equal(A.blockReason("www.bank.example", cfg()), "builtin");
    assert.equal(A.blockReason("www.bank.example", cfg({ builtinBlocklist: false })), null);
    assert.equal(A.blockReason("www.bank.example", cfg({ unblockedSites: ["bank.example"] })), null);
    // Ausnahme nur für eine Subdomain lässt den Rest gesperrt
    const c = cfg({ unblockedSites: ["blog.bank.example"] });
    assert.equal(A.blockReason("blog.bank.example", c), null);
    assert.equal(A.blockReason("online.bank.example", c), "builtin");
  });

  it("eine Ausnahme hebt keinen eigenen Eintrag auf", () => {
    const c = cfg({ blockedSites: ["bank.example"], unblockedSites: ["bank.example"] });
    assert.equal(A.blockReason("bank.example", c), "user");
  });

  it("kommt mit fehlenden Listen zurecht (alte gespeicherte Einstellungen)", () => {
    assert.equal(A.blockReason("frei.example", { builtinBlocklist: true }), null);
  });
});

describe("scanPolicy", () => {
  it("aus schlägt alles, gesperrt schlägt jeden Scan-Modus", () => {
    assert.equal(A.scanPolicy("bank.example", cfg({ enabled: false })), "off");
    for (const scanMode of ["manual", "sites", "all"]) {
      assert.equal(A.scanPolicy("bank.example", cfg({ scanMode, sites: ["bank.example"] })), "blocked");
    }
  });

  it("Scan-Modi", () => {
    assert.equal(A.scanPolicy("news.example", cfg({ scanMode: "all" })), "auto");
    assert.equal(A.scanPolicy("www.news.example", cfg({ scanMode: "sites", sites: ["news.example"] })), "auto");
    assert.equal(A.scanPolicy("other.example", cfg({ scanMode: "sites", sites: ["news.example"] })), "manual");
    assert.equal(A.scanPolicy("news.example", cfg({ scanMode: "manual", sites: ["news.example"] })), "manual");
    assert.equal(A.scanPolicy("news.example", cfg({ scanMode: "sites", sites: undefined })), "manual");
  });
});

describe("modelKey", () => {
  it("enthält Provider, Modell und bei Browser-Modellen die Version", () => {
    assert.equal(A.modelKey(cfg()), `browser:desklib@${A.MODELS.desklib.browser.version}`); // Standardmodell
    assert.equal(A.modelKey(cfg({ browserModel: "tmr" })), `browser:tmr@${A.MODELS.tmr.browser.version}`);
    assert.equal(A.modelKey(cfg({ browserModel: "desklib" })), `browser:desklib@${A.MODELS.desklib.browser.version}`);
    assert.equal(A.modelKey(cfg({ browserModel: "gibtsnicht" })), "browser:gibtsnicht@?");
    assert.equal(A.modelKey(cfg({ provider: "local", localModel: "desklib" })), "local:desklib");
    assert.equal(A.modelKey(cfg({ provider: "custom", customUrl: "https://s.example/score" })), "custom:https://s.example/score");
    assert.equal(A.modelKey(cfg({ provider: "custom", customUrl: "https://s.example", customModel: "m1" })), "custom:m1");
    assert.equal(A.modelKey(cfg({ provider: "huggingface", hfModel: "org/m" })), "huggingface:org/m");
    assert.equal(A.modelKey(cfg({ provider: "neu" })), "neu:");
  });

  it("PROVIDER_KEYS enthält alle Provider-Einstellungen", () => {
    // Alles, was modelKey nicht abbildet, muss in PROVIDER_KEYS stehen (scoring.js, providerSignature)
    for (const k of ["provider", "browserModel", "localModel", "customUrl", "customModel", "hfModel", "hfAiLabel", "localUrl"]) {
      assert.ok(A.PROVIDER_KEYS.includes(k), k);
    }
  });
});

describe("modelCheck („Modell prüfen“)", () => {
  const custom = cfg({ provider: "custom", customUrl: "https://s.example/v1/score", customModel: "m1" });
  const passed = (c, over = {}) => ({
    sig: A.checkSignature(c),
    at: 1,
    ok: true,
    info: { version: "abc1234", maxChars: 800 },
    thresholds: { yellowFrom: 0.3, redFrom: 0.7 },
    ...over
  });
  const withCheck = (c, check) => ({ ...c, modelChecks: { [c.provider]: check } });

  it("gilt nur, solange Modell/URL dieselben sind und bestanden wurde", () => {
    assert.ok(A.modelCheck(withCheck(custom, passed(custom))));
    assert.equal(A.modelCheck(custom), null);
    assert.equal(A.modelCheck({ ...withCheck(custom, passed(custom)), customModel: "m2" }), null);
    assert.equal(A.modelCheck({ ...withCheck(custom, passed(custom)), customUrl: "https://t.example/v1/score" }), null);
    assert.equal(A.modelCheck(withCheck(custom, passed(custom, { ok: false }))), null);
    // anderer Provider mit derselben Prüfung: nein
    assert.equal(A.modelCheck({ ...withCheck(custom, passed(custom)), provider: "huggingface" }), null);
  });

  it("API-Key/Token gehören nicht zur Signatur", () => {
    assert.equal(A.checkSignature(custom), A.checkSignature({ ...custom, customApiKey: "neu" }));
    const hf = cfg({ provider: "huggingface", hfModel: "org/m" });
    assert.equal(A.checkSignature(hf), A.checkSignature({ ...hf, hfToken: "hf_neu" }));
    assert.notEqual(A.checkSignature(hf), A.checkSignature({ ...hf, hfAiLabel: "AI" }));
  });

  it("Version geht in modelKey ein, Textlänge und Ampel kommen aus der Prüfung", () => {
    const c = withCheck(custom, passed(custom));
    assert.equal(A.modelKey(c), "custom:m1@abc1234");
    assert.equal(A.maxChars(c), 800);
    assert.deepEqual(A.presetFor(c), { yellowFrom: 0.3, redFrom: 0.7 });
    // ohne Version bleibt der Schlüssel wie bisher
    assert.equal(A.modelKey(withCheck(custom, passed(custom, { info: {} }))), "custom:m1");
  });

  it("Ampel für kurze Absätze aus /v1/info, sonst Standard (120 Wörter, nie rot)", () => {
    const c = withCheck(custom, passed(custom, { info: { reliableWords: 60, shortRedFrom: 0.97 } }));
    assert.equal(A.reliableWords(c), 60);
    assert.equal(A.shortRedFrom({ ...c, redFrom: 0.7 }), 0.97);
    assert.equal(A.level(0.975, { ...c, yellowFrom: 0.3, redFrom: 0.7 }, 59), "red");
    assert.equal(A.level(0.9, { ...c, yellowFrom: 0.3, redFrom: 0.7 }, 59), "uncertain");
    assert.equal(A.level(0.9, { ...c, yellowFrom: 0.3, redFrom: 0.7 }, 60), "red");
    const plain = withCheck(custom, passed(custom));
    assert.equal(A.reliableWords(plain), 120);
    assert.equal(A.shortRedFrom(plain), null);
  });

  it("Lokal: Modellfamilie aus models.js geht vor, Version aus der Prüfung", () => {
    const local = cfg({ provider: "local", localModel: "desklib" });
    const c = withCheck(local, passed(local));
    assert.equal(A.modelKey(c), "local:desklib@abc1234");
    assert.equal(A.maxChars(c), 1500);
    assert.equal(A.presetFor(c), A.PRESETS.desklib);
  });

  it("Pflicht für eigene Modelle, freiwillig für den lokalen Server, nicht im Browser", () => {
    assert.equal(A.PROVIDERS.custom.check, "required");
    assert.equal(A.PROVIDERS.huggingface.check, "required");
    assert.equal(A.PROVIDERS.local.check, "optional");
    assert.equal(A.PROVIDERS.browser.check, undefined);
  });
});

describe("maxChars / presetFor / maxInFlight", () => {
  it("Browser und Lokal kennen die Modellfamilie, andere Provider nicht", () => {
    assert.equal(A.maxChars(cfg()), 1500); // Standardmodell desklib
    assert.equal(A.maxChars(cfg({ browserModel: "tmr" })), 2000);
    assert.equal(A.maxChars(cfg({ browserModel: "desklib" })), 1500);
    assert.equal(A.maxChars(cfg({ provider: "local", localModel: "desklib" })), 1500);
    assert.equal(A.maxChars(cfg({ provider: "custom", customModel: "desklib" })), 2000);
    assert.equal(A.maxChars(cfg({ provider: "local", localModel: "unbekannt" })), 2000);

    assert.equal(A.presetFor(cfg({ browserModel: "desklib" })), A.PRESETS.desklib);
    assert.equal(A.presetFor(cfg({ provider: "local", localModel: "tmr" })), A.PRESETS.tmr);
    assert.equal(A.presetFor(cfg({ provider: "huggingface" })), A.PRESETS.generic);
  });

  it("Presets liegen in 0..1 und gelb vor rot", () => {
    for (const [name, p] of Object.entries(A.PRESETS)) {
      assert.ok(0 < p.yellowFrom && p.yellowFrom < p.redFrom && p.redFrom <= 1, name);
    }
  });

  it("nur Remote-Backends dürfen parallel", () => {
    assert.equal(A.maxInFlight(cfg()), 1);
    assert.equal(A.maxInFlight(cfg({ provider: "local" })), 1);
    assert.equal(A.maxInFlight(cfg({ provider: "custom" })), 2);
    assert.equal(A.maxInFlight(cfg({ provider: "huggingface" })), 2);
  });
});

describe("remoteTarget", () => {
  it("null, solange der Text auf dem Rechner bleibt", () => {
    assert.equal(A.remoteTarget(cfg()), null);
    assert.equal(A.remoteTarget(cfg({ provider: "local" })), null);
    assert.equal(A.remoteTarget(cfg({ provider: "local", localUrl: "" })), null);
    assert.equal(A.remoteTarget(cfg({ provider: "local", localUrl: "http://localhost:9000" })), null);
    assert.equal(A.remoteTarget(cfg({ provider: "custom", customUrl: "http://127.0.0.1:1234/x" })), null);
  });

  it("nennt das Ziel, sobald Text den Rechner verlässt", () => {
    assert.equal(A.remoteTarget(cfg({ provider: "custom", customUrl: "https://api.example:8443/score" })), "api.example:8443");
    assert.equal(A.remoteTarget(cfg({ provider: "local", localUrl: "http://192.168.0.5:8787" })), "192.168.0.5:8787");
    assert.equal(A.remoteTarget(cfg({ provider: "huggingface" })), "Hugging Face (router.huggingface.co)");
    assert.equal(A.remoteTarget(cfg({ provider: "custom", customUrl: "kaputt" })), "den eingetragenen Server");
  });
});

describe("providerLabel", () => {
  it("beschreibt jeden Provider", () => {
    assert.equal(A.providerLabel(cfg()), "Im Browser (desklib)");
    assert.equal(A.providerLabel(cfg({ browserModel: "tmr" })), "Im Browser (TMR)");
    assert.equal(A.providerLabel(cfg({ browserModel: "desklib" })), "Im Browser (desklib)");
    assert.equal(A.providerLabel(cfg({ browserModel: "weg" })), "Im Browser (TMR)");
    assert.equal(A.providerLabel(cfg({ provider: "local", localModel: "desklib" })), "Lokal (desklib)");
    assert.equal(A.providerLabel(cfg({ provider: "custom" })), "Eigener Server");
    assert.equal(A.providerLabel(cfg({ provider: "custom", customModel: "m" })), "Eigener Server (m)");
    assert.equal(A.providerLabel(cfg({ provider: "huggingface", hfModel: "org/m" })), "Hugging Face (org/m)");
  });
});

describe("Provider-Registry und Modellkatalog", () => {
  const fields = Object.values(A.PROVIDERS).flatMap((p) => p.fields);

  it("jedes Feld hat einen Default am richtigen Ort (sync bzw. Secret in local)", () => {
    for (const f of fields) {
      assert.ok(f.key && f.label && f.type, JSON.stringify(f));
      const store = f.secret ? A.SECRET_DEFAULTS : A.DEFAULTS;
      assert.ok(f.key in store, f.key);
      assert.equal(store[f.key], f.default, f.key);
      assert.ok(!(f.key in (f.secret ? A.DEFAULTS : A.SECRET_DEFAULTS)), `${f.key} doppelt`);
      // Secrets dürfen nie Teil der Signatur (und damit von Scores/Feedback) werden
      assert.equal(A.PROVIDER_KEYS.includes(f.key), !f.secret, f.key);
    }
    assert.equal(new Set(fields.map((f) => f.key)).size, fields.length, "Feld-Schlüssel doppelt");
    assert.ok(A.DEFAULTS.provider in A.PROVIDERS);
  });

  it("Standard ist desklib im Browser, mit dessen Ampel-Startwerten", () => {
    assert.equal(A.DEFAULTS.provider, "browser");
    assert.equal(A.DEFAULTS.browserModel, "desklib");
    assert.equal(A.presetFor(A.DEFAULTS), A.PRESETS.desklib);
    assert.equal(A.DEFAULTS.yellowFrom, A.PRESETS.desklib.yellowFrom);
    assert.equal(A.DEFAULTS.redFrom, A.PRESETS.desklib.redFrom);
  });

  it("Modell-Felder zeigen auf vorhandene Katalog-Abschnitte mit gültigem Default", () => {
    for (const f of fields.filter((x) => x.type === "model")) {
      const keys = A.catalog(f.catalog).map(([k]) => k);
      assert.ok(keys.length > 0, f.catalog);
      assert.ok(keys.includes(f.default), `${f.key}: ${f.default}`);
    }
  });

  it("Katalog: Pflichtangaben, Presets und gepinnte Browser-Modelle", () => {
    for (const [key, m] of Object.entries(A.MODELS)) {
      assert.ok(m.name && m.title && m.maxChars > 0 && m.maxTokens > 0, key);
      assert.equal(A.PRESETS[key], m.thresholds, key);
      if (m.browser) {
        assert.match(m.browser.revision, /^[0-9a-f]{40}$/, key);
        for (const k of ["repo", "version", "marker", "download", "info"]) assert.ok(m.browser[k], `${key}.browser.${k}`);
      }
      assert.ok(m.browser || m.server, `${key}: kein Provider bietet das Modell an`);
    }
  });
});
