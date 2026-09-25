// Feedback-Sammlung (IndexedDB, eigene Datenbank): Absätze, bei denen die Nutzerin/der Nutzer sagt, woher
// der Text wirklich stammt - Grundlage für Eval-Sets, Kalibrierung und eigenes Fine-Tuning.
//
// Anders als der Score-Speicher enthält sie den TEXT (sonst taugt sie nicht als Trainingsdaten) - deshalb
// nur nach ausdrücklicher Einwilligung (storage.local `feedbackConsentAt`, siehe content.js), nur lokal,
// keine URL, nie automatisch gesendet. Export als JSONL in den Einstellungen.
//
// Pro Text genau ein Eintrag (Schlüssel = Hash über den Text): erneutes Feedback ersetzt das alte.
//   id     128-Bit-SHA-256 über den Text
//   text   genau der Text, den das Modell bewertet hat (bis 2000 Zeichen)
//   label  "human" | "ai" - Angabe der Person
//   basis  "own" (selbst geschrieben/erzeugt, Autor:in bekannt) | "date" (vor 2023 veröffentlicht) |
//          "marked" (als KI gekennzeichnet) | "guess" (nur Eindruck - kein gesichertes Label)
//   p, model  Score und AIVSAI.modelKey zum Zeitpunkt des Feedbacks
//   lang   <html lang> der Seite, source "auto" | "manual" | "selection", at (ms), v (Schema-Version)

const DB_NAME = "aivsai-feedback";
const STORE = "feedback";
const SCHEMA = 1;
const MAX_ENTRIES = 20_000; // ~40 MB bei 2000 Zeichen - weit mehr, als jemand von Hand sammelt

export const LABELS = ["human", "ai"];
export const BASES = ["own", "date", "marked", "guess"];

let dbPromise = null;

function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const committed = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

async function idFor(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest, 0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Prüft und normalisiert einen Eintrag vom Content-Script - dort kann die Seite mitspielen. */
function sanitize(e) {
  const text = typeof e?.text === "string" ? e.text.trim().slice(0, 2000) : "";
  if (!text) throw new Error("Kein Text");
  if (!LABELS.includes(e.label)) throw new Error(`Unbekanntes Label: ${e.label}`);
  if (!BASES.includes(e.basis)) throw new Error(`Unbekannte Grundlage: ${e.basis}`);
  return {
    text,
    label: e.label,
    basis: e.basis,
    p: typeof e.p === "number" && e.p >= 0 && e.p <= 1 ? e.p : null,
    model: String(e.model ?? "").slice(0, 200),
    lang: String(e.lang ?? "").slice(0, 20),
    source: ["auto", "manual", "selection"].includes(e.source) ? e.source : "manual"
  };
}

/** @returns {Promise<string>} id des gespeicherten Eintrags (für "Rückgängig") */
export async function put(entry) {
  const clean = sanitize(entry);
  const id = await idFor(clean.text);
  const db = await openDb();
  if ((await done(db.transaction(STORE).objectStore(STORE).count())) >= MAX_ENTRIES) {
    throw new Error(`Sammlung voll (${MAX_ENTRIES.toLocaleString("de-DE")} Einträge) – bitte exportieren und löschen.`);
  }
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({ id, ...clean, at: Date.now(), v: SCHEMA });
  await committed(tx);
  return id;
}

/** Gespeicherte Angabe zu genau diesem Text oder null - damit das Popover sie zeigen und ändern kann. */
export async function get(text) {
  const clean = typeof text === "string" ? text.trim().slice(0, 2000) : "";
  if (!clean) return null;
  const row = await done((await openDb()).transaction(STORE).objectStore(STORE).get(await idFor(clean)));
  return row ?? null;
}

export async function remove(id) {
  const tx = (await openDb()).transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(String(id));
  await committed(tx);
}

export async function all() {
  const rows = await done((await openDb()).transaction(STORE).objectStore(STORE).getAll());
  return rows.sort((a, b) => a.at - b.at);
}

export async function info() {
  const rows = await all();
  const count = (fn) => rows.filter(fn).length;
  return {
    count: rows.length,
    human: count((r) => r.label === "human"),
    ai: count((r) => r.label === "ai"),
    guess: count((r) => r.basis === "guess"),
    // Modell lag daneben: Mensch, aber >= 50 % bzw. KI, aber < 50 %
    disagree: count((r) => r.p !== null && (r.label === "ai") !== r.p >= 0.5),
    bytes: rows.reduce((n, r) => n + r.text.length * 2 + 200, 0)
  };
}

export async function clear() {
  const tx = (await openDb()).transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  await committed(tx);
}
