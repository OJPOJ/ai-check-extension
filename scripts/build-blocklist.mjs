// Erzeugt die mitgelieferte Sperrliste extension/generated/blocklist.js aus gepflegten Quellen.
// Läuft vor jeder Auslieferung (`npm run build`), das Ergebnis liegt im Git - so sieht jede
// Aktualisierung im Diff, was neu gesperrt bzw. freigegeben wird, und die Extension läuft ohne Build.
//
// Quellen (Details und Bewertung: RESOURCES.md, „Quellen für die Sperrliste“):
//   UT1-Blacklists, Kategorien bank + webmail  – international, CC BY-SA 4.0, Université Toulouse Capitole
//   FDIC BankFind API                           – alle aktiven US-Banken (Feld WEBADDR), gemeinfrei
//   NCUA Call Report Data                       – alle US-Credit-Unions (Feld Acct_891), gemeinfrei
//   Wikidata (SPARQL)                           – Banken in DE/AT/CH/UK/US mit offizieller Website, CC0
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
// Quartalsdaten erscheinen ca. 2 Monate nach Quartalsende; das Skript nimmt das neueste vorhandene
const NCUA_URL = (yyyy, mm) => `https://ncua.gov/files/publications/analysis/call-report-data-${yyyy}-${mm}.zip`;
const WIKIDATA_URL = "https://query.wikidata.org/sparql";
// Banken (alle Unterklassen von Q22687) in DE, AT, CH, UK, US, die noch existieren. Ausgenommen:
// Zentral-, Förder- und Abwicklungsbanken - keine Kundenkonten, dafür viel lesenswerter Text
// (Reden, Statistiken, Förderprogramme).
const WIKIDATA_QUERY = `
SELECT DISTINCT ?site WHERE {
  VALUES ?country { wd:Q183 wd:Q40 wd:Q39 wd:Q145 wd:Q30 }
  ?bank wdt:P31/wdt:P279* wd:Q22687; wdt:P17 ?country; wdt:P856 ?site.
  FILTER NOT EXISTS { ?bank wdt:P576 [] }
  FILTER NOT EXISTS {
    VALUES ?excluded { wd:Q66344 wd:Q4481787 wd:Q15841019 wd:Q5266746 wd:Q1802186 wd:Q139792508 wd:Q798630 }
    ?bank wdt:P31/wdt:P279* ?excluded.
  }
}`;
// Wikidata-Websites mit Pfad zeigen oft auf fremde Hosts (Stadtportal, Web-Archiv, Dachverband) - nur
// Startseiten und reine Sprachpfade übernehmen, sonst würde z.B. "stadt.de/sparkasse" ganz stadt.de sperren
const HOMEPAGE_PATH = /^\/(?:[a-z]{2}(?:[-_][a-z]{2})?\/?|home(?:\.html?)?|index\.html?|default\.aspx?)?$/i;

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

// Nie sperren, egal aus welcher Quelle. Stand der Prüfung: 2026-09-25, alle Einträge der Liste unter den
// Top 100.000 der Tranco-Liste von Hand durchgesehen (Vorgehen: RESOURCES.md, „Pflege der Sperrliste“).
const NEVER_BLOCK = new Set([
  // Portale mit überwiegend redaktionellem Inhalt (dort nur die Mail-/Login-Subdomains, siehe CURATED)
  "web.de", "gmx.net", "gmx.de", "gmx.com", "t-online.de", "yahoo.com", "aol.com", "msn.com", "live.com",
  // Plattformen, die in FDIC/NCUA als "Website" einer Bank stehen (z.B. deren Facebook-Seite)
  "google.com", "facebook.com", "linkedin.com", "twitter.com", "x.com", "instagram.com", "youtube.com",
  "wikipedia.org", "github.com", "medium.com", "reddit.com", "wordpress.com", "blogspot.com", "wixsite.com",
  "squarespace.com", "godaddysites.com", "sites.google.com", "business.site", "weebly.com", "yolasite.com",
  // UT1 "bank": keine Bank (Händler, Airlines, Konzerne, Behörden, Universität, Post)
  "lowes.com", "purdue.edu", "tesco.com", "tesco.ie", "delta.com", "jal.co.jp", "usairways.com", "iberia.com",
  "mcdonalds.com", "timhortons.com", "macys.com", "walmart.ca", "safeway.com", "wegmans.com", "ica.se",
  "shoppersdrugmart.ca", "staples.ca", "ge.com", "vw.com", "pb.com", "pse.com", "mts.by", "energystar.gov",
  "treasury.gov", "cnpd.pt", "hktdc.com", "fsb.org.uk", "laposte.fr", "poste.it", "postoffice.co.uk",
  "nzpost.co.nz", "magnolia.com", "ocala.com", "statefarm.com",
  // UT1 "bank": Zentralbanken, Förderbanken, Aufsicht - viel Lesetext, keine Kundenkonten
  "bundesbank.de", "banque-france.fr", "bde.es", "nbp.pl", "cbr.ru", "bcb.gov.br", "rbi.org.in", "tcmb.gov.tr",
  "stlouisfed.org", "richmondfed.org", "chicagofed.org", "clevelandfed.org", "dallasfed.org", "fdic.gov",
  "adb.org", "ebrd.com", "banquemondiale.org", "banquedesterritoires.fr",
  // UT1 "bank": Fachmedien, Vergleichsportale, Dienstleister für Banken, Entwickler-Dokumentation
  "bankrate.com", "banki.ru", "thebanker.com", "gfmag.com", "manta.com", "trademarkia.com", "fisglobal.com",
  "fiserv.com", "firstdata.com", "jackhenry.com", "csiweb.com", "six-group.com", "mastercard.com",
  "stripe.com", // Doku ist Lesetext; das Konto (dashboard.stripe.com) steht in CURATED
  // FDIC: Bank gehört zu einem Industriekonzern, die Domain ist dessen Hauptseite
  "deere.com"
]);

