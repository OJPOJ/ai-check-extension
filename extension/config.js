// Gemeinsame Defaults/Helfer für background.js, content.js, popup.js und options.js.
// Klassisches Skript (content_scripts/<script>) und per `import "./config.js"` im Service Worker
// nutzbar - deshalb als Eigenschaft von globalThis statt als Modul-Export. Braucht models.js davor.
globalThis.AIVSAI = (() => {
  // Modellkatalog aus models.js
  const MODELS = globalThis.AIVSAI_MODELS;
  if (!MODELS) throw new Error("models.js muss vor config.js geladen werden");

  const LOCAL_URL = "http://127.0.0.1:8787";

  // Provider = wo und wie bewertet wird. Jeder beschreibt sich hier selbst; die Einstellungsseite baut
  // Auswahl und Formular daraus, der Rest (Cache-Schlüssel, Datenschutz-Hinweis, Parallelität) wird
  // abgeleitet. Die eigentliche Anfrage steht unter demselben Schlüssel in bg/providers.js.
  //
  //   name           kurz, für Popup, Tooltip und Popover ("Im Browser (TMR)")
  //   title, description  Auswahlkarte in den Einstellungen
  //   fields         eigene Einstellungen. key = Schlüssel im Storage (secret: storage.local, wird nicht
  //                  synchronisiert). type: "model" (Auswahl aus models.js, Abschnitt `catalog`), "url",
  //                  "text", "password". required: darf nicht leer sein. note/hint/placeholder: Texte.
  //   family(cfg)    Schlüssel in models.js, falls das Modell bekannt ist -> Textlänge und Ampel-Presets
  //   model(cfg)     stabile Kennung des Modells inkl. Version (Teil von modelKey)
  //   detail(cfg)    Zusatz zum Namen, z.B. das Modell
  //   endpoint(cfg)  URL, an die Texte gehen (null = bleiben in der Extension) -> Host-Berechtigung
  //   origins        weitere Host-Berechtigungen (z.B. für Modell-Metadaten)
  //   remote         fester Text für den Datenschutz-Hinweis statt des Hosts aus endpoint()
  //   serial         rechnet ohnehin nur ein Prozess -> keine parallelen Batches
  //   check          „Modell prüfen“ (bg/model-check.js): "required" = Pflicht vor dem Speichern, "optional".
  //                  Das Ergebnis liefert Version (-> modelKey), Textlänge und Ampel-Startwerte, siehe modelCheck()
  const PROVIDERS = {
    browser: {
      name: "Im Browser",
      title: "Im Browser (empfohlen)",
      description: "Das Modell läuft direkt in der Extension – kein Server nötig, Texte verlassen den Rechner nicht.",
      fields: [{ key: "browserModel", type: "model", catalog: "browser", label: "Modell", default: "tmr" }],
      family: (cfg) => cfg.browserModel,
      model: (cfg) => `${cfg.browserModel}@${MODELS[cfg.browserModel]?.browser?.version ?? "?"}`,
      detail: (cfg) => (MODELS[cfg.browserModel] || MODELS.tmr).name,
      endpoint: () => null,
      serial: true
    },
    local: {
      name: "Lokal",
      title: "Lokaler Server",
      description: "shim_server.py auf diesem Rechner – Texte verlassen den Rechner nicht.",
      fields: [
        { key: "localUrl", type: "url", label: "Server-URL", default: LOCAL_URL, placeholder: LOCAL_URL },
        { key: "localModel", type: "model", catalog: "server", label: "Modell", default: "tmr" }
      ],
      family: (cfg) => cfg.localModel,
      model: (cfg) => cfg.localModel,
      detail: (cfg) => cfg.localModel,
      endpoint: (cfg) => cfg.localUrl || LOCAL_URL,
      serial: true,
      check: "optional"
    },
    custom: {
      name: "Eigener Server",
      title: "Eigener Server / Cloud",
      description: "Beliebiger HTTP-Endpunkt mit einfachem JSON-Vertrag, z.B. shim_server.py in der Cloud.",
      fields: [
        {
          key: "customUrl", type: "url", label: "Endpunkt-URL", default: "", required: true,
          placeholder: "https://detector.example.com/v1/score"
        },
        { key: "customApiKey", type: "password", label: "API-Key", note: "optional, als Bearer-Token", default: "", secret: true },
        { key: "customModel", type: "text", label: "Modell", note: "optional, wird als „model“ mitgeschickt", default: "", placeholder: "tmr" }
      ],
      family: () => null, // unbekannt, was der Server rechnet
      model: (cfg) => cfg.customModel || cfg.customUrl,
      detail: (cfg) => cfg.customModel,
      endpoint: (cfg) => cfg.customUrl,
      check: "required"
    },
    huggingface: {
      name: "Hugging Face",
      title: "Hugging Face Inference API",
      description: "Textklassifikations-Modell vom Hugging Face Hub, gehostet von Hugging Face.",
      fields: [
        {
          key: "hfModel", type: "text", label: "Modell-ID", default: "openai-community/roberta-base-openai-detector",
          required: true, placeholder: "openai-community/roberta-base-openai-detector",
          hint: "Muss als Textklassifikation über „HF Inference“ verfügbar sein (Modellseite → Deploy → Inference Providers)."
        },
        {
          key: "hfToken", type: "password", label: "Access Token", default: "", secret: true, placeholder: "hf_…",
          hint: "Wird nur lokal in diesem Browser gespeichert, nicht synchronisiert."
        },
        { key: "hfAiLabel", type: "text", label: "Label der KI-Klasse", note: "optional", default: "", placeholder: "automatisch (AI, Fake, LABEL_1, …)" }
      ],
      family: () => null,
      model: (cfg) => cfg.hfModel,
      detail: (cfg) => cfg.hfModel,
      endpoint: () => "https://router.huggingface.co/",
      origins: ["https://huggingface.co/*"], // Modellinfo und config.json vom Hub
      remote: "Hugging Face (router.huggingface.co)",
      check: "required"
    }
  };

  const providerFields = (secret) => Object.values(PROVIDERS).flatMap((p) => p.fields.filter((f) => !!f.secret === secret));
  const defaultsOf = (fields) => Object.fromEntries(fields.map((f) => [f.key, f.default]));

  const DEFAULTS = {
    enabled: true,
    // "manual" = nur per Popup-Knopf, "sites" = nur Seiten aus `sites`, "all" = jede Seite
    scanMode: "sites",
    sites: [],
    // Sperrliste: hier nie automatisch scannen, auch nicht per "Seite jetzt scannen" (Banking, Mail, ...).
    // Die manuelle Prüfung einzelner Stellen bleibt erlaubt - sie ist immer eine bewusste Einzelaktion.
    // Mitgeliefert: generated/blocklist.js (scripts/build-blocklist.mjs), dazu eigene Einträge und Ausnahmen.
    builtinBlocklist: true,
    blockedSites: [], // eigene Einträge, gelten immer
    unblockedSites: [], // Ausnahmen von der mitgelieferten Liste
    // Seiten mit sichtbarem Passwort- oder Zahlungsfeld wie gesperrt behandeln (fängt ab, was keine Liste kennt)
    sensitiveHeuristic: true,
    // nur Absätze nahe am sichtbaren Bereich bewerten, Rest erst beim Scrollen (spart Cloud-Kosten)
    lazyScan: true,

    // Schlüssel aus PROVIDERS, dazu deren Felder (browserModel, localUrl, ...) mit ihren Defaults
    provider: "browser",
    ...defaultsOf(providerFields(false)),

    // Ampel: score < yellowFrom = grün, < redFrom = gelb, sonst rot (Startwerte des Default-Modells TMR)
    ...MODELS.tmr.thresholds,
    showGreen: true,
    showBadge: true,

    // Bewertungen so viele Tage speichern (nur Hash + Score, kein Text, keine URL); 0 = gar nicht
    scoreRetentionDays: 30,

    // Feedback-Knöpfe im Ergebnis-Popover (gespeichert wird erst nach Einwilligung, siehe bg/feedback-store.js)
    feedbackButtons: true,

    // Letztes Ergebnis von „Modell prüfen“ je Provider (bg/model-check.js, gespeichert von options.js):
    // { sig, at, ok, info: {name?, version?, maxChars?, languages?, aiLabel?}, thresholds, auroc, msPerText }
    modelChecks: {}
  };

  // Secrets liegen in storage.local, damit sie nicht über das Browser-Konto synchronisiert werden
  const SECRET_DEFAULTS = defaultsOf(providerFields(true));

  // Änderungen an diesen Keys machen bisherige Scores ungültig -> Neu-Scan
  const PROVIDER_KEYS = ["provider", ...providerFields(false).map((f) => f.key)];

  // Ampel-Startwerte je Modellfamilie (thresholds in models.js), "generic" für unbekannte Modelle
  const PRESETS = {
    ...Object.fromEntries(Object.entries(MODELS).map(([key, m]) => [key, m.thresholds])),
    generic: { yellowFrom: 0.6, redFrom: 0.9 }
  };

  // Modelle, die ein Abschnitt aus models.js ("browser", "server") anbietet: [[key, model], ...]
  const catalog = (section) => Object.entries(MODELS).filter(([, m]) => m[section]);

  // Bewusst keine Wahrscheinlichkeit („wahrscheinlich KI“): Die Scores sind nicht kalibriert
  // (TODO.md, Punkt 5), und ein Detektor liefert Hinweise, keine Beweise.
  const LEVEL_TEXT = {
    red: "Auffällig – ähnelt KI-Text",
    yellow: "Unklar",
    green: "Unauffällig",
    uncertain: "Zu kurz für eine Aussage"
  };

  // Unter so vielen Wörtern kein Gelb/Rot, wenn das Modell nichts eigenes angibt - TMR und desklib brauchen
  // beide ~120 Wörter für wenige Fehlalarme (training/EVAL_RESULTS.md, "Fehlalarme auf Wikipedia")
  const RELIABLE_WORDS = 120;

  // Ab wie vielen Wörtern die Ampel einem hohen Score traut (models.js, reliableWords)
  function reliableWords(cfg) {
    return family(cfg)?.reliableWords ?? RELIABLE_WORDS;
  }

  // Rot-Schwelle für Texte unter reliableWords, null = kurze Texte werden nie rot (models.js, shortRedFrom).
  // Nie lockerer als die eingestellte Rot-Schwelle.
  function shortRedFrom(cfg) {
    const short = family(cfg)?.shortRedFrom;
    return short === undefined ? null : Math.max(short, cfg.redFrom);
  }

  // words (optional): Länge des bewerteten Texts. Kurze Texte mit hohem Score werden "uncertain" statt
  // gelb/rot - der größte Schaden ist Rot auf einem menschlichen Text, und kurze Texte trennt das Modell
  // deutlich schlechter (training/EVAL_RESULTS.md, "Fehlalarme auf Wikipedia"). Ausnahme: Modelle, die
  // bei kurzen Texten mit strengerer Schwelle so selten danebenliegen wie bei langen (shortRedFrom).
  // Grün bleibt grün.
  function level(p, cfg, words) {
    const base = p >= cfg.redFrom ? "red" : p >= cfg.yellowFrom ? "yellow" : "green";
    if (base === "green" || words === undefined || words >= reliableWords(cfg)) return base;
    const short = shortRedFrom(cfg);
    return short !== null && p >= short ? "red" : "uncertain";
  }

  function siteMatches(host, sites) {
    return sites.some((s) => host === s || host.endsWith(`.${s}`));
  }

  // Mitgelieferte Liste als "\nd1\nd2\n...\n"-String: Suche nach Host und allen Eltern-Domains,
  // ohne ein Set mit 10.000 Einträgen in jedem Tab aufzubauen. Ergebnis pro Host gemerkt.
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

  // Warum eine Seite gesperrt ist: "user" (eigener Eintrag), "builtin" (mitgelieferte Liste) oder null
  function blockReason(host, cfg) {
    if (siteMatches(host, cfg.blockedSites || [])) return "user";
    if (cfg.builtinBlocklist && builtinMatch(host) && !siteMatches(host, cfg.unblockedSites || [])) return "builtin";
    return null;
  }

  // Einzige Stelle, die entscheidet, ob auf einer Seite gescannt werden darf:
  //   "off"     = gar nicht (Extension aus)
  //   "blocked" = Sperrliste: kein Scan der Seite, nur Einzelprüfung per Auswahl/Rechtsklick
  //   "manual"  = nur auf ausdrücklichen Wunsch (Popup-Knopf, Tastenkürzel, Rechtsklick)
  //   "auto"    = automatisch beim Laden
  function scanPolicy(host, cfg) {
    if (!cfg.enabled) return "off";
    if (blockReason(host, cfg)) return "blocked";
    if (cfg.scanMode === "all") return "auto";
    if (cfg.scanMode === "sites" && siteMatches(host, cfg.sites || [])) return "auto";
    return "manual";
  }

  const providerDef = (cfg) => PROVIDERS[cfg.provider];
  const family = (cfg) => MODELS[providerDef(cfg)?.family(cfg)] ?? null;

  // Welches Modell eine Prüfung betrifft: die nicht geheimen Felder des Providers. Token/API-Key gehören
  // nicht dazu - ein neuer Schlüssel ändert das Modell nicht.
  function checkSignature(cfg) {
    const def = providerDef(cfg);
    if (!def) return "";
    return JSON.stringify([cfg.provider, ...def.fields.filter((f) => !f.secret).map((f) => cfg[f.key] ?? "")]);
  }

  // Bestandene Prüfung („Modell prüfen“) für die aktuellen Einstellungen, sonst null (nie geprüft,
  // durchgefallen oder seitdem anderes Modell/andere URL eingetragen)
  function modelCheck(cfg) {
    const check = cfg.modelChecks?.[cfg.provider];
    return check?.ok && check.sig === checkSignature(cfg) ? check : null;
  }

  // Stabile Kennung des gerade gewählten Modells inkl. Version, z.B. "browser:tmr@b9aa251-q8" - für Cache,
  // und später Kalibrierung, Feedback und Berichte (damit Scores ihrem Modell zugeordnet bleiben).
  // Server und Hugging Face: Version aus „Modell prüfen“ (GET /v1/info bzw. Commit auf dem Hub).
  function modelKey(cfg) {
    const version = modelCheck(cfg)?.info?.version;
    return `${cfg.provider}:${providerDef(cfg)?.model(cfg) ?? ""}${version ? `@${version}` : ""}`;
  }

  // Sprachen, die das Modell kennt (ISO-639-1), oder null = unbekannt, dann wird alles bewertet.
  // Eigene Modelle: Angabe aus „Modell prüfen“ (GET /v1/info).
  function languages(cfg) {
    return family(cfg)?.languages ?? modelCheck(cfg)?.info?.languages ?? null;
  }

  // Wie viel Text pro Absatz ans Modell geht - mehr als der Kontext des Modells bringt nichts.
  // Unbekannte Modelle (eigener Server, Hugging Face): Angabe des Servers, sonst 2000 Zeichen, typisch
  // für 512-Token-Encoder.
  function maxChars(cfg) {
    return family(cfg)?.maxChars ?? modelCheck(cfg)?.info?.maxChars ?? 2000;
  }

  // Ampel-Preset der Modellfamilie (lokal und im Browser sind TMR bzw. desklib dasselbe Modell), für
  // eigene Modelle der Vorschlag aus „Modell prüfen“
  function presetFor(cfg) {
    return family(cfg)?.thresholds ?? modelCheck(cfg)?.thresholds ?? PRESETS.generic;
  }

  // Wie viele Batches ein Tab gleichzeitig schicken darf. Lokal/im Browser rechnet ohnehin nur ein
  // Prozess - parallele Batches würden nur die Priorisierung (sichtbare Absätze zuerst) aushebeln.
  function maxInFlight(cfg) {
    return providerDef(cfg)?.serial ? 1 : 2;
  }

  // Wohin Texte das Gerät verlassen - null, wenn sie auf diesem Rechner bleiben
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
      return "den eingetragenen Server";
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
    presetFor,
    maxChars,
    maxInFlight,
    remoteTarget,
    providerLabel
  };
})();
