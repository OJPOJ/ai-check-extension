// Erzeugt die mitgelieferte Sperrliste extension/generated/blocklist.js aus gepflegten Quellen.
// Läuft vor jeder Auslieferung (`npm run build`), das Ergebnis liegt im Git - so sieht jede
// Aktualisierung im Diff, was neu gesperrt bzw. freigegeben wird, und die Extension läuft ohne Build.
//
// Quellen (Details und Bewertung: RESOURCES.md, „Quellen für die Sperrliste“):
//   UT1-Blacklists, Kategorien bank + webmail  – international, CC BY-SA 4.0, Université Toulouse Capitole
//   FDIC BankFind API                           – alle aktiven US-Banken (Feld WEBADDR), gemeinfrei
//   CURATED (unten)                             – Mail, Zahlungsdienste, Behördenportale DE/UK/US
//
// Bewusst nicht: UT1 „financial“ (Börsen-News, also genau lesenswerter Text), ganze Portale wie
// web.de/gmx.net (dort nur die Mail-Subdomains, die News sollen scanbar bleiben).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")));
const out = path.join(root, "extension", "generated", "blocklist.js");

const UT1_URL = (cat) => `https://dsi.ut-capitole.fr/blacklists/download/${cat}.tar.gz`;
const FDIC_URL = "https://api.fdic.gov/banks/institutions?filters=ACTIVE:1&fields=WEBADDR&limit=10000&format=json";

// Handverlesen: was die Listen nicht (oder zu grob) abdecken
const CURATED = [
  // Mail
  "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com",
  "mail.proton.me", "account.proton.me", "navigator.gmx.net", "navigator.gmx.com", "navigator.web.de",
  "email.t-online.de", "posteo.de", "mailbox.org", "app.tuta.com", "icloud.com", "app.fastmail.com",
  "mail.aol.com", "mail.zoho.com", "mail.zoho.eu",
  // Zahlungsdienste, Neobanken, Broker
  "paypal.com", "paypal.de", "klarna.com", "wise.com", "revolut.com", "n26.com", "dashboard.stripe.com",
  "venmo.com", "cash.app", "trade-republic.com", "app.traderepublic.com", "scalable.capital",
  "robinhood.com", "coinbase.com",
  // Banken DE/UK/US mit mehreren Domains bzw. Online-Banking auf Subdomains
  "sparkasse.de", "sparkasse-online.de", "s-login.de", "banking.dkb.de", "ing.de", "comdirect.de",
  "commerzbank.de", "deutsche-bank.de", "meine.deutsche-bank.de", "postbank.de", "consorsbank.de",
  "hypovereinsbank.de", "targobank.de", "volksbank.de", "vr.de", "banking.vr.de", "psd-bank.de",
  "santander.de", "norisbank.de", "1822direkt.de", "gls-bank.de",
  "barclays.co.uk", "lloydsbank.com", "halifax-online.co.uk", "natwest.com", "rbs.co.uk", "hsbc.co.uk",
  "santander.co.uk", "nationwide.co.uk", "monzo.com", "starlingbank.com", "tsb.co.uk", "firstdirect.com",
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "capitalone.com", "usbank.com",
  "discover.com", "americanexpress.com", "schwab.com", "fidelity.com", "vanguard.com",
  // Behörden- und Gesundheitsportale mit Login (die Info-Seiten derselben Behörden bleiben scanbar)
  "elster.de", "id.bund.de", "portal.gkv.de", "login.gov", "sa.www4.irs.gov", "ssa.gov",
  "healthcare.gov", "access.service.gov.uk", "account.hmrc.gov.uk", "online.hmrc.gov.uk"
];

// Ganze Portale, die über eine Quelle hereinkommen, aber vor allem lesenswerte Inhalte haben.
// Außerdem Sicherheitsnetz gegen Plattform-Domains, die in FDIC-Einträgen stehen (z.B. Facebook-Seite als Website).
const NEVER_BLOCK = new Set([
  "web.de", "gmx.net", "gmx.de", "gmx.com", "bankrate.com", "t-online.de", "yahoo.com", "aol.com", "msn.com", "live.com",
  "google.com", "facebook.com", "linkedin.com", "twitter.com", "x.com", "instagram.com", "youtube.com",
  "wikipedia.org", "github.com", "medium.com", "reddit.com", "wordpress.com", "blogspot.com", "wixsite.com",
  "squarespace.com", "godaddysites.com", "sites.google.com", "business.site", "weebly.com", "yolasite.com"
]);

// Mindestgrößen: schrumpft eine Quelle drastisch, stimmt etwas nicht - dann lieber abbrechen als eine
// halb leere Sperrliste ausliefern
const MIN_COUNT = { "ut1:bank": 3000, "ut1:webmail": 200, fdic: 3000 };

const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

