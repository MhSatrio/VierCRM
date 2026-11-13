// Settings (plain, in IndexedDB) and secrets (API keys / OAuth tokens, in chrome.storage.local only – never in IndexedDB, backups,
// CSV exports, logs or page code). `storage` is injectable so tests run without a browser.
import { kvGet, kvSet } from './db';

export interface Settings {
  /** Override any API base URL (used by the tests to point at a local fake server; leave empty in normal use). */
  apiBases: { openalex?: string; crossref?: string; semanticscholar?: string; pubmed?: string; unpaywall?: string; europepmc?: string; scholar?: string; researchgate?: string; brevo?: string; gmail?: string };
  /** Unpaywall requires a contact e-mail on every request – it is YOUR address, sent only to Unpaywall. */
  unpaywallEmail: string;
  /** a name-only match is never trusted: this is the confidence a candidate needs (and a lead over the runner-up) to be chosen without asking */
  autoAcceptConfidence: number; autoAcceptMargin: number;
  institutionalAccess: boolean;          // try publisher PDFs with YOUR browser session (only what you are authorised to read)
  lookupDelayMs: number;
  maxPdfMb: number;
  // e-mail
  sendingEnabled: boolean;               // global kill switch – nothing is sent while false
  dailySendCap: number; minSendGapSec: number;
  emailFooter: string;                   // appended to every e-mail: who you are + how to opt out
  defaultProvider: 'brevo' | 'gmail';
  defaultSender: string; senderName: string;
  webhookUrl: string; webhookToken: string;  // optional: the small backend that receives Brevo webhooks
  brevoSyncMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBases: {}, unpaywallEmail: '', autoAcceptConfidence: 0.75, autoAcceptMargin: 0.2, institutionalAccess: false, lookupDelayMs: 400, maxPdfMb: 40,
  sendingEnabled: false, dailySendCap: 40, minSendGapSec: 30,
  emailFooter: 'VierApparatus · https://vierapparatus.com\nIf you would rather not hear from us, reply "unsubscribe" and we will not write again.',
  defaultProvider: 'brevo', defaultSender: 'info@vierapparatus.com', senderName: 'VierApparatus', webhookUrl: '', webhookToken: '', brevoSyncMinutes: 15,
};

export async function getSettings(): Promise<Settings> {
  const s = await kvGet<Partial<Settings>>('settings', {});
  return { ...DEFAULT_SETTINGS, ...(s || {}), apiBases: { ...(s?.apiBases || {}) } };
}
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await kvSet('settings', next); return next;
}

// ------------------------------------------------------------------ secrets
export interface Secrets {
  brevoApiKey?: string;
  semanticScholarKey?: string;
  gmail?: { clientId?: string; accounts?: GmailAccount[] };
}
export interface GmailAccount { email: string; accessToken: string; expiresAt: number; sendAs?: { email: string; name?: string; verified: boolean }[] }

export interface SecretStorage { get(): Promise<Secrets>; set(s: Secrets): Promise<void> }
let storage: SecretStorage = {
  async get() { const r = await (globalThis as any).chrome?.storage?.local?.get('secrets'); return (r?.secrets as Secrets) || {}; },
  async set(s) { await (globalThis as any).chrome?.storage?.local?.set({ secrets: s }); },
};
export const setSecretStorage = (s: SecretStorage) => { storage = s; };
export const getSecrets = () => storage.get();
export async function saveSecrets(patch: Partial<Secrets>) { const next = { ...(await storage.get()), ...patch }; await storage.set(next); return next; }

/** For logs and the UI: never show more than the last 4 characters of a key. */
export const mask = (s?: string) => (!s ? '' : s.length <= 8 ? '••••' : `••••${s.slice(-4)}`);
