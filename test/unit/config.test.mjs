// Pure decision logic from extension/config.js: traffic light, blocklist, scan permission, model key,
// plus the descriptions of the providers and the model catalog (models.js).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Small stand-in list instead of the real one (blocklist.test.mjs checks that) - format like generated/blocklist.js
globalThis.AIVSAI_BLOCKLIST = { domains: "\nbank.example\nmail.provider.example\n" };
await import("../../extension/models.js");
await import("../../extension/config.js");
const A = globalThis.AIVSAI;
const cfg = (over = {}) => ({ ...A.DEFAULTS, ...A.SECRET_DEFAULTS, ...over });

describe("level", () => {
  it("splits at the thresholds: the threshold itself belongs to the higher level", () => {
    const c = { yellowFrom: 0.6, redFrom: 0.9 };
    assert.equal(A.level(0, c), "green");
    assert.equal(A.level(0.599, c), "green");
    assert.equal(A.level(0.6, c), "yellow");
    assert.equal(A.level(0.899, c), "yellow");
    assert.equal(A.level(0.9, c), "red");
    assert.equal(A.level(1, c), "red");
  });

  it("short text: yellow/red become “uncertain”, green stays green", () => {
    const c = cfg({ yellowFrom: 0.6, redFrom: 0.9 });
    const min = A.reliableWords(c);
    assert.equal(A.level(0.95, c, min - 1), "uncertain");
    assert.equal(A.level(0.7, c, min - 1), "uncertain");
    assert.equal(A.level(0.2, c, min - 1), "green");
    assert.equal(A.level(0.95, c, min), "red");
    assert.equal(A.level(0.95, c), "red"); // without word count as before
  });

  it("desklib: short text red from shortRedFrom, “uncertain” below it; TMR and unknown models never red", () => {
    const desklib = cfg({ provider: "browser", browserModel: "desklib", yellowFrom: 0.5, redFrom: 0.87 });
    const short = A.reliableWords(desklib) - 1;
    assert.equal(A.shortRedFrom(desklib), 0.98);
    assert.equal(A.level(0.98, desklib, short), "red");
    assert.equal(A.level(0.979, desklib, short), "uncertain");
    assert.equal(A.level(0.6, desklib, short), "uncertain");
    assert.equal(A.level(0.4, desklib, short), "green");
    assert.equal(A.level(0.9, desklib, short + 1), "red"); // from reliableWords the normal threshold
    // never looser than the configured red threshold
    assert.equal(A.shortRedFrom({ ...desklib, redFrom: 0.99 }), 0.99);
    assert.equal(A.level(0.985, { ...desklib, redFrom: 0.99 }, short), "uncertain");

    const tmr = cfg({ provider: "browser", browserModel: "tmr", yellowFrom: 0.95, redFrom: 0.98 });
    assert.equal(A.shortRedFrom(tmr), null);
    assert.equal(A.level(0.999, tmr, 50), "uncertain");
    assert.equal(A.shortRedFrom(cfg({ provider: "custom", customUrl: "https://x.example/v1/score" })), null);
  });

  it("fakespot: own shortRedFrom threshold like desklib, clearly stricter than redFrom", () => {
    const fakespot = cfg({ provider: "browser", browserModel: "fakespot", yellowFrom: 0.95, redFrom: 0.999 });
    const short = A.reliableWords(fakespot) - 1;
    assert.equal(A.shortRedFrom(fakespot), 0.9994);
    assert.equal(A.level(0.9994, fakespot, short), "red");
    assert.equal(A.level(0.999, fakespot, short), "uncertain"); // >= redFrom, but below shortRedFrom
    assert.equal(A.level(0.96, fakespot, short), "uncertain"); // >= yellowFrom, but below shortRedFrom
    assert.equal(A.level(0.9, fakespot, short), "green"); // below yellowFrom stays green, even when short
    assert.equal(A.level(0.999, fakespot, short + 1), "red"); // from reliableWords the normal threshold
  });

  it("minimum length and languages come from the model, for unknown models default or no value", () => {
    for (const key of ["tmr", "desklib", "fakespot"]) {
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
  it("matches the domain itself and subdomains, but not a mere name suffix", () => {
    assert.ok(A.siteMatches("example.com", ["example.com"]));
    assert.ok(A.siteMatches("a.b.example.com", ["example.com"]));
    assert.ok(!A.siteMatches("notexample.com", ["example.com"]));
    assert.ok(!A.siteMatches("example.com", ["a.example.com"]));
    assert.ok(!A.siteMatches("example.com", []));
  });
});

describe("builtinMatch", () => {
  it("finds host and parent domains, returns the listed domain", () => {
    assert.equal(A.builtinMatch("bank.example"), "bank.example");
    assert.equal(A.builtinMatch("login.online.bank.example"), "bank.example");
    assert.equal(A.builtinMatch("mail.provider.example"), "mail.provider.example");
  });

  it("does not block the parent domain of a listed subdomain and no substrings", () => {
    assert.equal(A.builtinMatch("provider.example"), null);
    assert.equal(A.builtinMatch("news.provider.example"), null);
    assert.equal(A.builtinMatch("mybank.example"), null);
    assert.equal(A.builtinMatch("example"), null);
  });
});

describe("blockReason", () => {
  it("own entries take precedence, even if the bundled list is off", () => {
    assert.equal(A.blockReason("x.private.example", cfg({ blockedSites: ["private.example"] })), "user");
    assert.equal(A.blockReason("bank.example", cfg({ blockedSites: ["bank.example"], builtinBlocklist: false })), "user");
  });

  it("bundled list: on/off and exceptions (also for subdomains)", () => {
    assert.equal(A.blockReason("www.bank.example", cfg()), "builtin");
    assert.equal(A.blockReason("www.bank.example", cfg({ builtinBlocklist: false })), null);
    assert.equal(A.blockReason("www.bank.example", cfg({ unblockedSites: ["bank.example"] })), null);
    // an exception for only one subdomain leaves the rest blocked
    const c = cfg({ unblockedSites: ["blog.bank.example"] });
    assert.equal(A.blockReason("blog.bank.example", c), null);
    assert.equal(A.blockReason("online.bank.example", c), "builtin");
  });

  it("an exception does not override an own entry", () => {
    const c = cfg({ blockedSites: ["bank.example"], unblockedSites: ["bank.example"] });
    assert.equal(A.blockReason("bank.example", c), "user");
  });

  it("copes with missing lists (old stored settings)", () => {
    assert.equal(A.blockReason("free.example", { builtinBlocklist: true }), null);
  });
});

describe("scanPolicy", () => {
  it("off beats everything, blocked beats every scan mode", () => {
    assert.equal(A.scanPolicy("bank.example", cfg({ enabled: false })), "off");
    for (const scanMode of ["manual", "sites", "all"]) {
      assert.equal(A.scanPolicy("bank.example", cfg({ scanMode, sites: ["bank.example"] })), "blocked");
    }
  });

  it("scan modes", () => {
    assert.equal(A.scanPolicy("news.example", cfg({ scanMode: "all" })), "auto");
    assert.equal(A.scanPolicy("www.news.example", cfg({ scanMode: "sites", sites: ["news.example"] })), "auto");
    assert.equal(A.scanPolicy("other.example", cfg({ scanMode: "sites", sites: ["news.example"] })), "manual");
    assert.equal(A.scanPolicy("news.example", cfg({ scanMode: "manual", sites: ["news.example"] })), "manual");
    assert.equal(A.scanPolicy("news.example", cfg({ scanMode: "sites", sites: undefined })), "manual");
  });
});

describe("modelKey", () => {
  it("contains provider, model and, for browser models, the version", () => {
    assert.equal(A.modelKey(cfg()), `browser:desklib@${A.MODELS.desklib.browser.version}`); // default model
    assert.equal(A.modelKey(cfg({ browserModel: "tmr" })), `browser:tmr@${A.MODELS.tmr.browser.version}`);
    assert.equal(A.modelKey(cfg({ browserModel: "desklib" })), `browser:desklib@${A.MODELS.desklib.browser.version}`);
    assert.equal(A.modelKey(cfg({ browserModel: "doesnotexist" })), "browser:doesnotexist@?");
    assert.equal(A.modelKey(cfg({ provider: "local", localModel: "desklib" })), "local:desklib");
    assert.equal(A.modelKey(cfg({ provider: "custom", customUrl: "https://s.example/score" })), "custom:https://s.example/score");
    assert.equal(A.modelKey(cfg({ provider: "custom", customUrl: "https://s.example", customModel: "m1" })), "custom:m1");
    assert.equal(A.modelKey(cfg({ provider: "huggingface", hfModel: "org/m" })), "huggingface:org/m");
    assert.equal(A.modelKey(cfg({ provider: "new" })), "new:");
  });

  it("PROVIDER_KEYS contains all provider settings", () => {
    // Everything modelKey does not represent must be in PROVIDER_KEYS (scoring.js, providerSignature)
    for (const k of ["provider", "browserModel", "localModel", "customUrl", "customModel", "hfModel", "hfAiLabel", "localUrl"]) {
      assert.ok(A.PROVIDER_KEYS.includes(k), k);
    }
  });
});

describe("reportUrl", () => {
  const info = { version: "0.5.1", browser: "TestBrowser/1.0" };
  const url = new URL(A.reportUrl(cfg(), info));
  const body = url.searchParams.get("body");

  it("points to the new-issue form of the repository with a prefilled title", () => {
    assert.equal(url.origin + url.pathname, "https://github.com/OJPOJ/ai-check-extension/issues/new");
    assert.ok(url.searchParams.get("title"));
  });

  it("contains version, browser and model key, and survives URL encoding", () => {
    assert.ok(body.includes("Version: 0.5.1"));
    assert.ok(body.includes("Browser: TestBrowser/1.0"));
    assert.ok(body.includes(`Model: ${A.modelKey(cfg())}`));
    assert.ok(body.includes("\n"));
  });

  it("contains nothing but those details (no page address, no text)", () => {
    assert.ok(!/https?:\/\//.test(body));
  });

  it("never leaks the endpoint URL of a custom server", () => {
    const secret = "https://intern.example/v1/score?token=abc";
    for (const customModel of ["", "m1"]) {
      const b = new URL(A.reportUrl(cfg({ provider: "custom", customUrl: secret, customModel }), info)).searchParams.get("body");
      assert.ok(!b.includes("intern.example") && !b.includes("token=abc"));
      assert.ok(b.includes(`Model: custom:${customModel || "(unnamed)"}`));
    }
  });

  it("limits the browser string and tolerates missing info", () => {
    const long = new URL(A.reportUrl(cfg(), { version: "1", browser: "x".repeat(5000) })).searchParams.get("body");
    assert.ok(long.length < 600);
    const none = new URL(A.reportUrl(cfg())).searchParams.get("body");
    assert.ok(none.includes("Version: unknown") && none.includes("Browser: unknown"));
  });
});

describe("modelCheck (\"Check model\")", () => {
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

  it("only applies as long as model/URL are the same and the check passed", () => {
    assert.ok(A.modelCheck(withCheck(custom, passed(custom))));
    assert.equal(A.modelCheck(custom), null);
    assert.equal(A.modelCheck({ ...withCheck(custom, passed(custom)), customModel: "m2" }), null);
    assert.equal(A.modelCheck({ ...withCheck(custom, passed(custom)), customUrl: "https://t.example/v1/score" }), null);
    assert.equal(A.modelCheck(withCheck(custom, passed(custom, { ok: false }))), null);
    // different provider with the same check: no
    assert.equal(A.modelCheck({ ...withCheck(custom, passed(custom)), provider: "huggingface" }), null);
  });

  it("API key/token are not part of the signature", () => {
    assert.equal(A.checkSignature(custom), A.checkSignature({ ...custom, customApiKey: "new" }));
    const hf = cfg({ provider: "huggingface", hfModel: "org/m" });
    assert.equal(A.checkSignature(hf), A.checkSignature({ ...hf, hfToken: "hf_new" }));
    assert.notEqual(A.checkSignature(hf), A.checkSignature({ ...hf, hfAiLabel: "AI" }));
  });

  it("version goes into modelKey, text length and traffic light come from the check", () => {
    const c = withCheck(custom, passed(custom));
    assert.equal(A.modelKey(c), "custom:m1@abc1234");
    assert.equal(A.maxChars(c), 800);
    assert.deepEqual(A.presetFor(c), { yellowFrom: 0.3, redFrom: 0.7 });
    // without a version the key stays as before
    assert.equal(A.modelKey(withCheck(custom, passed(custom, { info: {} }))), "custom:m1");
  });

  it("traffic light for short paragraphs from /v1/info, otherwise default (120 words, never red)", () => {
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

  it("Local: model family from models.js takes precedence, version from the check", () => {
    const local = cfg({ provider: "local", localModel: "desklib" });
    const c = withCheck(local, passed(local));
    assert.equal(A.modelKey(c), "local:desklib@abc1234");
    assert.equal(A.maxChars(c), 1500);
    assert.equal(A.presetFor(c), A.PRESETS.desklib);
  });

  it("required for custom models, optional for the local server, not in the browser", () => {
    assert.equal(A.PROVIDERS.custom.check, "required");
    assert.equal(A.PROVIDERS.huggingface.check, "required");
    assert.equal(A.PROVIDERS.local.check, "optional");
    assert.equal(A.PROVIDERS.browser.check, undefined);
  });
});

describe("maxChars / presetFor / maxInFlight", () => {
  it("Browser and Local know the model family, other providers do not", () => {
    assert.equal(A.maxChars(cfg()), 1500); // default model desklib
    assert.equal(A.maxChars(cfg({ browserModel: "tmr" })), 2000);
    assert.equal(A.maxChars(cfg({ browserModel: "desklib" })), 1500);
    assert.equal(A.maxChars(cfg({ browserModel: "fakespot" })), 2000);
    assert.equal(A.maxChars(cfg({ provider: "local", localModel: "desklib" })), 1500);
    assert.equal(A.maxChars(cfg({ provider: "custom", customModel: "desklib" })), 2000);
    assert.equal(A.maxChars(cfg({ provider: "local", localModel: "unknown" })), 2000);

    assert.equal(A.presetFor(cfg({ browserModel: "desklib" })), A.PRESETS.desklib);
    assert.equal(A.presetFor(cfg({ browserModel: "fakespot" })), A.PRESETS.fakespot);
    assert.equal(A.presetFor(cfg({ provider: "local", localModel: "tmr" })), A.PRESETS.tmr);
    assert.equal(A.presetFor(cfg({ provider: "huggingface" })), A.PRESETS.generic);
  });

  it("presets lie in 0..1 and yellow before red", () => {
    for (const [name, p] of Object.entries(A.PRESETS)) {
      assert.ok(0 < p.yellowFrom && p.yellowFrom < p.redFrom && p.redFrom <= 1, name);
    }
  });

  it("only remote backends may run in parallel", () => {
    assert.equal(A.maxInFlight(cfg()), 1);
    assert.equal(A.maxInFlight(cfg({ provider: "local" })), 1);
    assert.equal(A.maxInFlight(cfg({ provider: "custom" })), 2);
    assert.equal(A.maxInFlight(cfg({ provider: "huggingface" })), 2);
  });
});

describe("remoteTarget", () => {
  it("null as long as the text stays on the computer", () => {
    assert.equal(A.remoteTarget(cfg()), null);
    assert.equal(A.remoteTarget(cfg({ provider: "local" })), null);
    assert.equal(A.remoteTarget(cfg({ provider: "local", localUrl: "" })), null);
    assert.equal(A.remoteTarget(cfg({ provider: "local", localUrl: "http://localhost:9000" })), null);
    assert.equal(A.remoteTarget(cfg({ provider: "custom", customUrl: "http://127.0.0.1:1234/x" })), null);
  });

  it("names the destination as soon as text leaves the computer", () => {
    assert.equal(A.remoteTarget(cfg({ provider: "custom", customUrl: "https://api.example:8443/score" })), "api.example:8443");
    assert.equal(A.remoteTarget(cfg({ provider: "local", localUrl: "http://192.168.0.5:8787" })), "192.168.0.5:8787");
    assert.equal(A.remoteTarget(cfg({ provider: "huggingface" })), "Hugging Face (router.huggingface.co)");
    assert.equal(A.remoteTarget(cfg({ provider: "custom", customUrl: "broken" })), "the entered server");
  });
});

describe("providerLabel", () => {
  it("describes every provider", () => {
    assert.equal(A.providerLabel(cfg()), "In the browser (desklib)");
    assert.equal(A.providerLabel(cfg({ browserModel: "tmr" })), "In the browser (TMR)");
    assert.equal(A.providerLabel(cfg({ browserModel: "desklib" })), "In the browser (desklib)");
    assert.equal(A.providerLabel(cfg({ browserModel: "gone" })), "In the browser (TMR)");
    assert.equal(A.providerLabel(cfg({ provider: "local", localModel: "desklib" })), "Local (desklib)");
    assert.equal(A.providerLabel(cfg({ provider: "custom" })), "Custom server");
    assert.equal(A.providerLabel(cfg({ provider: "custom", customModel: "m" })), "Custom server (m)");
    assert.equal(A.providerLabel(cfg({ provider: "huggingface", hfModel: "org/m" })), "Hugging Face (org/m)");
  });
});

describe("provider registry and model catalog", () => {
  const fields = Object.values(A.PROVIDERS).flatMap((p) => p.fields);

  it("every field has a default in the right place (sync or secret in local)", () => {
    for (const f of fields) {
      assert.ok(f.key && f.label && f.type, JSON.stringify(f));
      const store = f.secret ? A.SECRET_DEFAULTS : A.DEFAULTS;
      assert.ok(f.key in store, f.key);
      assert.equal(store[f.key], f.default, f.key);
      assert.ok(!(f.key in (f.secret ? A.DEFAULTS : A.SECRET_DEFAULTS)), `${f.key} duplicated`);
      // Secrets must never become part of the signature (and thus of scores/feedback)
      assert.equal(A.PROVIDER_KEYS.includes(f.key), !f.secret, f.key);
    }
    assert.equal(new Set(fields.map((f) => f.key)).size, fields.length, "field key duplicated");
    assert.ok(A.DEFAULTS.provider in A.PROVIDERS);
  });

  it("default is desklib in the browser, with its traffic light starting values", () => {
    assert.equal(A.DEFAULTS.provider, "browser");
    assert.equal(A.DEFAULTS.browserModel, "desklib");
    assert.equal(A.presetFor(A.DEFAULTS), A.PRESETS.desklib);
    assert.equal(A.DEFAULTS.yellowFrom, A.PRESETS.desklib.yellowFrom);
    assert.equal(A.DEFAULTS.redFrom, A.PRESETS.desklib.redFrom);
  });

  it("model fields point to existing catalog sections with a valid default", () => {
    for (const f of fields.filter((x) => x.type === "model")) {
      const keys = A.catalog(f.catalog).map(([k]) => k);
      assert.ok(keys.length > 0, f.catalog);
      assert.ok(keys.includes(f.default), `${f.key}: ${f.default}`);
    }
  });

  it("catalog: required fields, presets and pinned browser models", () => {
    for (const [key, m] of Object.entries(A.MODELS)) {
      assert.ok(m.name && m.title && m.maxChars > 0 && m.maxTokens > 0, key);
      assert.equal(A.PRESETS[key], m.thresholds, key);
      if (m.browser) {
        assert.match(m.browser.revision, /^[0-9a-f]{40}$/, key);
        for (const k of ["repo", "version", "marker", "download", "info"]) assert.ok(m.browser[k], `${key}.browser.${k}`);
      }
      assert.ok(m.browser || m.server, `${key}: no provider offers the model`);
    }
  });
});