function normalize(entry) {
  let s = String(entry || "").trim().toLowerCase();
  if (!s || s.startsWith("#")) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/[/?#:].*$/, "").replace(/\.$/, "").replace(/^www\d?\./, "");
  return HOST_RE.test(s) ? s : null; // verwirft IPs, Tippfehler, leere FDIC-Felder
}

async function fetchOk(url) {
  const resp = await fetch(url, { headers: { "user-agent": "aivsai-build-blocklist" } });
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return resp;
}

// Minimaler tar-Leser (ustar): 512-Byte-Header, Name bei 0, Größe oktal bei 124, Daten auf 512 aufgerundet
function untar(buf) {
  const files = new Map();
  for (let off = 0; off + 512 <= buf.length; ) {
    const name = buf.toString("utf8", off, off + 100).replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(buf.toString("utf8", off + 124, off + 136).replace(/\0.*$/s, "").trim() || "0", 8);
    files.set(name, buf.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function ut1(category) {
  const tgz = Buffer.from(await (await fetchOk(UT1_URL(category))).arrayBuffer());
  const files = untar(zlib.gunzipSync(tgz));
  const domains = [...files].find(([name]) => name.endsWith(`${category}/domains`))?.[1];
  if (!domains) throw new Error(`UT1 ${category}: keine domains-Datei im Archiv (${[...files.keys()].join(", ")})`);
  return domains.toString("utf8").split(/\r?\n/);
}

async function fdic() {
  const json = await (await fetchOk(FDIC_URL)).json();
  if (json.meta?.total > json.data.length) throw new Error(`FDIC: nur ${json.data.length} von ${json.meta.total} geladen`);
  return json.data.map((d) => d.data.WEBADDR);
}

// Einträge, deren Eltern-Domain schon drin ist, sind überflüssig (Subdomains sind eingeschlossen)
function compact(domains) {
  const set = new Set(domains);
  const covered = (d) => {
    for (let i = d.indexOf("."); i !== -1 && d.indexOf(".", i + 1) !== -1; i = d.indexOf(".", i + 1)) {
      if (set.has(d.slice(i + 1))) return true;
    }
    return false;
  };
  return [...set].filter((d) => !covered(d)).sort();
}

const sources = [
  { id: "ut1:bank", load: () => ut1("bank"), license: "CC BY-SA 4.0", origin: "Université Toulouse Capitole, https://dsi.ut-capitole.fr/blacklists/" },
  { id: "ut1:webmail", load: () => ut1("webmail"), license: "CC BY-SA 4.0", origin: "Université Toulouse Capitole, https://dsi.ut-capitole.fr/blacklists/" },
  { id: "fdic", load: fdic, license: "Public Domain (US Government)", origin: "FDIC BankFind Suite, https://api.fdic.gov/banks/docs/" },
  { id: "curated", load: async () => CURATED, license: "–", origin: "scripts/build-blocklist.mjs" }
];

const all = [];
const dropped = new Set();
const meta = [];
for (const src of sources) {
  const raw = await src.load();
  const domains = raw.map(normalize).filter(Boolean);
  if (domains.length < (MIN_COUNT[src.id] ?? 0)) {
    throw new Error(`${src.id}: nur ${domains.length} Domains (erwartet >= ${MIN_COUNT[src.id]}) – Quelle prüfen`);
  }
  for (const d of domains) {
    if (NEVER_BLOCK.has(d)) dropped.add(d);
    else all.push(d);
  }
  meta.push({ id: src.id, count: new Set(domains).size, license: src.license, origin: src.origin });
  console.log(`${src.id.padEnd(12)} ${String(domains.length).padStart(6)} Einträge`);
}

const domains = compact(all);
const generated = new Date().toISOString().slice(0, 10);
const header =
  `// ERZEUGT von scripts/build-blocklist.mjs (npm run build:blocklist) - nicht von Hand ändern.\n` +
  `// Mitgelieferte Sperrliste: Domains, auf denen nie automatisch gescannt wird (Subdomains eingeschlossen).\n` +
  `// Enthält Daten der UT1-Blacklists (Université Toulouse Capitole, CC BY-SA 4.0) - diese Liste steht\n` +
  `// deshalb ebenfalls unter CC BY-SA 4.0. Quellen und Stand: siehe \`sources\`.\n`;
// Ein String statt Array: parst schneller und braucht als Content-Script auf jeder Seite weniger Speicher
const body =
  `globalThis.AIVSAI_BLOCKLIST = {\n` +
  `  generated: ${JSON.stringify(generated)},\n` +
  `  sources: ${JSON.stringify(meta, null, 2).replace(/\n/g, "\n  ")},\n` +
  `  count: ${domains.length},\n` +
  `  domains: ${JSON.stringify(`\n${domains.join("\n")}\n`)}\n` +
  `};\n`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, header + body);
console.log(`\n${domains.length} Domains -> ${path.relative(root, out)} (${(Buffer.byteLength(body) / 1e3).toFixed(0)} KB)`);
if (dropped.size) console.log(`nicht übernommen (NEVER_BLOCK): ${[...dropped].sort().join(", ")}`);
