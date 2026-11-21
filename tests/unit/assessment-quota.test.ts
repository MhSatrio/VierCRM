import { describe, it, expect } from 'vitest';
import { requestQuota } from '../../src/assessment/issuer';

const CFG = { baseUrl: 'http://localhost:3000/', issuerKey: 'k'.repeat(40) };
const STATUS = { dailyCap: 20, usedToday: 13, remainingToday: 7, resetsAt: '2026-11-20T00:00:00.000Z', lastResetAt: null };

describe('assessment token quota', () => {
  it('reads today\'s count with a GET, and restarts it with a POST to /reset', async () => {
    const calls: { url: string; method: string; auth: string }[] = [];
    const io = {
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, method: String(init.method), auth: String((init.headers as Record<string, string>).Authorization) });
        return new Response(JSON.stringify(STATUS), { status: 200 });
      },
    };
    const read = await requestQuota(io, CFG, false);
    expect(read).toEqual(STATUS);
    await requestQuota(io, CFG, true);
    expect(calls[0]).toEqual({ url: 'http://localhost:3000/api/issuer/quota', method: 'GET', auth: `Bearer ${CFG.issuerKey}` });
    expect(calls[1]).toEqual({ url: 'http://localhost:3000/api/issuer/quota/reset', method: 'POST', auth: `Bearer ${CFG.issuerKey}` });
  });

  it('refuses to run without a server address or an issuer key', async () => {
    const io = { fetch: async () => new Response('{}', { status: 200 }) };
    await expect(requestQuota(io, { baseUrl: '', issuerKey: 'k' }, false)).rejects.toThrow(/server address/);
    await expect(requestQuota(io, { baseUrl: CFG.baseUrl, issuerKey: '  ' }, true)).rejects.toThrow(/issuer key/);
  });

  it('shows the server\'s refusal in words a person can act on', async () => {
    const refused = { fetch: async () => new Response('{}', { status: 401 }) };
    await expect(requestQuota(refused, CFG, true)).rejects.toThrow(/refused the issuer key/);
    const unconfigured = { fetch: async () => new Response('{}', { status: 503 }) };
    await expect(requestQuota(unconfigured, CFG, false)).rejects.toThrow(/TOKEN_ISSUER_KEY/);
  });
});
