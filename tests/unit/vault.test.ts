import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { decryptJson, encryptJson, isEnvelope, _resetVaultForTests } from '../../src/core/vault';
import { getSecrets, saveSecrets } from '../../src/core/settings';

/** A stand-in for chrome.storage.local that remembers what was really written. */
function fakeChrome() {
  const data: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: { local: {
      async get(keys: string[] | string) { const ks = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(ks.filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
      async set(o: Record<string, unknown>) { Object.assign(data, structuredClone(o)); },
      async remove(k: string) { delete data[k]; },
    } },
  };
  return data;
}

describe('vault', () => {
  beforeEach(() => { _resetVaultForTests(); });

  it('encrypts and decrypts, with a new random IV each time and no readable text in the envelope', async () => {
    const secret = { brevoApiKey: 'xkeysib-SECRET-1234', gmail: { accounts: [{ email: 'a@b.test', accessToken: 'tok-ABC' }] } };
    const a = await encryptJson(secret); const b = await encryptJson(secret);
    expect(isEnvelope(a)).toBe(true);
    expect(a.iv).not.toBe(b.iv); expect(a.data).not.toBe(b.data);
    expect(JSON.stringify(a)).not.toContain('SECRET'); expect(JSON.stringify(a)).not.toContain('tok-ABC');
    expect(await decryptJson(a)).toEqual(secret);
  });

  it('refuses an envelope that was changed (AES-GCM checks the contents) and a malformed one', async () => {
    const env = await encryptJson({ k: 'v' });
    const bytes = Uint8Array.from(atob(env.data), c => c.charCodeAt(0)); bytes[0] ^= 1;
    await expect(decryptJson({ ...env, data: btoa(String.fromCharCode(...bytes)) })).rejects.toBeTruthy();
    await expect(decryptJson({ v: 2 } as any)).rejects.toThrow(/vault envelope/);
  });

  it('keeps the same device key across restarts (a fresh module state reads the stored key)', async () => {
    const env = await encryptJson({ n: 1 });
    _resetVaultForTests();                                           // as after a restart of the service worker
    expect(await decryptJson(env)).toEqual({ n: 1 });
  });
});

describe('secrets in the extension storage', () => {
  beforeEach(() => { _resetVaultForTests(); });

  it('saves keys encrypted: the storage holds no readable key and the old plain entry is removed', async () => {
    const data = fakeChrome();
    await saveSecrets({ brevoApiKey: 'xkeysib-PLAINTEXT-9999', assessmentIssuerKey: 'issuer-key-ABCDEF' });
    expect(JSON.stringify(data)).not.toContain('PLAINTEXT'); expect(JSON.stringify(data)).not.toContain('issuer-key');
    expect('secrets' in data).toBe(false); expect(isEnvelope(data.secretsV1)).toBe(true);
    expect(await getSecrets()).toMatchObject({ brevoApiKey: 'xkeysib-PLAINTEXT-9999', assessmentIssuerKey: 'issuer-key-ABCDEF' });
  });

  it('a patch keeps the other keys', async () => {
    fakeChrome();
    await saveSecrets({ brevoApiKey: 'b' }); await saveSecrets({ semanticScholarKey: 's' });
    expect(await getSecrets()).toEqual({ brevoApiKey: 'b', semanticScholarKey: 's' });
  });

  it('keys saved by an earlier version (readable) are encrypted on the first read and the readable copy is deleted', async () => {
    const data = fakeChrome();
    data.secrets = { brevoApiKey: 'legacy-readable-key' };
    expect(await getSecrets()).toEqual({ brevoApiKey: 'legacy-readable-key' });
    expect('secrets' in data).toBe(false); expect(JSON.stringify(data)).not.toContain('legacy-readable-key');
    expect(await getSecrets()).toEqual({ brevoApiKey: 'legacy-readable-key' });        // and it still reads back
  });

  it('when the stored keys cannot be decrypted the screens get an empty set instead of an error', async () => {
    const data = fakeChrome();
    await saveSecrets({ brevoApiKey: 'x' });
    (data.secretsV1 as any).data = 'AAAA' + (data.secretsV1 as any).data.slice(4);   // damaged
    expect(await getSecrets()).toEqual({});
  });

  it('works without chrome.storage (unit tests of other modules): empty and no error', async () => {
    delete (globalThis as any).chrome;
    expect(await getSecrets()).toEqual({});
    await expect(saveSecrets({ brevoApiKey: 'x' })).resolves.toBeTruthy();
  });
});
