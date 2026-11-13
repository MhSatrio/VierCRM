// Sending one e-mail to one record, with every guard rail in one place:
//   global kill switch · valid recipient · do-not-contact / bounced / unsubscribed · duplicate (same template to same record) ·
//   daily cap + minimum gap · verified sender · a footer with an opt-out line · a log row for analytics.
// Test mode renders the exact e-mail and logs it, but sends NOTHING.
import * as DB from '../core/db';
import * as S from '../core/store';
import type { CellValue, EmailLog, EmailTemplate, Field, RecordRow } from '../core/types';
import { computeRecord, cellText, templateLookup } from '../core/values';
import { renderTemplate, textToHtml } from '../core/template';
import { idOf } from '../core/defaults';
import { getSecrets, getSettings, type Secrets, type Settings } from '../core/settings';
import type { Fetcher } from '../research/http';
import { sendBrevo, verifySender } from './brevo';
import { canSendAs, sendGmail } from './gmail';

export interface EmailDeps { fetch: Fetcher; now: () => Date; settings?: Settings; secrets?: Secrets }

export const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const BLOCKED_OUTREACH = new Set(['Do not contact', 'Not interested']);
const BLOCKED_EMAIL = new Set(['Bounced', 'Unsubscribed']);

export const getTemplates = async () => (await DB.all<EmailTemplate>('templates')).sort((a, b) => (a.id === 'tpl_intro' ? -1 : b.id === 'tpl_intro' ? 1 : a.createdAt.localeCompare(b.createdAt)));
export const saveTemplate = (t: EmailTemplate) => DB.put('templates', { ...t, updatedAt: new Date().toISOString() });
export const deleteTemplate = (id: string) => DB.del('templates', id);
export const listEmailLog = async () => (await DB.all<EmailLog>('emailLog')).sort((a, b) => b.sentAt.localeCompare(a.sentAt));

export const getSuppressed = async () => new Set<string>((await DB.kvGet<string[]>('suppressed', [])) || []);
export async function suppress(email: string) { const s = await getSuppressed(); s.add(email.toLowerCase()); await DB.kvSet('suppressed', [...s]); }

export interface Preview { to: string; subject: string; text: string; html: string; missing: string[]; unknown: string[]; usedFallback: string[]; problems: string[] }

/** Exactly what would be sent for this record – used by the preview pane and by sending itself. */
export function renderEmail(tpl: EmailTemplate, fields: Field[], rec: RecordRow, settings: Settings, toFieldId: string | undefined = idOf(fields, 'email')): Preview {
  const { values } = computeRecord(fields, rec); const look = templateLookup(fields, values);
  const subj = renderTemplate(tpl.subject, look); const body = renderTemplate(tpl.body, look);
  const text = settings.emailFooter.trim() ? `${body.text}\n\n--\n${settings.emailFooter.trim()}` : body.text;
  const to = toFieldId ? cellText(values[toFieldId]).trim() : '';
  const problems: string[] = [];
  if (!to) problems.push('This contact has no e-mail address.'); else if (!EMAIL_RE.test(to)) problems.push(`“${to}” is not a valid e-mail address.`);
  const unknown = [...new Set([...subj.unknown, ...body.unknown])]; if (unknown.length) problems.push(`The template uses fields this table does not have: ${unknown.join(', ')}.`);
  return { to, subject: subj.text, text, html: textToHtml(text), missing: [...new Set([...subj.missing, ...body.missing])], unknown, usedFallback: [...new Set([...subj.usedFallback, ...body.usedFallback])], problems };
}

export type SendOutcome = { status: 'sent' | 'test' | 'skipped' | 'error'; message: string; log?: EmailLog; preview?: Preview };

const verifiedCache = new Map<string, number>();
/** Sender verification is cached for 10 minutes; call this after changing the API key or sender. */
export const clearSenderCache = () => verifiedCache.clear();

export interface SendArgs { recordId: string; templateId: string; providerId?: 'brevo' | 'gmail'; senderEmail?: string; toFieldId?: string; automationId?: string; testMode?: boolean; toOverride?: string; gmailAccount?: string }

