// Gemeinsame Defaults/Helfer für background.js, content.js, popup.js und options.js.
// Klassisches Skript (content_scripts/<script>) und per `import "./config.js"` im Service Worker
// nutzbar - deshalb als Eigenschaft von globalThis statt als Modul-Export.
globalThis.AIVSAI = (() => {
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
    showBadge: true,

    // Bewertungen so viele Tage speichern (nur Hash + Score, kein Text, keine URL); 0 = gar nicht
    scoreRetentionDays: 30
  };

  // Secrets liegen in storage.local, damit sie nicht über das Browser-Konto synchronisiert werden
  const SECRET_DEFAULTS = { customApiKey: "", hfToken: "" };

  // Änderungen an diesen Keys machen bisherige Scores ungültig -> Neu-Scan
  const PROVIDER_KEYS = ["provider", "browserModel", "localUrl", "localModel", "customUrl", "customModel", "hfModel", "hfAiLabel"];

  // Startwerte aus training/EVAL_RESULTS.md (kleine Stichprobe, keine Garantie).
  // Schlüssel = Modellfamilie (siehe modelKey), "generic" für unbekannte Modelle.
  const PRESETS = {
    tmr: { yellowFrom: 0.60, redFrom: 0.90 },
    desklib: { yellowFrom: 0.50, redFrom: 0.87 },
    generic: { yellowFrom: 0.60, redFrom: 0.90 }
  };

  // Modelle für den Provider "browser" (Laden/Umwandeln: offscreen.js, dort unter demselben Schlüssel).
  // `revision` ist fest gepinnt, damit sich Scores nicht durch ein Upstream-Update unbemerkt ändern.
  // `version` gehört zu jedem gespeicherten Score: ändern (bzw. ändert sich mit der Revision), sobald
  // dasselbe Modell andere Zahlen liefern kann - neue Revision, andere Quantisierung, anderer Zuschnitt.
  // Dann gelten alte gespeicherte Scores automatisch nicht mehr.
  const BROWSER_MODELS = {
    tmr: {
      name: "TMR",
      revision: "b9aa251e5bcda7e429fcc936767d921435945b60",
      version: "b9aa251-q8",
      download: "126 MB",
      info:
        "Einmaliger Download von Hugging Face (126 MB, öffentlich, kein Konto/Token nötig), danach offline " +
        "nutzbar – bewertet werden die Texte nur lokal. Englisch trainiert – deutsche Texte können falsch " +
        "eingestuft werden. MIT-Lizenz, Details in THIRD_PARTY_NOTICES.md."
    },
    desklib: {
      name: "desklib",
      revision: "5fdea974cd4287c61674951ec78803aa274e2fb7",
      version: "5fdea97-nbits8b32",
      download: "1,7 GB",
      builds: true, // wird beim Herunterladen im Browser umgewandelt
      info:
        "Lädt einmalig das Originalmodell von Hugging Face (1,7 GB, öffentlich, kein Konto/Token nötig) und " +
        "wandelt es direkt im Browser in eine kompakte 8-Bit-Version um (~475 MB auf der Platte, gleiche " +
        "Genauigkeit). Danach offline nutzbar. Englisch trainiert. MIT-Lizenz, Details in THIRD_PARTY_NOTICES.md."
    }
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

  // Einzige Stelle, die entscheidet, ob auf einer Seite gescannt werden darf:
  //   "off"    = gar nicht (Extension aus; später auch Sperrliste)
  //   "manual" = nur auf ausdrücklichen Wunsch (Popup-Knopf, Tastenkürzel, Rechtsklick)
  //   "auto"   = automatisch beim Laden
  function scanPolicy(host, cfg) {
    if (!cfg.enabled) return "off";
    if (cfg.scanMode === "all") return "auto";
    if (cfg.scanMode === "sites" && siteMatches(host, cfg.sites || [])) return "auto";
    return "manual";
  }

  // Stabile Kennung des gerade gewählten Modells inkl. Version, z.B. "browser:tmr@b9aa251-q8" - für Cache,
  // und später Kalibrierung, Feedback und Berichte (damit Scores ihrem Modell zugeordnet bleiben).
  function modelKey(cfg) {
    switch (cfg.provider) {
      case "browser":
        return `browser:${cfg.browserModel}@${BROWSER_MODELS[cfg.browserModel]?.version ?? "?"}`;
      case "local":
        return `local:${cfg.localModel}`;
      case "custom":
        return `custom:${cfg.customModel || cfg.customUrl}`;
      case "huggingface":
        return `huggingface:${cfg.hfModel}`;
      default:
        return `${cfg.provider}:`;
    }
  }

  // Modellfamilie für Presets: lokal und im Browser sind TMR bzw. desklib dasselbe Modell
  function presetFor(cfg) {
    const family = cfg.provider === "browser" ? cfg.browserModel : cfg.provider === "local" ? cfg.localModel : null;
    return PRESETS[family] || PRESETS.generic;
  }

  // Wie viele Batches ein Tab gleichzeitig schicken darf. Lokal/im Browser rechnet ohnehin nur ein
  // Prozess - parallele Batches würden nur die Priorisierung (sichtbare Absätze zuerst) aushebeln.
  function maxInFlight(cfg) {
    return cfg.provider === "local" || cfg.provider === "browser" ? 1 : 2;
  }

  function providerLabel(cfg) {
    if (cfg.provider === "custom") return `Eigener Server${cfg.customModel ? ` (${cfg.customModel})` : ""}`;
    if (cfg.provider === "huggingface") return `Hugging Face (${cfg.hfModel})`;
    if (cfg.provider === "browser") return `Im Browser (${(BROWSER_MODELS[cfg.browserModel] || BROWSER_MODELS.tmr).name})`;
    return `Lokal (${cfg.localModel})`;
  }

  return {
    DEFAULTS,
    SECRET_DEFAULTS,
    PROVIDER_KEYS,
    PRESETS,
    BROWSER_MODELS,
    LEVEL_TEXT,
    level,
    siteMatches,
    scanPolicy,
    modelKey,
    presetFor,
    maxInFlight,
    providerLabel
  };
})();
