// Brevo (official REST API v3). Used for sending AND for analytics – Gmail "Send As" does not provide Brevo analytics, so tracked
// campaigns must be sent through Brevo. The API key lives in chrome.storage.local (secrets), never in page code or IndexedDB.
import type { EmailEventType } from '../core/types';
import type { Fetcher } from '../research/http';
import { HttpError } from '../research/http';

const BASE = 'https://api.brevo.com/v3';
export interface BrevoDeps { fetch: Fetcher; apiKey?: string; base?: string }
const url = (d: BrevoDeps, p: string) => `${(d.base || BASE).replace(/\/$/, '')}${p}`;
const need = (d: BrevoDeps) => { if (!d.apiKey) throw new Error('Add your Brevo API key in Settings → E-mail first.'); return d.apiKey; };

async function call<T = any>(d: BrevoDeps, path: string, init: RequestInit = {}): Promise<T> {
  const res = await d.fetch(url(d, path), { ...init, headers: { accept: 'application/json', 'api-key': need(d), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
  if (!res.ok) {
    let msg = ''; try { const j = await res.json(); msg = j.message || j.code || ''; } catch { /* no body */ }
    if (res.status === 401) throw new Error('Brevo rejected the API key (401). Check it in Settings → E-mail.');
    throw new HttpError(res.status, url(d, path), `Brevo ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  return res.status === 204 ? ({} as T) : res.json();
}

export interface BrevoSender { id: number; name: string; email: string; active: boolean }

export async function listSenders(d: BrevoDeps): Promise<BrevoSender[]> { return (await call<{ senders: BrevoSender[] }>(d, '/senders')).senders || []; }

/** Is this address an ACTIVE sender in the connected Brevo account? (Brevo refuses mail from unverified senders.) */
export async function verifySender(d: BrevoDeps, email: string): Promise<{ ok: boolean; message: string; sender?: BrevoSender }> {
  const senders = await listSenders(d);
  const s = senders.find(x => x.email.toLowerCase() === email.trim().toLowerCase());
  if (!s) return { ok: false, message: `${email} is not a sender in this Brevo account. Add and verify it in Brevo → Senders, domains & dedicated IPs.` };
  if (!s.active) return { ok: false, message: `${email} exists in Brevo but is not active yet – finish its verification in Brevo.` };
  return { ok: true, message: `${email} is an active Brevo sender.`, sender: s };
}

export interface SendArgs { from: { email: string; name?: string }; to: string; subject: string; text: string; html: string; replyTo?: string; tags?: string[] }
export async function sendBrevo(d: BrevoDeps, a: SendArgs): Promise<{ messageId: string }> {
  const r = await call<{ messageId?: string; messageIds?: string[] }>(d, '/smtp/email', {
    method: 'POST',
    body: JSON.stringify({ sender: { email: a.from.email, ...(a.from.name ? { name: a.from.name } : {}) }, to: [{ email: a.to }], subject: a.subject, textContent: a.text, htmlContent: a.html, ...(a.replyTo ? { replyTo: { email: a.replyTo } } : {}), ...(a.tags?.length ? { tags: a.tags } : {}) }),
  });
  const messageId = r.messageId || r.messageIds?.[0] || '';
  if (!messageId) throw new Error('Brevo accepted the request but returned no message id.');
  return { messageId };
}

export interface BrevoEvent { event: string; email?: string; messageId?: string; date?: string; link?: string; reason?: string }
/** Brevo's event names → ours. `loadedByProxy` is Apple Mail Privacy Protection style prefetching: it still counts as "opened", imperfectly. */
export const EVENT_MAP: Record<string, EmailEventType> = { requests: 'sent', request: 'sent', delivered: 'delivered', opened: 'opened', uniqueOpened: 'opened', loadedByProxy: 'opened', clicks: 'clicked', click: 'clicked', unique_clicked: 'clicked', softBounces: 'bounced', soft_bounce: 'bounced', hardBounces: 'bounced', hard_bounce: 'bounced', invalid: 'bounced', invalid_email: 'bounced', blocked: 'blocked', spam: 'spam', unsubscribed: 'unsubscribed', unsubscribe: 'unsubscribed', error: 'failed', deferred: 'sent' };

export async function fetchEvents(d: BrevoDeps, messageId: string): Promise<BrevoEvent[]> {
  const r = await call<{ events?: BrevoEvent[] }>(d, `/smtp/statistics/events?limit=100&sort=asc&messageId=${encodeURIComponent(messageId)}`);
  return r.events || [];
}