export async function sendRecordEmail(deps: EmailDeps, a: SendArgs): Promise<SendOutcome> {
  const settings = deps.settings ?? await getSettings(); const secrets = deps.secrets ?? await getSecrets();
  const rec = await S.getRecord(a.recordId); if (!rec) return { status: 'error', message: 'Record not found' };
  const tpl = (await getTemplates()).find(t => t.id === a.templateId); if (!tpl) return { status: 'error', message: 'E-mail template not found' };
  const fields = await S.listFields(rec.tableId);
  const preview = renderEmail(tpl, fields, rec, settings, a.toFieldId || idOf(fields, 'email'));
  if (a.toOverride) preview.to = a.toOverride;
  if (preview.problems.length && !a.toOverride) return { status: 'skipped', message: preview.problems[0], preview };
  const providerId = a.providerId || settings.defaultProvider; const from = { email: a.senderEmail || settings.defaultSender, name: settings.senderName || undefined };
  const now = deps.now(); const base: Omit<EmailLog, 'status' | 'provider'> = { id: S.uid('mail'), recordId: rec.id, tableId: rec.tableId, to: preview.to, subject: preview.subject, from: from.email, sentAt: now.toISOString(), templateId: tpl.id, automationId: a.automationId, events: [] };

  if (a.testMode) { const log: EmailLog = { ...base, provider: 'test', status: 'test' }; await DB.put('emailLog', log); return { status: 'test', message: `TEST – would send “${preview.subject}” to ${preview.to} from ${from.email} via ${providerId}. Nothing was sent.`, log, preview }; }

  const { values } = computeRecord(fields, rec); const outreachId = idOf(fields, 'outreachStatus'), statusId = idOf(fields, 'emailStatus');
  if (!a.toOverride) {
    if (!settings.sendingEnabled) return { status: 'skipped', message: 'Sending is switched off (Settings → E-mail → “Allow sending”).', preview };
    if (outreachId && BLOCKED_OUTREACH.has(cellText(values[outreachId]))) return { status: 'skipped', message: `Outreach Status is “${cellText(values[outreachId!])}”.`, preview };
    if ((statusId && BLOCKED_EMAIL.has(cellText(values[statusId]))) || (await getSuppressed()).has(preview.to.toLowerCase())) return { status: 'skipped', message: `${preview.to} bounced or unsubscribed – it will not be written to again.`, preview };
    const logs = await listEmailLog();
    if (logs.some(l => l.recordId === rec.id && l.templateId === tpl.id && l.status !== 'failed' && l.status !== 'test')) return { status: 'skipped', message: 'This template was already sent to this contact.', preview };
    const real = logs.filter(l => l.provider !== 'test' && l.status !== 'failed');
    const today = now.toISOString().slice(0, 10);
    if (real.filter(l => l.sentAt.slice(0, 10) === today).length >= settings.dailySendCap) return { status: 'skipped', message: `Daily limit of ${settings.dailySendCap} e-mails reached.`, preview };
    const last = real[0]; if (last && now.getTime() - new Date(last.sentAt).getTime() < settings.minSendGapSec * 1000) return { status: 'skipped', message: `Minimum ${settings.minSendGapSec}s between e-mails – try again shortly.`, preview };
  }

  try {
    let messageId = '';
    if (providerId === 'brevo') {
      const bd = { fetch: deps.fetch, apiKey: secrets.brevoApiKey, base: settings.apiBases.brevo };
      const ck = verifiedCache.get(from.email); if (!ck || now.getTime() - ck > 600000) { const v = await verifySender(bd, from.email); if (!v.ok) return { status: 'error', message: v.message, preview }; verifiedCache.set(from.email, now.getTime()); }
      messageId = (await sendBrevo(bd, { from, to: preview.to, subject: preview.subject, text: preview.text, html: preview.html, tags: ['viercrm'] })).messageId;
    } else {
      const accts = secrets.gmail?.accounts || []; const acct = accts.find(x => x.email === a.gmailAccount) || accts.find(x => canSendAs(x, from.email).ok);
      if (!acct) return { status: 'error', message: `No connected Gmail account can send as ${from.email}. Connect it in Settings → E-mail.`, preview };
      messageId = (await sendGmail({ fetch: deps.fetch, now: () => now.getTime(), base: settings.apiBases.gmail }, acct, { from, to: preview.to, subject: preview.subject, text: preview.text, html: preview.html })).messageId;
    }
    const log: EmailLog = { ...base, provider: providerId, status: 'sent', messageId, events: [{ type: 'sent', at: base.sentAt }] };
    await DB.put('emailLog', log);
    if (!a.toOverride) await markSent(rec, fields, log);
    return { status: 'sent', message: `Sent to ${preview.to} via ${providerId === 'brevo' ? 'Brevo' : 'Gmail'}`, log, preview };
  } catch (e: any) {
    const log: EmailLog = { ...base, provider: providerId, status: 'failed', events: [{ type: 'failed', at: base.sentAt }] }; await DB.put('emailLog', log);
    return { status: 'error', message: String(e?.message || e), log, preview };
  }
}

async function markSent(rec: RecordRow, fields: Field[], log: EmailLog) {
  const K = (k: string) => idOf(fields, k); const cells: Record<string, CellValue> = {};
  if (K('emailSent')) cells[K('emailSent')!] = true; if (K('emailStatus')) cells[K('emailStatus')!] = 'Sent';
  const o = K('outreachStatus'); if (o && (!rec.cells[o] || rec.cells[o] === 'Not Contacted')) cells[o] = 'Contacted';
  await S.updateRecord(rec.id, cells, { meta: { emails: [...(rec.meta?.emails || []), log.id] }, origin: log.automationId ? { automationId: log.automationId, chain: [log.automationId], depth: 1 } : undefined });
}
