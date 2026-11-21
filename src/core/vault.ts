// Encrypts the API keys and sign-in tokens before they are written to the extension's storage (AES-GCM, 256 bit).
//
// What this protects: the files of the Chrome profile, a copy of them, a backup or a screenshot of the storage view no longer show
// a readable key. What it does NOT protect: the key to open the vault is kept on the same computer (in this extension's own
// database, as a non-extractable key), so someone who can run code as you, or who controls this extension, can still use it.
// It is a safeguard against casual exposure, not against malware.
//
// Pure of chrome.*: it takes plain JSON and returns a plain JSON envelope; the caller decides where to keep it.

export interface VaultEnvelope { v: 1; iv: string; data: string }

const DB_NAME = 'viercrm-vault';
const STORE = 'keys';
const KEY_ID = 'device';

const b64 = (buf: ArrayBuffer | Uint8Array) => { const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
let keyPromise: Promise<CryptoKey> | null = null;
/** The device key: made once, kept as a non-extractable CryptoKey (its bytes cannot be read back by script). */
export function deviceKey(): Promise<CryptoKey> {
  return (keyPromise ??= (async () => {
    const db = await openKeyDb();
    try {
      // A candidate is made first, then ONE transaction keeps the stored key or stores the candidate: two pages starting at the same
      // moment (side panel and service worker) end up with the same key instead of each writing its own.
      const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      return await new Promise<CryptoKey>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite'); const st = tx.objectStore(STORE);
        const g = st.get(KEY_ID);
        let chosen: CryptoKey = candidate;
        g.onsuccess = () => { if (g.result) chosen = g.result as CryptoKey; else st.put(candidate, KEY_ID); };
        tx.oncomplete = () => resolve(chosen); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  })());
}
/** For tests: forget the cached key (the stored one stays). */
export const _resetVaultForTests = () => { keyPromise = null; };

export async function encryptJson(value: unknown): Promise<VaultEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deviceKey(), new TextEncoder().encode(JSON.stringify(value)));
  return { v: 1, iv: b64(iv), data: b64(data) };
}

/** Throws when the envelope was changed or was made with another key (AES-GCM checks both). */
export async function decryptJson<T = unknown>(env: VaultEnvelope): Promise<T> {
  if (!env || env.v !== 1 || typeof env.iv !== 'string' || typeof env.data !== 'string') throw new Error('Not a vault envelope.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, await deviceKey(), unb64(env.data));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export const isEnvelope = (x: unknown): x is VaultEnvelope => !!x && typeof x === 'object' && (x as VaultEnvelope).v === 1 && typeof (x as VaultEnvelope).iv === 'string' && typeof (x as VaultEnvelope).data === 'string';
