// E-mail analytics: Brevo events → e-mail log → the contact's record. Opens are IMPERFECT (Apple Mail Privacy Protection and
// security scanners load tracking pixels automatically, so some "opens" are machines and some real opens are never counted).
// Gmail sends have no analytics at all – only Brevo does.
import * as DB from '../core/db';
import * as S from '../core/store';
import type { CellValue, EmailEventType, EmailLog } from '../core/types';
import { idOf } from '../core/defaults';
import { getSettings, getSecrets } from '../core/settings';
import { EVENT_MAP, fetchEvents, type BrevoEvent } from './brevo';
import { listEmailLog, suppress, type EmailDeps } from './service';

const RANK: Record<string, number> = { Sent: 1, Delivered: 2, Opened: 3, Clicked: 4 };
const STATUS_OF: Partial<Record<EmailEventType, string>> = { sent: 'Sent', delivered: 'Delivered', opened: 'Opened', clicked: 'Clicked', bounced: 'Bounced', unsubscribed: 'Unsubscribed', spam: 'Unsubscribed', blocked: 'Bounced' };

/** Apply one event to a log row and to the contact. Returns false when the event was already known. */
export async function applyEvent(log: EmailLog, type: EmailEventType, at: string): Promise<boolean> {
  if (log.events.some(e => e.type === type && Math.abs(new Date(e.at).getTime() - new Date(at).getTime()) < 1000)) return false;
  if (['opened', 'clicked'].includes(type) && log.events.some(e => e.type === type) && type === 'opened') { /* repeat opens are kept as events but do not change the flags */ }
  const next: EmailLog = { ...log, events: [...log.events, { type, at }].sort((a, b) => a.at.localeCompare(b.at)) };
  if (type === 'opened') next.opened = true; if (type === 'clicked') { next.clicked = true; next.opened = next.opened ?? true; }
  if (type === 'bounced' || type === 'blocked') next.bounced = true; if (type === 'unsubscribed' || type === 'spam') next.unsubscribed = true;
  const rank = (s: string) => RANK[s] ?? 0; const cur = log.status === 'test' ? 'Sent' : String(log.status[0].toUpperCase() + log.status.slice(1));
  const st = STATUS_OF[type]; if (st && (rank(st) > rank(cur) || !(cur in RANK) || !(st in RANK))) next.status = type === 'spam' ? 'unsubscribed' : type;
  await DB.put('emailLog', next);

  const rec = await S.getRecord(log.recordId); if (!rec) return true;
  const fields = await S.listFields(rec.tableId); const K = (k: string) => idOf(fields, k);
  const cells: Record<string, CellValue> = {}; const day = at.slice(0, 10);
  if (type === 'opened') { if (K('emailOpened')) cells[K('emailOpened')!] = true; if (K('lastOpened')) cells[K('lastOpened')!] = day; }
  if (type === 'clicked') { if (K('emailClicked')) cells[K('emailClicked')!] = true; if (K('lastClicked')) cells[K('lastClicked')!] = day; if (K('emailOpened')) cells[K('emailOpened')!] = true; }
  const statusId = K('emailStatus'); const curStatus = statusId ? String(rec.cells[statusId] ?? '') : '';
  if (st && statusId && (['Bounced', 'Unsubscribed'].includes(st) || rank(st) > rank(curStatus))) cells[statusId] = st;
  if (type === 'unsubscribed' || type === 'spam') { if (K('outreachStatus')) cells[K('outreachStatus')!] = 'Do not contact'; await suppress(log.to); }
  if (type === 'bounced' || type === 'blocked') await suppress(log.to);
  if (Object.keys(cells).length) await S.updateRecord(rec.id, cells);
  return true;
}

export interface SyncResult { checked: number; newEvents: number; errors: string[] }

