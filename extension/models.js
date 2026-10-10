// Model catalog: everything the extension needs to know about a detection model, in one place.
// Classic script like config.js (must be loaded before it) - content scripts, popup, settings,
// service worker and offscreen document all read the same list.
//
// New model = new entry. Which providers offer it follows from the sections:
//   browser  runs via transformers.js/WASM directly in the extension (offscreen.js); `info` is shown below
//            the selection, `summary` (optional) replaces the general text on the selection card
//   server   is offered by server/shim_server.py under this key (provider "Local")
// The settings page builds its selection from this, config.js derives text length and presets.
globalThis.AIVSAI_MODELS = {
  tmr: {
    name: "TMR",
    title: "Fast – TMR", // selection card in the settings, `summary` below it
    summary:
      "RoBERTa-base, 126 MB. ~0.15 s per paragraph, ~300 MB RAM. " +
      "Mistakes human expository text for AI more often than desklib (especially how-tos), hence stricter thresholds.",
    // Context of the model and how much text the auto-scan sends for it (content.js, clipText).
    // TMR is fast and benefits greatly from more text: full 512 tokens (~2000 characters of English).
    maxTokens: 512,
    maxChars: 2000,
    // Traffic light starting values (training/EVAL_RESULTS.md, "False alarms on Wikipedia"): TMR scores high
    // even on human expository text - at 0.9, 40% of Wikipedia paragraphs with 80-149 words were red.
    // At 0.98 from 120 words ~1% false alarms, still ~90% of ChatGPT texts detected.
    thresholds: { yellowFrom: 0.95, redFrom: 0.98 },
    // Below this a high score becomes "uncertain" instead of yellow/red (config.js, level). Wikipedia paragraphs
    // with 80-119 words: 15% above 0.98, with 120-149 words 1.5%. No shortRedFrom: TMR almost never scores
    // above 0.99, there is no stricter threshold for short paragraphs.
    reliableWords: 120,
    // The auto-scan does not score paragraphs in other languages (lang-detect.js)
    languages: ["en"],
    browser: {
      // ready-made ONNX version from onnx-community, transformers.js downloads it itself
      repo: "onnx-community/tmr-ai-text-detector-ONNX",
      // `revision` is pinned so that scores do not change unnoticed through an upstream update.
      // `version` belongs to every stored score: change it (or it changes with the revision) as soon as
      // the same model can produce different numbers - new revision, different quantization, different cut.
      // Then old stored scores automatically no longer apply.
      revision: "b9aa251e5bcda7e429fcc936767d921435945b60",
      version: "b9aa251-q8",
      marker: "onnx/model_quantized.onnx", // if this file is in the cache, the model counts as downloaded
      download: "126 MB",
      // Facts for the cards on the setup page (setup.js); numbers as in `summary`/training/EVAL_RESULTS.md
      setup: { disk: "126 MB", speed: "~0.15 s per paragraph", falseAlarms: "~1% from 120 words, more on short or how-to texts" },
      info:
        "One-time download from Hugging Face (126 MB, public, no account/token needed), then usable " +
        "offline – the texts are only scored locally. Trained on English – German texts may be " +
        "classified incorrectly. MIT license, details in THIRD_PARTY_NOTICES.md."
    },
    server: {
      // Values from training/EVAL_RESULTS.md (test sample of 100, HC3 holdout, PyTorch on CPU)
      summary:
        "RoBERTa-base (125M). ~62 ms/text, ~900 MB RAM, batch of 25 ~1.6 s. " +
        "AUROC 0.91 in the test. Recommended for running along in the background."
    }
  },

  desklib: {
    name: "desklib",
    recommended: true, // main path on the setup page (setup.js): one button, the other models are folded away
    title: "Accurate – desklib",
    summary:
      "Recommended. DeBERTa-v3-large. ~1.3 s per paragraph, ~800 MB RAM. " +
      "Significantly fewer false alarms (~1% instead of ~5%), but slower – works well with \"Only paragraphs nearby\".",
    // Could do 768 tokens, but compute time grows faster than linearly (CPU: 500 characters 0.6 s,
    // 1500 characters 2.3 s, 650 tokens ~4.5 s) and desklib is already very accurate with short text -
    // 1500 characters (~350 tokens) as a compromise. Measurements: training/EVAL_RESULTS.md, "Text length".
    maxTokens: 768,
    maxChars: 1500,
    // redFrom 0.94 instead of 0.87 (up to v0.5): eval suite n=1200 as displayed 1.2% instead of 1.8% false alarms at
    // 91% instead of 92.5% detected, cross-validated ~0.95 (training/EVAL_RESULTS.md, "Securing the thresholds").
    thresholds: { yellowFrom: 0.5, redFrom: 0.94 },
    // Wikipedia paragraphs under 120 words: ~6% above 0.87, from 120 words ~1.3%. Short paragraphs
    // therefore only turn red from shortRedFrom (in between "uncertain"): at 0.98 ~1% false alarms as with long ones,
    // ~73% of short ChatGPT texts detected (training/EVAL_RESULTS.md, "Confidence for short paragraphs").
    reliableWords: 120,
    shortRedFrom: 0.98,
    languages: ["en"],
    browser: {
      // There is no usable ONNX of it: download the original and convert it in the browser
      // (desklib_build.js). The cache entries live under their own ID that does not exist on Hugging Face.
      repo: "aivsai-local/desklib-ai-text-detector-v1.01",
      revision: "5fdea974cd4287c61674951ec78803aa274e2fb7",
      version: "5fdea97-nbits8b32",
      marker: "onnx/model_quantized.onnx_data",
      download: "1.7 GB",
      // Facts for the cards on the setup page (setup.js); numbers as in `summary`/training/EVAL_RESULTS.md
      setup: {
        disk: "~475 MB (converted)",
        speed: "~1.3 s per paragraph",
        falseAlarms: "~1% (lowest of the three), also on shorter texts",
        pitch: "Fewest false alarms of the three, also on shorter paragraphs. Slower, so it works best when it scans what you are reading."
      },
      askBeforeDownload: true, // confirmation prompt in the settings (data volume)
      build: {
        source: "desklib/ai-text-detector-v1.01",
        tokenizerFiles: ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json"],
        shipped: { "config.json": "models/desklib/config.json", "onnx/model_quantized.onnx": "models/desklib/model_quantized.onnx" },
        recipe: "models/desklib/recipe.json"
      },
      info:
        "Downloads the original model from Hugging Face once (1.7 GB, public, no account/token needed) and " +
        "converts it directly in the browser into a compact 8-bit version (~475 MB on disk, same " +
        "accuracy). Usable offline afterwards. Trained on English. MIT license, details in THIRD_PARTY_NOTICES.md."
    },
    server: {
      summary:
        "DeBERTa-v3-large (430M). ~4.9 s/text, ~4.65 GB RAM, batch of 25 ~2 minutes. " +
        "AUROC 0.998 in the test. Significantly more accurate, but slow – better for \"Only on button press\"."
    }
  },

  fakespot: {
    name: "fakespot",
    title: "Balanced – fakespot",
    summary:
      "RoBERTa-base, 125 MB. ~0.15 s per paragraph, ~300 MB RAM (like TMR) – but with clearly better separation " +
      "(AUROC 0.96 instead of 0.93), especially on how-tos. Falls behind desklib (mainly reviews).",
    // Same architecture/size class as TMR (RoBERTa-base) - same context.
    maxTokens: 512,
    maxChars: 2000,
    // Thresholds cross-validated (training/MODEL_SEARCH.md, "ONNX comparison and integration (WP-09)"; method like
    // training/crossval_thresholds.py, WP-07): redFrom 0.999 (median of the cross-validation 0.9989, 5th-95th
    // percentile 0.9982-0.9995) -> ~1.1% false alarms, ~90% detected at >=120 words. yellowFrom not
    // cross-validated (no false alarm target for yellow, purely informative as with TMR/desklib) - 0.95 leaves
    // about 13% of human texts appearing as "unclear" instead of "not flagged".
    thresholds: { yellowFrom: 0.95, redFrom: 0.999 },
    // Scores cluster near 1 (steeper than TMR) - shortRedFrom is still worth it: cross-validated
    // 0.9994 (median, 5th-95th percentile 0.9987-0.9995) -> ~1.5% false alarms, ~34% detected at <120
    // words (weaker than desklib, but better than TMR's "never red").
    reliableWords: 120,
    shortRedFrom: 0.9994,
    languages: ["en"],
    browser: {
      // Ready-made ONNX from a third party (MedAliFarhat), explicitly built for transformers.js - no
      // desklib_build.js-style conversion step needed, simplest of the three cases in the catalog.
      // ONNX comparison against the PyTorch original: training/compare_onnx.py, numbers in MODEL_SEARCH.md.
      repo: "MedAliFarhat/ai-text-detector-onnx",
      revision: "0c809a8de6e600ec2fd0fcdeb595a5461d93e8dc",
      version: "0c809a8-q8",
      marker: "onnx/model_quantized.onnx",
      download: "125 MB",
      // Facts for the cards on the setup page (setup.js); numbers as in `summary`/training/EVAL_RESULTS.md
      setup: { disk: "125 MB", speed: "~0.15 s per paragraph", falseAlarms: "~1% from 120 words" },
      info:
        "One-time download from Hugging Face (125 MB, public, no account/token needed), then usable " +
        "offline – the texts are only scored locally. ONNX conversion by a third party (not by the " +
        "model's creator), checked against the original (training/MODEL_SEARCH.md). Trained on English – " +
        "German texts may be classified incorrectly. Apache 2.0 license, details in THIRD_PARTY_NOTICES.md."
    },
    server: {
      // Values from training/MODEL_SEARCH.md (eval suite n=1200, PyTorch on CPU)
      summary:
        "RoBERTa-base (125M). ~76 ms/text, ~900 MB RAM, batch of 25 ~45 ms/text. " +
        "AUROC 0.96 in the test. Better separation than TMR at the same latency."
    }
  }
};
