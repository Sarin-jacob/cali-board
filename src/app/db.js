// Minimal IndexedDB wrapper. Falls back to memory when IndexedDB is unavailable (some private modes),
// so the app keeps working — data just won't survive a reload.

const DB_NAME = 'caliboard';
const DB_VERSION = 1;
export const STORES = { calibrations: 'calibrations', sessions: 'sessions' };

let dbPromise = null;
const memory = new Map(Object.values(STORES).map((s) => [s, new Map()]));
export let persistent = true;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { persistent = false; resolve(null); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { persistent = false; resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { persistent = false; resolve(null); };
    req.onblocked = () => { persistent = false; resolve(null); };
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

export async function dbPut(store, value) {
  const db = await open();
  if (!db) { memory.get(store).set(value.id, value); return value; }
  await tx(db, store, 'readwrite', (s) => s.put(value));
  return value;
}

export async function dbGet(store, id) {
  const db = await open();
  if (!db) return memory.get(store).get(id) ?? null;
  return (await tx(db, store, 'readonly', (s) => s.get(id))) ?? null;
}

export async function dbAll(store) {
  const db = await open();
  if (!db) return [...memory.get(store).values()];
  return (await tx(db, store, 'readonly', (s) => s.getAll())) ?? [];
}

export async function dbDelete(store, id) {
  const db = await open();
  if (!db) { memory.get(store).delete(id); return; }
  await tx(db, store, 'readwrite', (s) => s.delete(id));
}

/** Rough storage usage (bytes) if the browser exposes it. */
export async function storageEstimate() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}
