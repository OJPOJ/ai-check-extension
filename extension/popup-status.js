// Status line of the popup: the sentence under the counters that says what is going on on this page.
// Pure decision from the content script's stats and the settings, so it can be tested without a browser.
// Classic script like config.js, result in globalThis.AIVSAI_STATUS.
globalThis.AIVSAI_STATUS = (() => {
  // `controls` = what the popup offers for this tab, as popup.js computes it for renderSite():
  //   supported  http(s) page, pdf  PDF tab (the PDF section says what to do there),
  //   canScan    "Scan page now" is enabled, canSwitch  the per-site switch is visible
  // The line only points to controls that are actually there.
  function message(stats, config, controls = {}) {
    if (!config.enabled) return "The extension is switched off – turn it on with the switch at the top.";
    if (!stats) {
      // no content script answered: PDF viewer not ready, browser pages, or a tab older than the install
      if (controls.pdf) return "";
      if (!controls.supported) return "Nothing can be scanned on this kind of page.";
      return "Reload the page once, then try again.";
    }
    if (stats.error) return `Error: ${stats.error}`;
    if (stats.pending) return `${stats.pending} paragraph(s) being checked…`;
    if (stats.deferred) return `${stats.deferred} more paragraphs will be checked on scrolling.`;
    if (stats.skipped) {
      const langs = AIVSAI.languages(config);
      return (
        `${stats.skipped} paragraph(s) in another language not scored` +
        (langs ? ` – the model only knows ${langs.map(AIVSAI_LANG.name).join(", ")}.` : ".")
      );
    }
    if (stats.active && !stats.red && !stats.yellow && !stats.green && !stats.uncertain) {
      return "No sufficiently long paragraphs of text found.";
    }
    if (stats.blocked) {
      return stats.blockReason === "sensitive"
        ? "Password or payment field found – this page is not scanned. Check single passages via right-click."
        : "This site is on the blocklist and is not scanned. “Remove from blocklist” allows it, or check single passages via right-click.";
    }
    if (!stats.active) {
      if (controls.canSwitch) {
        return "This site is not approved for automatic scanning. Switch it on above, or press “Scan page now”.";
      }
      if (controls.canScan) return "Automatic scanning is off. Press “Scan page now” to check this page.";
      return controls.pdf ? "" : "Not active on this page.";
    }
    if (stats.red || stats.yellow) return "Click “flagged” or “unclear” to jump to the paragraphs.";
    return "";
  }

  return { message };
})();
