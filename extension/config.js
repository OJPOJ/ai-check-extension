// Gemeinsame Defaults/Helfer für background.js, content.js, popup.js und options.js
// (per importScripts bzw. <script>/content_scripts eingebunden).
const AIVSAI = (() => {
  const DEFAULTS = {
    enabled: true,
    // "manual" = nur per Popup-Knopf, "sites" = nur Seiten aus `sites`, "all" = jede Seite
    scanMode: "sites",
    sites: [],
    // nur Absätze nahe am sichtbaren Bereich bewerten, Rest erst beim Scrollen (spart Cloud-Kosten)
    lazyScan: true,

    // "browser" = Modell per WebAssembly direkt in der Extension (offscreen.js),
    // "local" = shim_server.py auf diesem Rechner, "custom" = eigener Server (z.B. Cloud),
    // "huggingface" = Hugging Face Inference API
    provider: "browser",
    browserModel: "tmr", // Schlüssel aus BROWSER_MODELS
    localUrl: "http://127.0.0.1:8787",
    localModel: "tmr",
    customUrl: "",
    customModel: "",
    hfModel: "openai-community/roberta-base-openai-detector",
    hfAiLabel: "",

    // Ampel: score < yellowFrom = grün, < redFrom = gelb, sonst rot
    yellowFrom: 0.60,
    redFrom: 0.90,
    showGreen: true,
    showBadge: true
  };

  // Secrets liegen in storage.local, damit sie nicht über das Browser-Konto synchronisiert werden
  const SECRET_DEFAULTS = { customApiKey: "", hfToken: "" };

  // Änderungen an diesen Keys machen bisherige Scores ungültig -> Neu-Scan
  const PROVIDER_KEYS = ["provider", "browserModel", "localUrl", "localModel", "customUrl", "customModel", "hfModel", "hfAiLabel"];

  // Startwerte aus training/EVAL_RESULTS.md (kleine Stichprobe, keine Garantie)
  const PRESETS = {
    tmr: { yellowFrom: 0.60, redFrom: 0.90 },
    desklib: { yellowFrom: 0.50, redFrom: 0.87 },
    generic: { yellowFrom: 0.60, redFrom: 0.90 }
  };

  // Modelle für den Provider "browser" (Laden/Umwandeln: offscreen.js)
  const BROWSER_MODELS = {
    tmr: { name: "TMR", download: "126 MB" },
    desklib: { name: "desklib", download: "1,7 GB" }
  };

  const LEVEL_TEXT = {
    red: "Wahrscheinlich KI-generiert",
    yellow: "Unklar",
    green: "Wahrscheinlich menschlich"
  };

  function level(p, cfg) {
    if (p >= cfg.redFrom) return "red";
    if (p >= cfg.yellowFrom) return "yellow";
    return "green";
  }

  function siteMatches(host, sites) {
    return sites.some((s) => host === s || host.endsWith(`.${s}`));
  }

  function providerLabel(cfg) {
    if (cfg.provider === "custom") return `Eigener Server${cfg.customModel ? ` (${cfg.customModel})` : ""}`;
    if (cfg.provider === "huggingface") return `Hugging Face (${cfg.hfModel})`;
    if (cfg.provider === "browser") return `Im Browser (${(BROWSER_MODELS[cfg.browserModel] || BROWSER_MODELS.tmr).name})`;
    return `Lokal (${cfg.localModel})`;
  }

  return { DEFAULTS, SECRET_DEFAULTS, PROVIDER_KEYS, PRESETS, BROWSER_MODELS, LEVEL_TEXT, level, siteMatches, providerLabel };
})();
