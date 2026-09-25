// Dauerhafter Score-Speicher (IndexedDB), damit Bewertungen einen Neustart des Service Workers bzw.
// Browsers überleben - bei desklib kostet jeder Absatz ~1 s Rechenzeit, bei Cloud-Backends Geld.
//
// Gespeichert wird bewusst weder Text noch URL, nur:
//   k  = SHA-256 (gekürzt auf 128 Bit) über Provider-Signatur + Text
//   p  = KI-Wahrscheinlichkeit (Rohwert des Modells)
//   m  = AIVSAI.modelKey, z.B. "browser:tmr"
//   at = Zeitpunkt der Bewertung (ms) - danach richtet sich die Aufbewahrungsdauer
// Gemessen ~235 Byte pro Eintrag auf der Platte (50.000 Einträge = 11,7 MB).

const DB_NAME = "aivsai";
const STORE = "scores";
const MAX_ENTRIES = 200_000; // Notbremse unabhängig von der Aufbewahrungsdauer (~47 MB)
const BYTES_PER_ENTRY = 235;
const DAY_MS = 24 * 60 * 60 * 1000;

let dbPromise = null;

function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "k" }).createIndex("at", "at");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null; // beim nächsten Mal neu versuchen
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

export async function keyFor(sig, text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${sig}\u0002${text}`));
  return Array.from(new Uint8Array(digest, 0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** @returns {Promise<Map<string, number>>} Schlüssel -> Score, nur für gefundene, nicht abgelaufene Einträge */
export async function getMany(keys, retentionDays) {
  const store = (await openDb()).transaction(STORE).objectStore(STORE);
  const oldest = Date.now() - retentionDays * DAY_MS;
  const rows = await Promise.all(keys.map((k) => done(store.get(k))));
  const found = new Map();
  // abgelaufene Einträge nicht mehr verwenden, auch wenn die Aufräumrunde noch aussteht
  for (const row of rows) if (row && row.at >= oldest) found.set(row.k, row.p);
  return found;
}

/** @param {{k: string, p: number, m: string}[]} entries */
export async function putMany(entries) {
  const tx = (await openDb()).transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const at = Date.now();
  for (const e of entries) store.put({ ...e, at });
  await committed(tx);
}

async function deleteOldest(store, count) {
  let deleted = 0;
  const cursorReq = store.index("at").openCursor();
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || deleted >= count) return resolve();
      cursor.delete();
      deleted++;
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

/** Löscht alles, was älter als die Aufbewahrungsdauer ist, und hält die Obergrenze ein. */
export async function prune(retentionDays) {
  if (retentionDays <= 0) return clear();
  const tx = (await openDb()).transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const expired = IDBKeyRange.upperBound(Date.now() - retentionDays * DAY_MS, true);
  const cursorReq = store.index("at").openKeyCursor(expired);
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve();
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  const excess = (await done(store.count())) - MAX_ENTRIES;
  if (excess > 0) await deleteOldest(store, excess);
  await committed(tx);
}

export async function clear() {
  const tx = (await openDb()).transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  await committed(tx);
}

/**
 * Anzahl Einträge und geschätzter Platz. Bewusst nicht navigator.storage.estimate(): IndexedDB gibt
 * gelöschte Einträge erst beim späteren Kompaktieren frei - direkt nach "Alle löschen" stünden dort
 * noch die alten Megabytes.
 */
export async function info() {
  const count = await done((await openDb()).transaction(STORE).objectStore(STORE).count());
  return { count, bytes: count * BYTES_PER_ENTRY };
}
