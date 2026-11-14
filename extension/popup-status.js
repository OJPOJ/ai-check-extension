// Status line of the popup: the sentence under the counters that says what is going on on this page.
// Pure decisions from the tab's address, the settings and the content script's stats, so they can be tested
// without a browser. Classic script like config.js, result in globalThis.AIVSAI_STATUS.
globalThis.AIVSAI_STATUS = (() => {
  // Pages where the browser never runs content scripts, although they are http(s)
  const isWebStore = (url) =>
    url.hostname === "chromewebstore.google.com" ||
    (url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"));

  // What the tab's address says, once per popup: host, http(s) page the extension can run on, ".pdf" address
  function page(address) {
    try {
      const url = new URL(address);
      return {
        host: url.hostname,
        supported: /^https?:$/.test(url.protocol) && !isWebStore(url),
        isPdf: /^(https?|file):$/.test(url.protocol) && /\.pdf$/i.test(url.pathname)
      };
    } catch {
      return { host: "", supported: false, isPdf: false };
    }
  }

  // What the popup offers for this tab - renderSite() shows exactly this, the status line only points to it:
  //   pdf        PDF tab (the PDF section says what to do there)
  //   reason     blocklist reason from the settings ("user" / "builtin") or null
  //   sensitive  the content script found a password/payment field
  //   canScan    "Scan page now" is enabled
  //   showSwitch the per-site switch is visible (checked and greyed out in "all" mode)
  //   canSwitch  the switch can still turn automatic scanning on for this site
  function controls({ host, supported, isPdf }, config, { pdfByContentType = false, stats = null } = {}) {
    const reason = supported ? AIVSAI.blockReason(host, config) : null;
    const pdf = isPdf || pdfByContentType;
    const sensitive = stats?.blockReason === "sensitive";
    const scannable = supported && !reason && !pdf && !sensitive;
    const showSwitch = scannable && config.scanMode !== "manual";
    const approved = config.scanMode === "all" || AIVSAI.siteMatches(host, config.sites || []);
    return {
      supported,
      pdf,
      reason,
      sensitive,
      canScan: scannable && config.enabled,
      showSwitch,
      canSwitch: showSwitch && config.enabled && config.scanMode === "sites" && !approved
    };
  }

  function message(stats, config, controls = {}) {
    if (!config.enabled) return "The extension is switched off – turn it on with the switch at the top.";
    if (!stats) {
      // no content script answered: PDF viewer not ready, browser pages, policy-blocked hosts,
      // or a tab older than the install - only the last one is helped by a reload, so say it conditionally
      if (controls.pdf) return "";
      if (!controls.supported) return "Nothing can be scanned on this kind of page.";
      return "This page does not answer. If it was open before the extension was installed or updated, reload it once.";
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
    const nothing = !stats.red && !stats.yellow && !stats.green && !stats.uncertain;
    // a PDF has no paragraphs in the page itself: the PDF section says what to do
    if (controls.pdf && nothing) return "";
    if (stats.active && nothing) return "No sufficiently long paragraphs of text found.";
    if (stats.blocked) {
      return stats.blockReason === "sensitive"
        ? "Password or payment field found – this page is not scanned. Check single passages via right-click."
        : "This site is on the blocklist and is not scanned. “Remove from blocklist” allows it, or check single passages via right-click.";
    }
    if (!stats.active) {
      if (controls.canSwitch) {
        return "This site is not approved for automatic scanning. Switch it on above, or press “Scan page now”.";
      }
      if (controls.canScan) {
        return config.scanMode === "manual"
          ? "Automatic scanning is off. Press “Scan page now” to check this page."
          : "Not scanned yet. Press “Scan page now” to check this page.";
      }
      return controls.pdf ? "" : "Not active on this page.";
    }
    if (stats.red || stats.yellow) return "Click “flagged” or “unclear” to jump to the paragraphs.";
    return "";
  }

  return { page, controls, message };
})();
