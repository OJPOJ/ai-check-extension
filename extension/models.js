// Modellkatalog: alles, was die Extension über ein Erkennungsmodell wissen muss, an einer Stelle.
// Klassisches Skript wie config.js (muss davor geladen werden) - Content-Scripts, Popup, Einstellungen,
// Service Worker und Offscreen-Dokument lesen dieselbe Liste.
//
// Neues Modell = neuer Eintrag. Welche Provider es anbieten, ergibt sich aus den Abschnitten:
//   browser  läuft per transformers.js/WASM direkt in der Extension (offscreen.js); `info` steht unter
//            der Auswahl, `summary` (optional) ersetzt den allgemeinen Text auf der Auswahlkarte
//   server   wird von server/shim_server.py unter diesem Schlüssel angeboten (Provider "Lokal")
// Die Einstellungsseite baut ihre Auswahl daraus, config.js leitet Textlänge und Presets ab.
globalThis.AIVSAI_MODELS = {
  tmr: {
    name: "TMR",
    title: "Schnell – TMR", // Auswahlkarte in den Einstellungen, darunter `summary`
    summary:
      "RoBERTa-base, 126 MB. ~0,15 s pro Absatz, ~300 MB RAM. " +
      "Markiert sachliche Texte (z.B. englische Wikipedia) oft fälschlich als KI.",
    // Kontext des Modells und wie viel Text der Auto-Scan dafür schickt (content.js, clipText).
    // TMR ist schnell und profitiert stark von mehr Text: volle 512 Tokens (~2000 Zeichen Englisch).
    maxTokens: 512,
    maxChars: 2000,
    // Startwerte der Ampel aus training/EVAL_RESULTS.md (kleine Stichprobe, keine Garantie)
    thresholds: { yellowFrom: 0.6, redFrom: 0.9 },
    browser: {
      // fertige ONNX-Version von onnx-community, lädt transformers.js selbst herunter
      repo: "onnx-community/tmr-ai-text-detector-ONNX",
      // `revision` ist fest gepinnt, damit sich Scores nicht durch ein Upstream-Update unbemerkt ändern.
      // `version` gehört zu jedem gespeicherten Score: ändern (bzw. ändert sich mit der Revision), sobald
      // dasselbe Modell andere Zahlen liefern kann - neue Revision, andere Quantisierung, anderer Zuschnitt.
      // Dann gelten alte gespeicherte Scores automatisch nicht mehr.
      revision: "b9aa251e5bcda7e429fcc936767d921435945b60",
      version: "b9aa251-q8",
      marker: "onnx/model_quantized.onnx", // liegt diese Datei im Cache, gilt das Modell als heruntergeladen
      download: "126 MB",
      info:
        "Einmaliger Download von Hugging Face (126 MB, öffentlich, kein Konto/Token nötig), danach offline " +
        "nutzbar – bewertet werden die Texte nur lokal. Englisch trainiert – deutsche Texte können falsch " +
        "eingestuft werden. MIT-Lizenz, Details in THIRD_PARTY_NOTICES.md."
    },
    server: {
      // Werte aus training/EVAL_RESULTS.md (100er-Testsample, HC3-Holdout, PyTorch auf CPU)
      summary:
        "RoBERTa-base (125M). ~62 ms/Text, ~900 MB RAM, 25er-Batch ~1,6 s. " +
        "AUROC 0.91 im Test. Empfohlen fürs Mitlaufen im Hintergrund."
    }
  },

  desklib: {
    name: "desklib",
    title: "Genau – desklib",
    summary:
      "DeBERTa-v3-large. ~1,3 s pro Absatz, ~800 MB RAM. " +
      "Deutlich weniger Fehlalarme, dafür langsamer – gut mit „Nur Absätze in der Nähe“.",
    // Könnte 768 Tokens, aber die Rechenzeit wächst stärker als linear (CPU: 500 Zeichen 0,6 s,
    // 1500 Zeichen 2,3 s, 650 Tokens ~4,5 s) und desklib ist schon mit kurzem Text sehr genau -
    // 1500 Zeichen (~350 Tokens) als Kompromiss. Messungen: training/EVAL_RESULTS.md, "Textlänge".
    maxTokens: 768,
    maxChars: 1500,
    thresholds: { yellowFrom: 0.5, redFrom: 0.87 },
    browser: {
      // Gibt es nicht als brauchbares ONNX: Original herunterladen und im Browser umwandeln
      // (desklib_build.js). Die Cache-Einträge liegen unter einer eigenen ID, die es auf Hugging Face nicht gibt.
      repo: "aivsai-local/desklib-ai-text-detector-v1.01",
      revision: "5fdea974cd4287c61674951ec78803aa274e2fb7",
      version: "5fdea97-nbits8b32",
      marker: "onnx/model_quantized.onnx_data",
      download: "1,7 GB",
      build: {
        source: "desklib/ai-text-detector-v1.01",
        tokenizerFiles: ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json"],
        shipped: { "config.json": "models/desklib/config.json", "onnx/model_quantized.onnx": "models/desklib/model_quantized.onnx" },
        recipe: "models/desklib/recipe.json"
      },
      info:
        "Lädt einmalig das Originalmodell von Hugging Face (1,7 GB, öffentlich, kein Konto/Token nötig) und " +
        "wandelt es direkt im Browser in eine kompakte 8-Bit-Version um (~475 MB auf der Platte, gleiche " +
        "Genauigkeit). Danach offline nutzbar. Englisch trainiert. MIT-Lizenz, Details in THIRD_PARTY_NOTICES.md."
    },
    server: {
      summary:
        "DeBERTa-v3-large (430M). ~4,9 s/Text, ~4,65 GB RAM, 25er-Batch ~2 Minuten. " +
        "AUROC 0.998 im Test. Deutlich genauer, aber langsam – eher für „Nur auf Knopfdruck“."
    }
  }
};
