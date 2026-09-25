// Spracherkennung pro Absatz: Die mitgelieferten Modelle kennen nur Englisch - deutscher Fachtext bekam
// im Harness 78 % (Fehlalarm). Das `lang`-Attribut der Seite reicht nicht: fehlt oft, steht auf
// Vorlagen-Standard ("en") oder gilt für die Seite, nicht für den einzelnen Absatz.
// Klassisches Skript wie config.js (Content-Scripts laden es davor), Ergebnis in globalThis.AIVSAI_LANG.
//
// detectAsync(): Chromes eingebaute Erkennung (CLD3), siehe unten. detect(): Fallback ohne Browser-API.
// Verfahren: Anteil häufiger Funktionswörter je Sprache. Englische Prosa besteht zu ~40 % aus diesen
// Wörtern, fremdsprachige kaum - das trennt schon bei 20 Wörtern zuverlässig, auch bei Fachtext mit
// englischen Begriffen. Andere Schriften (Kyrillisch, CJK, ...) über den Unicode-Bereich.
globalThis.AIVSAI_LANG = (() => {
  const STOPWORDS = {
    en: "the of and to in is that it for was on are as with his they be at this have from or by not but what all were when we there can an your which their if do will each about how up out them she many some so these would other into has more her two like him see time could no make than been who its now people my over down only way did get may our also after should because most us through where much before any those while however",
    de: "der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei ich wir ihr kann können gibt diese dieser dieses wenn uns sehr unter immer schon",
    fr: "le la les de des du un une et est en que qui dans pour pas sur au aux avec ce ces se sont par plus il elle ils nous vous ont été être mais ou son sa ses leur comme tout fait cette aussi",
    es: "el la los las de del y en que un una es por con para no se su sus al lo como más pero sobre este esta son ha fue ser está también entre cuando muy sin hasta desde todo",
    it: "il lo la gli le di del della dei e è in che un una per con non si da al alla sono come più ma anche questo questa nel nella stato essere tra fra hanno ha loro suo sua",
    nl: "de het een en van in is dat op te voor met zijn niet aan er ook als bij door wordt worden maar om uit dan nog naar hij zij ze wij hebben heeft deze dit was kan",
    pt: "o a os as de do da dos das e em um uma que é para com não por no na se mais ao como mas foi ser são tem também pelo pela entre sobre seu sua isso este esta"
  };
  const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words.split(" "))]));

  // Nicht-lateinische Schriften: Anteil der Buchstaben entscheidet
  const SCRIPTS = [
    ["ru", /\p{Script=Cyrillic}/u],
    ["el", /\p{Script=Greek}/u],
    ["ar", /\p{Script=Arabic}/u],
    ["he", /\p{Script=Hebrew}/u],
    ["ko", /\p{Script=Hangul}/u],
    ["ja", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
    ["zh", /\p{Script=Han}/u]
  ];

  const MIN_WORDS = 12; // darunter keine Aussage
  const MIN_SHARE = 0.12; // so viele Funktionswörter braucht es mindestens für eine Sprache

  /**
   * @param {string} text
   * @returns {string} ISO-639-1-Code ("en", "de", ...) oder "" = unklar (zu kurz, gemischt, unbekannte Sprache)
   */
  function detect(text) {
    const letters = text.match(/\p{L}/gu) || [];
    if (letters.length < 20) return "";
    const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
    if (latin < letters.length / 2) {
      // Japanisch vor Chinesisch: japanischer Text enthält fast immer auch Kanji
      const counts = SCRIPTS.map(([lang, re]) => [lang, letters.filter((c) => re.test(c)).length]);
      const ja = counts.find(([l]) => l === "ja");
      if (ja[1] > letters.length * 0.1) return "ja";
      const [lang, n] = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
      return n > letters.length / 2 ? lang : "";
    }

    const words = text.toLowerCase().match(/\p{L}+(?:['’]\p{L}+)?/gu) || [];
    if (words.length < MIN_WORDS) return "";
    let best = "";
    let bestHits = 0;
    let second = 0;
    for (const [lang, set] of Object.entries(SETS)) {
      let hits = 0;
      for (const w of words) if (set.has(w)) hits++;
      if (hits > bestHits) {
        second = bestHits;
        best = lang;
        bestHits = hits;
      } else if (hits > second) {
        second = hits;
      }
    }
    // eindeutig genug: genug Funktionswörter und klar vor der nächsten Sprache (viele Wörter wie "in",
    // "die", "de" gibt es in mehreren Sprachen)
    if (bestHits < words.length * MIN_SHARE || bestHits < second * 1.5) return "";
    return best;
  }

  // Sprachname für Hinweise, z.B. "Deutsch"
  function name(lang) {
    try {
      return new Intl.DisplayNames(["de"], { type: "language" }).of(lang) || lang;
    } catch {
      return lang;
    }
  }

  /**
   * Bevorzugt: die eingebaute Erkennung der Extension-API i18n.detectLanguage - Chrome, Edge, Brave, Opera
   * & Co. nutzen CLD3 (kleines neuronales Modell), Firefox CLD2. >100 Sprachen, kein Download, auch in
   * Content-Scripts, liefert pro Text die Anteile der Sprachen und ob das Ergebnis verlässlich ist.
   * Reihenfolge: Ist die Funktionswort-Heuristik eindeutig, gilt sie - CLD3 irrt bei ungewöhnlichem Text
   * auch „verlässlich“ (sich wiederholender englischer Text: Luxemburgisch). CLD3 füllt die Lücken:
   * Sprachen ohne Funktionswort-Liste, unklare Fälle. Fehlt die API (Tests in Node): nur die Heuristik.
   * @returns {Promise<string>} wie detect()
   */
  async function detectAsync(text) {
    const guess = detect(text);
    if (guess) return guess;
    try {
      const i18n = globalThis.browser?.i18n ?? globalThis.chrome?.i18n; // Firefox: browser.*, Chromium: chrome.*
      const result = await i18n?.detectLanguage?.(text);
      // gemischte Absätze: die Sprache mit dem größten Anteil zählt
      const top = result?.languages?.reduce((a, b) => (b.percentage > a.percentage ? b : a), result.languages[0]);
      if (result?.isReliable && top && top.language !== "und") return top.language.toLowerCase().split("-")[0];
    } catch {
      // verwaistes Content-Script nach Extension-Reload o.ä.
    }
    return "";
  }

  return { detect, detectAsync, name };
})();
