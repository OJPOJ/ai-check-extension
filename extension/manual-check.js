// Single check of one text (selection, paragraph): word limits, excerpt for the model and the result view with
// traffic light level and notes. Shared by content.js (popover on the page) and selection-check.js (own window
// for text without a content script, e.g. the browser's PDF viewer) - so that both show the same verdict.
// Classic script like config.js, result in globalThis.AIVSAI_MANUAL. Needs config.js and lang-detect.js before it.
globalThis.AIVSAI_MANUAL = (() => {
  // From this many words a score counts as reliable enough without a note
  const MIN_WORDS = 40;
  // Manual check: short texts too (result then comes with a note)
  const MANUAL_MIN_WORDS = 5;
  // Lower bound for paragraphs that may become a candidate ONLY as part of a group (see groupRuns)
  const GROUP_MIN_WORDS = 15;
  const GROUP_SEPARATOR = "\n\n";
  // How much text goes to the backend in one request (a batch of long paragraphs would otherwise block the queue)
  const BATCH_MAX_ITEMS = 5;
  const BATCH_MAX_CHARS = 2500;

  function wordCount(text) {
    return text.split(/\s+/).filter(Boolean).length;
  }

  // Clip to AIVSAI.maxChars, preferably at the last sentence end (otherwise at the last space) - the model should
  // not see a truncated half-sentence. Read only, deterministic: same text -> same excerpt.
  function clipText(text, cfg) {
    const maxChars = AIVSAI.maxChars(cfg);
    if (text.length <= maxChars) return text;
    const cut = text.slice(0, maxChars);
    const minLength = maxChars * 0.6;
    const sentence = cut.match(/^[\s\S]*[.!?…]["'”’»)\]]?(?=\s)/);
    if (sentence && sentence[0].length >= minLength) return sentence[0];
    const space = cut.lastIndexOf(" ");
    return space >= minLength ? cut.slice(0, space) : cut;
  }

  // Grouping of short paragraphs (TODO.md item 2): adjacent paragraphs below reliableWords are scored as one text and
  // share the result - more context lowers the error rate sharply (training/EVAL_RESULTS.md, "Text length"). A
  // paragraph that is already reliable (long) stays single, a group only grows up to maxChars (model context).
  // `items`: in reading order, each {text, words, lang}. `canJoin(last, next)`: the caller's structural condition
  // (same container and no heading between on a page, no heading/section change in a PDF).
  // Returns an array of groups (arrays of items); a single paragraph is a group of one.
  function groupRuns(items, cfg, canJoin = () => true) {
    if (!cfg.groupShortParagraphs) return items.map((f) => [f]);
    const reliable = AIVSAI.reliableWords(cfg);
    const limit = AIVSAI.maxChars(cfg);
    const groups = [];
    let open = null; // { items, chars, lang } of the most recently started group that can still be extended
    for (const f of items) {
      const foreign = foreignOf(f.lang, cfg);
      const short = !foreign && f.words < reliable;
      if (
        open &&
        short &&
        f.lang === open.lang &&
        canJoin(open.items[open.items.length - 1], f) &&
        open.chars + GROUP_SEPARATOR.length + f.text.length <= limit
      ) {
        open.items.push(f);
        open.chars += GROUP_SEPARATOR.length + f.text.length;
        continue;
      }
      const group = [f];
      groups.push(group);
      open = short ? { items: group, chars: f.text.length, lang: f.lang } : null;
    }
    return groups;
  }

  function tooShort(words) {
    return `Too little text (${words} ${words === 1 ? "word" : "words"}) – at least ${MANUAL_MIN_WORDS} words needed.`;
  }

  const langList = (langs) => langs.map(AIVSAI_LANG.name).join(", ");

  // `lang` if the model does not know the language (AIVSAI.languages), otherwise ""
  function foreignOf(lang, cfg) {
    const langs = AIVSAI.languages(cfg);
    return lang && langs && !langs.includes(lang) ? lang : "";
  }

  // Level of a result: short text or foreign language -> "uncertain" instead of yellow/red
  function levelOf({ p, words, foreign }, cfg) {
    return foreign ? "uncertain" : AIVSAI.level(p, cfg, words);
  }

  // Heading for a result, with the reason for "uncertain"
  function levelTitle(rec, level) {
    if (level !== "uncertain") return AIVSAI.LEVEL_TEXT[level];
    return rec.foreign ? `Cannot be scored – ${AIVSAI_LANG.name(rec.foreign)}` : AIVSAI.LEVEL_TEXT.uncertain;
  }

  // AI score as a number from 0 to 100, deliberately not as a percentage: not calibrated, not a probability
  const scoreText = (p) => `AI score ${Math.round(p * 100)}`;

  // Result view for the popover. For "uncertain" the reason comes first instead of the number, the raw value only in the text.
  // `extraNotes`: notes of the caller (e.g. blocked site) that come after the provider.
  function resultView(rec, cfg, extraNotes = []) {
    const { p, words } = rec;
    const level = levelOf(rec, cfg);
    const raw = `Raw value ${Math.round(p * 100)} of 100`;
    const notes = [];
    if (rec.grouped) {
      notes.push(
        `Score applies to ${rec.grouped} adjacent, short paragraphs together (${words} words in total) – ` +
          "more context lowers false alarms on short paragraphs."
      );
    }
    if (rec.foreign) {
      notes.push(`The model only knows ${langList(AIVSAI.languages(cfg))} – ${raw}, not meaningful in this language.`);
    } else if (level === "uncertain") {
      const short = AIVSAI.shortRedFrom(cfg);
      notes.push(
        short === null
          ? `Only ${words} words – under ${AIVSAI.reliableWords(cfg)} words the model is wrong too often ` +
              `to mark a text as flagged. ${raw}.`
          : `Only ${words} words – under ${AIVSAI.reliableWords(cfg)} words the model is wrong more often, ` +
              `so a short text only counts as flagged from ${Math.round(short * 100)}. ${raw}.`
      );
    } else if (level === "red" && words < AIVSAI.reliableWords(cfg)) {
      notes.push(
        `Short text (${words} words) – the stricter threshold ${Math.round(AIVSAI.shortRedFrom(cfg) * 100)} applies to it, ` +
          "so that it is not falsely flagged more often than a long one."
      );
    } else if (words < MIN_WORDS) {
      notes.push(`Short text (${words} words) – result not very reliable.`);
    }
    if (rec.truncated) {
      notes.push(`The first ${rec.text.length} characters (up to the sentence end) were scored – the model does not see more.`);
    }
    notes.push(
      "Hint, not proof: The AI score shows how much the text resembles what the model learned as AI text " +
        "– not a probability. Human texts can also score high.",
      AIVSAI.providerLabel(cfg),
      ...extraNotes
    );
    const pill = level === "uncertain" ? "uncertain" : scoreText(p);
    return { pill: { text: pill, level }, title: levelTitle(rec, level), notes };
  }

  return {
    MIN_WORDS,
    MANUAL_MIN_WORDS,
    GROUP_MIN_WORDS,
    GROUP_SEPARATOR,
    BATCH_MAX_ITEMS,
    BATCH_MAX_CHARS,
    groupRuns,
    wordCount,
    clipText,
    tooShort,
    langList,
    foreignOf,
    levelOf,
    levelTitle,
    scoreText,
    resultView
  };
})();
