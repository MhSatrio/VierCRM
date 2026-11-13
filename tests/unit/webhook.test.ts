import 'fake-indexeddb/auto';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error – plain JS module
import { createWebhookServer } from '../../backend/webhook-server.mjs';
import * as S from '../../src/core/store';
import * as DB from '../../src/core/db';
import { fid, TABLE_ID } from '../../src/core/defaults';
import { applyWebhookEvents, pullWebhookBackend } from '../../src/email/analytics';
import { DEFAULT_SETTINGS } from '../../src/core/settings';

let server: any; let base = ''; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viercrm-hook-'));
beforeAll(async () => { server = createWebhookServer({ dir, token: 'tok-123', secret: 'sec-456' }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; await S.ensureSeeded(); });
afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(body) });

describe('webhook backend', () => {
  it('accepts Brevo events only with the secret in the URL, and serves them only with the bearer token', async () => {
    expect((await post('/brevo/webhook/wrong', { event: 'opened' })).status).toBe(403);
    expect((await post('/brevo/webhook/sec-456', { event: 'opened', email: 'a@b.example', 'message-id': '<m1@smtp>', date: '2026-11-04T10:00:00Z' })).status).toBe(200);
    expect((await post('/brevo/webhook/sec-456', [{ event: 'click', 'message-id': '<m1@smtp>', link: 'https://x.example' }, { notAnEvent: true }])).status).toBe(200);
    expect((await fetch(`${base}/events`)).status).toBe(401);
    const r = await (await fetch(`${base}/events?since=0`, { headers: { authorization: 'Bearer tok-123' } })).json();
    expect(r.events.map((e: any) => e.event)).toEqual(['opened', 'click']); expect(r.events[0]).toMatchObject({ seq: 1, messageId: '<m1@smtp>', email: 'a@b.example' }); expect(r.next).toBe(2);
    expect((await (await fetch(`${base}/events?since=2`, { headers: { authorization: 'Bearer tok-123' } })).json()).events).toEqual([]);
    expect((await fetch(`${base}/brevo/webhook/sec-456`, { method: 'POST', body: '{not json' })).status).toBe(400);
  });
  it('events survive a restart', async () => {
    const again = createWebhookServer({ dir, token: 'tok-123', secret: 'sec-456' }); await new Promise<void>(r => again.listen(0, '127.0.0.1', r)); const b = `http://127.0.0.1:${again.address().port}`;
    expect((await (await fetch(`${b}/events?since=0`, { headers: { authorization: 'Bearer tok-123' } })).json()).events).toHaveLength(2); again.close();
  });
  it('the extension turns pulled events into contact updates and remembers where it stopped', async () => {
    const rec = await S.createRecord(TABLE_ID, { [fid('fullName')]: 'Hook Person', [fid('email')]: 'hook@x.example' }, { silent: true });
    await DB.put('emailLog', { id: 'mail_hook', recordId: rec.id, tableId: TABLE_ID, to: 'hook@x.example', subject: 's', provider: 'brevo', from: 'info@vierapparatus.com', messageId: '<m1@smtp>', sentAt: '2026-11-04T09:00:00Z', status: 'sent', events: [{ type: 'sent', at: '2026-11-04T09:00:00Z' }] });
    const deps = { fetch: (u: string, i?: RequestInit) => fetch(u, i), now: () => new Date(), settings: { ...DEFAULT_SETTINGS, webhookUrl: base, webhookToken: 'tok-123' } };
    const r = await pullWebhookBackend(deps); expect(r.error).toBeUndefined(); expect(r.applied).toBe(2);
    const after = (await S.getRecord(rec.id))!; expect(after.cells[fid('emailOpened')]).toBe(true); expect(after.cells[fid('emailClicked')]).toBe(true); expect(after.cells[fid('emailStatus')]).toBe('Clicked');
    expect((await pullWebhookBackend(deps)).applied).toBe(0);                                      // nothing new, nothing repeated
    expect(await applyWebhookEvents([{ event: 'opened', 'message-id': '<unknown@smtp>' } as any])).toBe(0);
    expect((await pullWebhookBackend({ ...deps, settings: { ...deps.settings, webhookToken: 'bad' } })).error).toMatch(/401/);
  });
});
