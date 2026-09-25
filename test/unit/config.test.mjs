// Reine Entscheidungslogik aus extension/config.js: Ampel, Sperrliste, Scan-Freigabe, Modell-Schlüssel.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Kleine Ersatzliste statt der echten (die prüft blocklist.test.mjs) - Format wie generated/blocklist.js
globalThis.AIVSAI_BLOCKLIST = { domains: "\nbank.example\nmail.anbieter.example\n" };
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
    assert.equal(A.modelKey(cfg()), `browser:tmr@${A.BROWSER_MODELS.tmr.version}`);
    assert.equal(A.modelKey(cfg({ browserModel: "desklib" })), `browser:desklib@${A.BROWSER_MODELS.desklib.version}`);
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

describe("maxChars / presetFor / maxInFlight", () => {
  it("Browser und Lokal kennen die Modellfamilie, andere Provider nicht", () => {
    assert.equal(A.maxChars(cfg()), 2000);
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
    assert.equal(A.providerLabel(cfg()), "Im Browser (TMR)");
    assert.equal(A.providerLabel(cfg({ browserModel: "desklib" })), "Im Browser (desklib)");
    assert.equal(A.providerLabel(cfg({ browserModel: "weg" })), "Im Browser (TMR)");
    assert.equal(A.providerLabel(cfg({ provider: "local", localModel: "desklib" })), "Lokal (desklib)");
    assert.equal(A.providerLabel(cfg({ provider: "custom" })), "Eigener Server");
    assert.equal(A.providerLabel(cfg({ provider: "custom", customModel: "m" })), "Eigener Server (m)");
    assert.equal(A.providerLabel(cfg({ provider: "huggingface", hfModel: "org/m" })), "Hugging Face (org/m)");
  });
});
