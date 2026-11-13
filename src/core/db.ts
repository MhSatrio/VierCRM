// IndexedDB persistence. One database for the whole extension; the same code runs in the service worker, in extension pages and (with
// fake-indexeddb) in Node tests. Designed so a cloud-sync layer can later replicate by `updatedAt` per store.

export const DB_NAME = 'viercrm';
export const DB_VERSION = 1;

/** store name → key path and indexes */
const STORES: Record<string, { key: string; indexes?: Record<string, string> }> = {
  workspaces: { key: 'id' },
  databases: { key: 'id', indexes: { workspaceId: 'workspaceId' } },
  tables: { key: 'id', indexes: { databaseId: 'databaseId' } },
  fields: { key: 'id', indexes: { tableId: 'tableId' } },
  records: { key: 'id', indexes: { tableId: 'tableId' } },
  views: { key: 'id', indexes: { tableId: 'tableId' } },
  configs: { key: 'id' },                       // scraping configurations
  automations: { key: 'id', indexes: { tableId: 'tableId' } },
  runs: { key: 'id', indexes: { automationId: 'automationId', at: 'at' } },
  templates: { key: 'id' },
  emailLog: { key: 'id', indexes: { recordId: 'recordId' } },
  files: { key: 'id' },                         // attachment blobs
  pending: { key: 'id', indexes: { runAt: 'runAt' } },
  kv: { key: 'key' },
};
export type StoreName = keyof typeof STORES;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name, { keyPath: def.key });
        for (const [idx, path] of Object.entries(def.indexes || {})) os.createIndex(idx, path);
      }
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => reject(new Error('Database upgrade blocked by another open tab'));
  });
  return dbPromise;
}

/** Test helper: forget the cached connection after deleting the database. */
export function _resetForTests() { dbPromise = null; }

const wrap = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

async function tx<T>(stores: string | string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await openDb();
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error('transaction aborted')); });
  const result = await fn(t);
  await done;
  return result;
}

export const get = <T = any>(store: StoreName, key: IDBValidKey): Promise<T | undefined> => tx(store, 'readonly', t => wrap(t.objectStore(store).get(key)));
export const put = <T = any>(store: StoreName, value: T): Promise<T> => tx(store, 'readwrite', async t => { await wrap(t.objectStore(store).put(value)); return value; });
export const del = (store: StoreName, key: IDBValidKey): Promise<void> => tx(store, 'readwrite', async t => { await wrap(t.objectStore(store).delete(key)); });
export const all = <T = any>(store: StoreName): Promise<T[]> => tx(store, 'readonly', t => wrap(t.objectStore(store).getAll()));
/** The first `limit` rows of an index value – returns at once, whatever the size of the store. */
export const byIndexHead = <T = any>(store: StoreName, index: string, value: IDBValidKey, limit: number): Promise<T[]> => tx(store, 'readonly', t => wrap(t.objectStore(store).index(index).getAll(value, limit)));
export const count = (store: StoreName): Promise<number> => tx(store, 'readonly', t => wrap(t.objectStore(store).count()));
export const countByIndex = (store: StoreName, index: string, value: IDBValidKey): Promise<number> => tx(store, 'readonly', t => wrap(t.objectStore(store).index(index).count(value)));
export const clear = (store: StoreName): Promise<void> => tx(store, 'readwrite', async t => { await wrap(t.objectStore(store).clear()); });
export const byIndex = <T = any>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]> => tx(store, 'readonly', t => wrap(t.objectStore(store).index(index).getAll(value)));

export async function putMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (!values.length) return;
  await tx(store, 'readwrite', t => { const os = t.objectStore(store); for (const v of values) os.put(v); });
}
export async function delMany(store: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (!keys.length) return;
  await tx(store, 'readwrite', t => { const os = t.objectStore(store); for (const k of keys) os.delete(k); });
}

// ---------------------------------------------------------------- key-value helpers
export async function kvGet<T = any>(key: string, fallback: T | null = null): Promise<T | null> { const row = await get<{ key: string; value: T }>('kv', key); return row ? row.value : fallback; }
export const kvSet = <T = any>(key: string, value: T) => put('kv', { key, value, updatedAt: new Date().toISOString() });

// ---------------------------------------------------------------- whole-database backup / restore
const BACKUP_STORES = ['workspaces', 'databases', 'tables', 'fields', 'records', 'views', 'configs', 'automations', 'runs', 'templates', 'emailLog', 'pending', 'kv'] as const;

const toB64 = (buf: ArrayBuffer) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s: string) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out.buffer; };

export async function exportBackup() {
  const out: Record<string, any> = { app: 'VierCRM', version: DB_VERSION, exportedAt: new Date().toISOString() };
  for (const s of BACKUP_STORES) out[s] = await all(s);
  out.files = (await all<{ id: string; data: ArrayBuffer }>('files')).map(f => ({ ...f, data: toB64(f.data) }));
  return out;
}

export async function importBackup(dump: any, { replace = false } = {}) {
  if (!dump || dump.app !== 'VierCRM') throw new Error('This is not a VierCRM backup file.');
  if (replace) for (const s of [...BACKUP_STORES, 'files'] as StoreName[]) await clear(s);
  for (const s of BACKUP_STORES) await putMany(s, dump[s] || []);
  await putMany('files', (dump.files || []).map((f: any) => ({ ...f, data: fromB64(f.data) })));
}

export async function wipeAll() { for (const s of Object.keys(STORES) as StoreName[]) await clear(s); }
