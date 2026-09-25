// Plausibilität der mitgelieferten Sperrliste (extension/generated/blocklist.js, erzeugt von
// scripts/build-blocklist.mjs): Format, das builtinMatch voraussetzt, und Stichproben in beide Richtungen.
// Schlägt nach `npm run build:blocklist` etwas fehl, den Diff der Liste prüfen, nicht den Test anpassen.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

await import("../../extension/generated/blocklist.js");
await import("../../extension/models.js");
await import("../../extension/config.js");
const { domains, count, generated, sources } = globalThis.AIVSAI_BLOCKLIST;
const list = domains.split("\n").slice(1, -1);
const blocked = (host) => globalThis.AIVSAI.builtinMatch(host) !== null;

describe("mitgelieferte Sperrliste", () => {
  it("Format: \\n-getrennt mit \\n an beiden Enden, sortiert, eindeutig, count stimmt", () => {
    assert.ok(domains.startsWith("\n") && domains.endsWith("\n"));
    assert.equal(list.length, count);
    assert.equal(new Set(list).size, list.length);
    assert.deepEqual(list, [...list].sort());
    assert.match(generated, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(sources.length >= 5 && sources.every((s) => s.id && s.license && s.origin));
  });

  it("nur gültige Hostnamen in Kleinschreibung, ohne www", () => {
    const host = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;
    const bad = list.filter((d) => !host.test(d) || /^www\d?\./.test(d));
    assert.deepEqual(bad, []);
  });

  it("keine Subdomain neben ihrer Eltern-Domain (Liste ist kompakt)", () => {
    const set = new Set(list);
    const covered = list.filter((d) => {
      for (let p = d.slice(d.indexOf(".") + 1); p.includes("."); p = p.slice(p.indexOf(".") + 1)) {
        if (set.has(p)) return true;
      }
      return false;
    });
    assert.deepEqual(covered, []);
  });

  it("Umfang im erwarteten Bereich (fängt eine halb leere oder explodierte Liste ab)", () => {
    assert.ok(count > 10_000 && count < 30_000, String(count));
  });

  it("sperrt Banking, Zahlungsdienste und Webmail", () => {
    for (const host of [
      "www.sparkasse.de", "banking.dkb.de", "www.paypal.com", "secure.chase.com", "mail.google.com",
      "outlook.live.com", "navigator.gmx.net", "www.elster.de", "dashboard.stripe.com"
    ]) {
      assert.ok(blocked(host), host);
    }
  });

  it("sperrt keine Inhaltsseiten (auch nicht die Portale hinter gesperrten Mail-Subdomains)", () => {
    for (const host of [
      "de.wikipedia.org", "www.google.com", "news.google.com", "github.com", "www.youtube.com", "www.reddit.com",
      "medium.com", "web.de", "www.gmx.net", "www.t-online.de", "www.yahoo.com", "stripe.com", "docs.stripe.com",
      "www.bundesbank.de", "www.spiegel.de", "www.bbc.co.uk", "www.nytimes.com", "www.heise.de"
    ]) {
      assert.ok(!blocked(host), host);
    }
  });
});
