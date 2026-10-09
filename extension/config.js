// Shared defaults/helpers for background.js, content.js, popup.js and options.js.
// Usable as a classic script (content_scripts/<script>) and via `import "./config.js"` in the service worker
// - hence a property of globalThis instead of a module export. Needs models.js before it.
globalThis.AIVSAI = (() => {
  // Model catalog from models.js
  const MODELS = globalThis.AIVSAI_MODELS;
  // Default model "In the browser": on the broad eval suite desklib has ~1% false alarms instead of ~5% for TMR
  // (training/EVAL_RESULTS.md, "Broader eval suite"). Up to v0.5 it was TMR - background.js, pinLegacyModel.
  const DEFAULT_MODEL = "desklib";
  if (!MODELS) throw new Error("models.js must be loaded before config.js");

  const LOCAL_URL = "http://127.0.0.1:8787";

  // Provider = where and how scoring happens. Each one describes itself here; the settings page builds the
  // selection and the form from it, the rest (cache key, privacy note, parallelism) is derived. The actual
  // request lives under the same key in bg/providers.js.
  //
  //   name           short, for popup, tooltip and popover ("In the browser (TMR)")
  //   title, description  selection card in the settings
  //   fields         own settings. key = key in storage (secret: storage.local, is not synced).
  //                  type: "model" (selection from models.js, section `catalog`), "url", "text",
  //                  "password". required: must not be empty. note/hint/placeholder: texts.
  //   family(cfg)    key in models.js if the model is known -> text length and traffic light presets
  //   model(cfg)     stable identifier of the model incl. version (part of modelKey)
  //   detail(cfg)    addition to the name, e.g. the model
  //   endpoint(cfg)  URL the texts are sent to (null = stay in the extension) -> host permission
  //   origins        further host permissions (e.g. for model metadata)
  //   remote         fixed text for the privacy note instead of the host from endpoint()
  //   serial         only one process computes anyway -> no parallel batches
  //   check          "Check model" (bg/model-check.js): "required" = mandatory before saving, "optional".
  //                  The result provides version (-> modelKey), text length and traffic light starting values, see modelCheck()
  const PROVIDERS = {
    browser: {
      name: "In the browser",
      title: "In the browser (recommended)",
      description: "The model runs directly in the extension – no server needed, texts do not leave the computer.",
      fields: [{ key: "browserModel", type: "model", catalog: "browser", label: "Model", default: DEFAULT_MODEL }],
      family: (cfg) => cfg.browserModel,
      model: (cfg) => `${cfg.browserModel}@${MODELS[cfg.browserModel]?.browser?.version ?? "?"}`,
      detail: (cfg) => (MODELS[cfg.browserModel] || MODELS.tmr).name,
      endpoint: () => null,
      serial: true
    },
    local: {
      name: "Local",
      title: "Local server",
      description: "shim_server.py on this computer – texts do not leave the computer.",
      fields: [
        { key: "localUrl", type: "url", label: "Server URL", default: LOCAL_URL, placeholder: LOCAL_URL },
        { key: "localModel", type: "model", catalog: "server", label: "Model", default: "tmr" }
      ],
      family: (cfg) => cfg.localModel,
      model: (cfg) => cfg.localModel,
      detail: (cfg) => cfg.localModel,
      endpoint: (cfg) => cfg.localUrl || LOCAL_URL,
      serial: true,
      check: "optional"
    },
    custom: {
      name: "Custom server",
      title: "Custom server / cloud",
      description: "Any HTTP endpoint with a simple JSON contract, e.g. shim_server.py in the cloud.",
      fields: [
        {
          key: "customUrl", type: "url", label: "Endpoint URL", default: "", required: true,
          placeholder: "https://detector.example.com/v1/score"
        },
        { key: "customApiKey", type: "password", label: "API key", note: "optional, as bearer token", default: "", secret: true },
        { key: "customModel", type: "text", label: "Model", note: "optional, is sent along as \"model\"", default: "", placeholder: "tmr" }
      ],
      family: () => null, // unknown what the server computes
      model: (cfg) => cfg.customModel || cfg.customUrl,
      detail: (cfg) => cfg.customModel,
      endpoint: (cfg) => cfg.customUrl,
      check: "required"
    },
    huggingface: {
      name: "Hugging Face",
      title: "Hugging Face Inference API",
      description: "Text classification model from the Hugging Face Hub, hosted by Hugging Face.",
      fields: [
        {
          key: "hfModel", type: "text", label: "Model ID", default: "openai-community/roberta-base-openai-detector",
          required: true, placeholder: "openai-community/roberta-base-openai-detector",
          hint: "Must be available as text classification via \"HF Inference\" (model page → Deploy → Inference Providers)."
        },
        {
          key: "hfToken", type: "password", label: "Access token", default: "", secret: true, placeholder: "hf_…",
          hint: "Is only stored locally in this browser, not synced."
        },
        { key: "hfAiLabel", type: "text", label: "Label of the AI class", note: "optional", default: "", placeholder: "automatic (AI, Fake, LABEL_1, …)" }
      ],
      family: () => null,
      model: (cfg) => cfg.hfModel,
      detail: (cfg) => cfg.hfModel,
      endpoint: () => "https://router.huggingface.co/",
      origins: ["https://huggingface.co/*"], // model info and config.json from the Hub
      remote: "Hugging Face (router.huggingface.co)",
      check: "required"
    }
  };

  const providerFields = (secret) => Object.values(PROVIDERS).flatMap((p) => p.fields.filter((f) => !!f.secret === secret));
  const defaultsOf = (fields) => Object.fromEntries(fields.map((f) => [f.key, f.default]));

  const DEFAULTS = {
    enabled: true,
    // "manual" = only via popup button, "sites" = only sites from `sites`, "all" = every site
    scanMode: "sites",
    sites: [],
    // Blocklist: never scan automatically here, not even via "Scan page now" (banking, mail, ...).
    // Manually checking individual passages remains allowed - it is always a deliberate single action.
    // Shipped: generated/blocklist.js (scripts/build-blocklist.mjs), plus own entries and exceptions.
    builtinBlocklist: true,
    blockedSites: [], // own entries, always apply
    unblockedSites: [], // exceptions from the bundled list
    // Treat sites with a visible password or payment field as blocked (catches what no list knows)
    sensitiveHeuristic: true,
    // only score paragraphs near the visible area, the rest only on scrolling (saves cloud costs)
    lazyScan: true,
    // Score adjacent short paragraphs (below reliableWords) in the same container together as one text
    // (content.js, groupCandidates) - lowers false alarms on paragraphs that would be too short on their own
    // for a reliable verdict (TODO.md item 2, training/EVAL_RESULTS.md "Text length").
    groupShortParagraphs: true,

    // Key from PROVIDERS, plus their fields (browserModel, localUrl, ...) with their defaults
    provider: "browser",
    ...defaultsOf(providerFields(false)),

    // Traffic light: score < yellowFrom = green, < redFrom = yellow, else red (starting values of the default model)
    ...MODELS[DEFAULT_MODEL].thresholds,
    showGreen: true,
    showBadge: true,

    // Keep scores for this many days (only hash + score, no text, no URL); 0 = not at all
    scoreRetentionDays: 30,

    // Feedback buttons in the result popover (only stored after consent, see bg/feedback-store.js)
    feedbackButtons: true,

    // Last result of "Check model" per provider (bg/model-check.js, stored by options.js):
    // { sig, at, ok, info: {name?, version?, maxChars?, languages?, reliableWords?, shortRedFrom?, aiLabel?},
    //   thresholds, auroc, msPerText }
    modelChecks: {}
  };

  // Secrets live in storage.local so they are not synced via the browser account
  const SECRET_DEFAULTS = defaultsOf(providerFields(true));

  // Changes to these keys invalidate previous scores -> rescan
  const PROVIDER_KEYS = ["provider", ...providerFields(false).map((f) => f.key)];

  // Traffic light starting values per model family (thresholds in models.js), "generic" for unknown models
  const PRESETS = {
    ...Object.fromEntries(Object.entries(MODELS).map(([key, m]) => [key, m.thresholds])),
    generic: { yellowFrom: 0.6, redFrom: 0.9 }
  };

  // Models offered by a section of models.js ("browser", "server"): [[key, model], ...]
  const catalog = (section) => Object.entries(MODELS).filter(([, m]) => m[section]);

  // Deliberately no probability ("probably AI"): the scores are not calibrated
  // (TODO.md, item 5), and a detector provides hints, not proof.
  const LEVEL_TEXT = {
    red: "Flagged – resembles AI text",
    yellow: "Unclear",
    green: "Not flagged",
    uncertain: "Too short to tell"
  };

  // Below this many words no yellow/red if the model does not specify its own - TMR and desklib both need
  // ~120 words for few false alarms (training/EVAL_RESULTS.md, "False alarms on Wikipedia")
  const RELIABLE_WORDS = 120;

  // From how many words on the traffic light trusts a high score (models.js, reliableWords)
  // Custom models: the server's value (/v1/info), otherwise the default
  function reliableWords(cfg) {
    return family(cfg)?.reliableWords ?? modelCheck(cfg)?.info?.reliableWords ?? RELIABLE_WORDS;
  }

  // Red threshold for texts below reliableWords, null = short texts never turn red (models.js, shortRedFrom).
  // Never looser than the configured red threshold.
  function shortRedFrom(cfg) {
    const short = family(cfg)?.shortRedFrom ?? modelCheck(cfg)?.info?.shortRedFrom;
    return short === undefined ? null : Math.max(short, cfg.redFrom);
  }

  // words (optional): length of the scored text. Short texts with a high score become "uncertain" instead of
  // yellow/red - the worst harm is red on a human text, and the model separates short texts
  // much worse (training/EVAL_RESULTS.md, "False alarms on Wikipedia"). Exception: models that
  // with a stricter threshold are as rarely wrong on short texts as on long ones (shortRedFrom).
  // Green stays green.
  function level(p, cfg, words) {
    const base = p >= cfg.redFrom ? "red" : p >= cfg.yellowFrom ? "yellow" : "green";
    if (base === "green" || words === undefined || words >= reliableWords(cfg)) return base;
    const short = shortRedFrom(cfg);
    return short !== null && p >= short ? "red" : "uncertain";
  }

  function siteMatches(host, sites) {
    return sites.some((s) => host === s || host.endsWith(`.${s}`));
  }

  // Bundled list as a "\nd1\nd2\n...\n" string: search by host and all parent domains,
  // without building a set with 10,000 entries in every tab. Result remembered per host.
  const builtinCache = new Map();
  function builtinMatch(host) {
    if (!builtinCache.has(host)) {
      const list = globalThis.AIVSAI_BLOCKLIST?.domains || "";
      let match = null;
      for (let d = host; d.includes(".") && !match; d = d.slice(d.indexOf(".") + 1)) {
        if (list.includes(`\n${d}\n`)) match = d;
      }
      builtinCache.set(host, match);
    }
    return builtinCache.get(host);
  }

  // Why a site is blocked: "user" (own entry), "builtin" (bundled list) or null
  function blockReason(host, cfg) {
    if (siteMatches(host, cfg.blockedSites || [])) return "user";
    if (cfg.builtinBlocklist && builtinMatch(host) && !siteMatches(host, cfg.unblockedSites || [])) return "builtin";
    return null;
  }

  // The only place that decides whether a site may be scanned:
  //   "off"     = not at all (extension off)
  //   "blocked" = blocklist: no scan of the site, only single checks via selection/right-click
  //   "manual"  = only on explicit request (popup button, keyboard shortcut, right-click)
  //   "auto"    = automatically on load
  function scanPolicy(host, cfg) {
    if (!cfg.enabled) return "off";
    if (blockReason(host, cfg)) return "blocked";
    if (cfg.scanMode === "all") return "auto";
    if (cfg.scanMode === "sites" && siteMatches(host, cfg.sites || [])) return "auto";
    return "manual";
  }

  const providerDef = (cfg) => PROVIDERS[cfg.provider];
  const family = (cfg) => MODELS[providerDef(cfg)?.family(cfg)] ?? null;

  // Which model a check concerns: the provider's non-secret fields. Token/API key are not part
  // of it - a new key does not change the model.
  function checkSignature(cfg) {
    const def = providerDef(cfg);
    if (!def) return "";
    return JSON.stringify([cfg.provider, ...def.fields.filter((f) => !f.secret).map((f) => cfg[f.key] ?? "")]);
  }

  // Passed check ("Check model") for the current settings, otherwise null (never checked,
  // failed or a different model/URL entered since)
  function modelCheck(cfg) {
    const check = cfg.modelChecks?.[cfg.provider];
    return check?.ok && check.sig === checkSignature(cfg) ? check : null;
  }

  // Stable identifier of the currently selected model incl. version, e.g. "browser:tmr@b9aa251-q8" - for cache,
  // and later calibration, feedback and reports (so scores stay assigned to their model).
  // Server and Hugging Face: version from "Check model" (GET /v1/info or commit on the Hub).
  function modelKey(cfg) {
    const version = modelCheck(cfg)?.info?.version;
    return `${cfg.provider}:${providerDef(cfg)?.model(cfg) ?? ""}${version ? `@${version}` : ""}`;
  }

  function reportUrl(cfg, { version, browser }) {
    const body = [
      "**What happened?**",
      "",
      "",
      "**Details**",
      `- Version: ${version}`,
      `- Browser: ${browser}`,
      `- Model: ${modelKey(cfg)}`
    ].join("\n");
    return `https://github.com/OJPOJ/ai-check-extension/issues/new?${new URLSearchParams({ title: "", body })}`;
  }

  // Languages the model knows (ISO-639-1), or null = unknown, then everything is scored.
  // Custom models: value from "Check model" (GET /v1/info).
  function languages(cfg) {
    return family(cfg)?.languages ?? modelCheck(cfg)?.info?.languages ?? null;
  }

  // How much text per paragraph goes to the model - more than the model's context is useless.
  // Unknown models (custom server, Hugging Face): the server's value, otherwise 2000 characters, typical
  // for 512-token encoders.
  function maxChars(cfg) {
    return family(cfg)?.maxChars ?? modelCheck(cfg)?.info?.maxChars ?? 2000;
  }

  // Traffic light preset of the model family (local and in the browser, TMR and desklib are the same model), for
  // custom models the suggestion from "Check model"
  function presetFor(cfg) {
    return family(cfg)?.thresholds ?? modelCheck(cfg)?.thresholds ?? PRESETS.generic;
  }

  // How many batches a tab may send at the same time. Local/in the browser only one
  // process computes anyway - parallel batches would only undermine the prioritization (visible paragraphs first).
  function maxInFlight(cfg) {
    return providerDef(cfg)?.serial ? 1 : 2;
  }

  // Where texts leave the device to - null if they stay on this computer
  function remoteTarget(cfg) {
    const def = providerDef(cfg);
    if (!def) return null;
    if (def.remote) return def.remote;
    const url = def.endpoint(cfg);
    if (url === null) return null;
    try {
      const { hostname, host } = new URL(url);
      return hostname === "127.0.0.1" || hostname === "localhost" ? null : host;
    } catch {
      return "the entered server";
    }
  }

  function providerLabel(cfg) {
    const def = providerDef(cfg) || PROVIDERS.local;
    const detail = def.detail(cfg);
    return detail ? `${def.name} (${detail})` : def.name;
  }

  return {
    DEFAULTS,
    SECRET_DEFAULTS,
    PROVIDER_KEYS,
    PROVIDERS,
    MODELS,
    PRESETS,
    LEVEL_TEXT,
    catalog,
    level,
    reliableWords,
    shortRedFrom,
    languages,
    siteMatches,
    builtinMatch,
    blockReason,
    scanPolicy,
    checkSignature,
    modelCheck,
    modelKey,
    reportUrl,
    presetFor,
    maxChars,
    maxInFlight,
    remoteTarget,
    providerLabel
  };
})();