/** Pull events for every recent Brevo message (works without a webhook; run it from the Analytics page or on a timer). */
export async function syncBrevo(deps: EmailDeps, maxAgeDays = 30): Promise<SyncResult> {
  const settings = deps.settings ?? await getSettings(); const secrets = deps.secrets ?? await getSecrets();
  const res: SyncResult = { checked: 0, newEvents: 0, errors: [] };
  if (!secrets.brevoApiKey) { res.errors.push('No Brevo API key set.'); return res; }
  const cutoff = deps.now().getTime() - maxAgeDays * 86400000;
  const logs = (await listEmailLog()).filter(l => l.provider === 'brevo' && l.messageId && new Date(l.sentAt).getTime() > cutoff && !l.unsubscribed);
  for (const l of logs) {
    res.checked++;
    try {
      const events = await fetchEvents({ fetch: deps.fetch, apiKey: secrets.brevoApiKey, base: settings.apiBases.brevo }, l.messageId!);
      let cur = (await DB.get<EmailLog>('emailLog', l.id)) || l;
      for (const ev of events) { const t = EVENT_MAP[ev.event]; if (!t || t === 'sent') continue; if (await applyEvent(cur, t, ev.date || deps.now().toISOString())) { res.newEvents++; cur = (await DB.get<EmailLog>('emailLog', l.id)) || cur; } }
    } catch (e: any) { res.errors.push(`${l.to}: ${e?.message || e}`); }
  }
  return res;
}

/** Events delivered by the optional webhook backend (Brevo → backend → here). Payload fields follow Brevo's webhook format. */
export async function applyWebhookEvents(events: (BrevoEvent & { 'message-id'?: string })[]): Promise<number> {
  const logs = await listEmailLog(); let n = 0;
  for (const ev of events) {
    const id = ev.messageId || ev['message-id']; const t = EVENT_MAP[ev.event]; if (!id || !t) continue;
    const log = logs.find(l => l.messageId === id); if (!log) continue;
    if (await applyEvent((await DB.get<EmailLog>('emailLog', log.id)) || log, t, ev.date || new Date().toISOString())) n++;
  }
  return n;
}

export async function pullWebhookBackend(deps: EmailDeps): Promise<{ applied: number; error?: string }> {
  const settings = deps.settings ?? await getSettings(); if (!settings.webhookUrl) return { applied: 0, error: 'No webhook backend configured.' };
  try {
    const since = (await DB.kvGet<number>('webhookSince', 0)) || 0;
    const r = await deps.fetch(`${settings.webhookUrl.replace(/\/$/, '')}/events?since=${since}`, { headers: { authorization: `Bearer ${settings.webhookToken}` } });
    if (!r.ok) return { applied: 0, error: `Webhook backend answered HTTP ${r.status}` };
    const j = await r.json(); const applied = await applyWebhookEvents(j.events || []); await DB.kvSet('webhookSince', j.next ?? since); return { applied };
  } catch (e: any) { return { applied: 0, error: `Webhook backend not reachable: ${e?.message || e}` }; }
}

export interface Summary { sent: number; delivered: number; uniqueOpens: number; clicks: number; bounces: number; unsubscribes: number; failed: number; openRate: number; clickRate: number; bounceRate: number }
export function summarize(logs: EmailLog[]): Summary {
  const real = logs.filter(l => l.provider !== 'test' && l.status !== 'test'); const sent = real.filter(l => l.status !== 'failed');
  const has = (l: EmailLog, t: EmailEventType) => l.events.some(e => e.type === t);
  const delivered = sent.filter(l => has(l, 'delivered') || l.opened || l.clicked).length;
  const uniqueOpens = sent.filter(l => l.opened || has(l, 'opened')).length; const clicks = sent.filter(l => l.clicked || has(l, 'clicked')).length;
  const bounces = sent.filter(l => l.bounced).length; const pct = (n: number) => (sent.length ? Math.round((n / sent.length) * 1000) / 10 : 0);
  return { sent: sent.length, delivered, uniqueOpens, clicks, bounces, unsubscribes: sent.filter(l => l.unsubscribed).length, failed: real.length - sent.length, openRate: pct(uniqueOpens), clickRate: pct(clicks), bounceRate: pct(bounces) };
}
