// Persistent score store (IndexedDB) so that scores survive a restart of the service worker or
// browser - with desklib every paragraph costs ~1 s of compute time, with cloud backends money.
//
// Deliberately neither text nor URL is stored, only:
//   k  = SHA-256 (truncated to 128 bits) over provider signature + text
//   p  = AI probability (raw value of the model)
//   m  = AIVSAI.modelKey, e.g. "browser:tmr"
//   at = time of the scoring (ms) - the retention period is based on it
// Measured ~235 bytes per entry on disk (50,000 entries = 11.7 MB).

const DB_NAME = "aivsai";
const STORE = "scores";
const MAX_ENTRIES = 200_000; // Emergency brake independent of the retention period (~47 MB)
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
    dbPromise = null; // try again next time
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

/** @returns {Promise<Map<string, number>>} key -> score, only for found, non-expired entries */
export async function getMany(keys, retentionDays) {
  const store = (await openDb()).transaction(STORE).objectStore(STORE);
  const oldest = Date.now() - retentionDays * DAY_MS;
  const rows = await Promise.all(keys.map((k) => done(store.get(k))));
  const found = new Map();
  // do not use expired entries any more, even if the cleanup round is still pending
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

/** Deletes everything older than the retention period and enforces the upper limit. */
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
 * Number of entries and estimated space. Deliberately not navigator.storage.estimate(): IndexedDB only frees
 * deleted entries on later compaction - right after "Delete all" it would still
 * show the old megabytes.
 */
export async function info() {
  const count = await done((await openDb()).transaction(STORE).objectStore(STORE).count());
  return { count, bytes: count * BYTES_PER_ENTRY };
}