// Mindestgrößen: schrumpft eine Quelle drastisch, stimmt etwas nicht - dann lieber abbrechen als eine
// halb leere Sperrliste ausliefern
const MIN_COUNT = { "ut1:bank": 3000, "ut1:webmail": 200, fdic: 3000, ncua: 3000, wikidata: 800 };

const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

function normalize(entry) {
  let s = String(entry || "").trim().toLowerCase();
  if (!s || s.startsWith("#")) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/[/?#:].*$/, "").replace(/\.$/, "").replace(/^www\d?\./, "");
  return HOST_RE.test(s) ? s : null; // verwirft IPs, Tippfehler, leere FDIC-Felder
}

async function fetchOk(url, init = {}) {
  // Wikimedia verlangt einen aussagekräftigen User-Agent
  const headers = { "user-agent": "aivsai-build-blocklist/1.0 (AI Content Flag browser extension)", ...init.headers };
  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return resp;
}

// Minimaler zip-Leser: Zentralverzeichnis am Dateiende, eine Datei per Name (Deflate oder unkomprimiert)
function unzipEntry(buf, name) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("kein zip-Archiv");
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = buf.readUInt16LE(eocd + 10); i > 0; i--) {
    const nameLen = buf.readUInt16LE(off + 28);
    if (buf.toString("utf8", off + 46, off + 46 + nameLen) === name) {
      const local = buf.readUInt32LE(off + 42);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + buf.readUInt32LE(off + 20));
      return buf.readUInt16LE(off + 10) === 8 ? zlib.inflateRawSync(data) : data;
    }
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  throw new Error(`${name} fehlt im Archiv`);
}

// Eine CSV-Zeile mit "..."-Feldern (NCUA: keine Zeilenumbrüche in Feldern)
function csvRow(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
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

// Neueste Quartalsdaten: vom letzten abgeschlossenen Quartal bis zu vier Quartale zurück probieren
async function ncua() {
  const now = new Date();
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3); // 0 = das Vorjahresquartal Q4
  for (let tries = 0; tries < 5; tries++, quarter--) {
    if (quarter < 1) {
      quarter += 4;
      year--;
    }
    const url = NCUA_URL(year, String(quarter * 3).padStart(2, "0"));
    const resp = await fetch(url, { headers: { "user-agent": "aivsai-build-blocklist/1.0" } });
    if (!resp.ok) continue;
    const lines = unzipEntry(Buffer.from(await resp.arrayBuffer()), "FS220D.txt").toString("utf8").split(/\r?\n/);
    const col = csvRow(lines[0]).indexOf("Acct_891"); // "World Wide Website address"
    if (col < 0) throw new Error(`NCUA ${url}: Spalte Acct_891 fehlt`);
    console.log(`ncua         Stand ${year}-${String(quarter * 3).padStart(2, "0")}`);
    return lines.slice(1).map((l) => csvRow(l)[col]);
  }
  throw new Error("NCUA: keine Quartalsdaten der letzten fünf Quartale gefunden");
}

async function wikidata() {
  const resp = await fetchOk(WIKIDATA_URL, {
    method: "POST",
    headers: { accept: "application/sparql-results+json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ query: WIKIDATA_QUERY })
  });
  const sites = (await resp.json()).results.bindings.map((b) => b.site.value);
  return sites.filter((site) => {
    try {
      return HOMEPAGE_PATH.test(new URL(site).pathname);
    } catch {
      return false;
    }
  });
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
  { id: "ncua", load: ncua, license: "Public Domain (US Government)", origin: "NCUA Call Report Data, https://ncua.gov/analysis/credit-union-corporate-call-report-data/quarterly-data" },
  { id: "wikidata", load: wikidata, license: "CC0 1.0", origin: "Wikidata, https://query.wikidata.org/ (Banken DE/AT/CH/UK/US)" },
  { id: "curated", load: async () => CURATED, license: "–", origin: "scripts/build-blocklist.mjs" }
];

// --dump <ordner>: normalisierte Domains pro Quelle als Textdatei - zum Nachsehen, woher ein Eintrag kommt
const dumpDir = process.argv.includes("--dump") ? process.argv[process.argv.indexOf("--dump") + 1] : null;
if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });

const all = [];
const dropped = new Set();
const meta = [];
for (const src of sources) {
  const raw = await src.load();
  const domains = raw.map(normalize).filter(Boolean);
  if (domains.length < (MIN_COUNT[src.id] ?? 0)) {
    throw new Error(`${src.id}: nur ${domains.length} Domains (erwartet >= ${MIN_COUNT[src.id]}) – Quelle prüfen`);
  }
  if (dumpDir) fs.writeFileSync(path.join(dumpDir, `${src.id.replace(":", "-")}.txt`), [...new Set(domains)].sort().join("\n"));
  // "neu" = weder in einer vorherigen Quelle noch von deren Eltern-Domains abgedeckt - zeigt, was eine
  // Quelle wirklich beiträgt
  const before = compact(all);
  for (const d of domains) {
    if (NEVER_BLOCK.has(d)) dropped.add(d);
    else all.push(d);
  }
  const added = compact(all).length - before.length;
  meta.push({ id: src.id, count: new Set(domains).size, added, license: src.license, origin: src.origin });
  console.log(`${src.id.padEnd(12)} ${String(domains.length).padStart(6)} Einträge, ${String(added).padStart(5)} neu`);
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
