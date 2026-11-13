// Gmail API: OAuth (Chrome identity), Send As identities and sending. Needs YOUR Google Cloud OAuth client id (type "Web application",
// redirect URI = the one shown in Settings → E-mail). This part has NOT been exercised against a real Google account – see the docs.
//
// Gmail gives no open / click analytics. A "Send As" alias (e.g. info@vierapparatus.com configured in Gmail) can send through Gmail,
// but tracked campaigns must go through Brevo.
import type { Fetcher } from '../research/http';
import { getSecrets, saveSecrets, type GmailAccount } from '../core/settings';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.settings.basic', 'https://www.googleapis.com/auth/userinfo.email'];
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailDeps { fetch: Fetcher; now: () => number; base?: string }

export const buildAuthUrl = (clientId: string, redirectUri: string) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: clientId, response_type: 'token', redirect_uri: redirectUri, scope: GMAIL_SCOPES.join(' '), include_granted_scopes: 'true', prompt: 'select_account' })}`;

export function parseAuthRedirect(redirect: string): { accessToken: string; expiresIn: number } {
  const frag = new URLSearchParams(new URL(redirect).hash.replace(/^#/, ''));
  if (frag.get('error')) throw new Error(`Google sign-in failed: ${frag.get('error')}`);
  const accessToken = frag.get('access_token'); if (!accessToken) throw new Error('Google did not return an access token.');
  return { accessToken, expiresIn: Number(frag.get('expires_in') || 3600) };
}

/** Interactive sign-in through chrome.identity. Returns the connected account (token kept in chrome.storage.local only). */
export async function connectGmail(d: GmailDeps, interactive = true): Promise<GmailAccount> {
  const secrets = await getSecrets(); const clientId = secrets.gmail?.clientId;
  if (!clientId) throw new Error('Paste your Google OAuth client id in Settings → E-mail first.');
  const chromeApi = (globalThis as any).chrome; if (!chromeApi?.identity) throw new Error('chrome.identity is not available here.');
  const redirect: string = await chromeApi.identity.launchWebAuthFlow({ url: buildAuthUrl(clientId, chromeApi.identity.getRedirectURL()), interactive });
  const { accessToken, expiresIn } = parseAuthRedirect(redirect);
  const me = await (await d.fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${accessToken}` } })).json();
  const acct: GmailAccount = { email: me.email, accessToken, expiresAt: d.now() + (expiresIn - 60) * 1000 };
  acct.sendAs = await listSendAs(d, acct);
  const accounts = [...(secrets.gmail?.accounts || []).filter(a => a.email !== acct.email), acct];
  await saveSecrets({ gmail: { ...secrets.gmail, accounts } });
  return acct;
}

const auth = (a: GmailAccount) => ({ authorization: `Bearer ${a.accessToken}` });

export async function listSendAs(d: GmailDeps, a: GmailAccount) {
  const res = await d.fetch(`${d.base || API}/settings/sendAs`, { headers: auth(a) });
  if (!res.ok) throw new Error(`Gmail refused the Send As list (HTTP ${res.status}). Make sure the gmail.settings.basic scope was granted.`);
  const j = await res.json();
  return (j.sendAs || []).map((s: any) => ({ email: String(s.sendAsEmail), name: s.displayName as string | undefined, verified: s.verificationStatus === 'accepted' || s.isPrimary === true }));
}

/** May this Gmail account send as `from`? (Primary address, or a verified Send As alias.) */
export function canSendAs(a: GmailAccount, from: string): { ok: boolean; message: string } {
  const f = from.trim().toLowerCase();
  if (a.email.toLowerCase() === f) return { ok: true, message: 'primary address' };
  const s = (a.sendAs || []).find(x => x.email.toLowerCase() === f);
  if (!s) return { ok: false, message: `${from} is not a Send As identity of ${a.email}. Add and verify it in Gmail → Settings → Accounts.` };
  return s.verified ? { ok: true, message: 'verified Send As alias' } : { ok: false, message: `${from} is configured in Gmail but not verified yet.` };
}

const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(unescape(encodeURIComponent(s)))}?=`);

export function buildMime(a: { from: { email: string; name?: string }; to: string; subject: string; text: string; html: string; replyTo?: string }): string {
  const boundary = `vc_${Math.random().toString(36).slice(2)}`;
  const body = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${a.from.name ? `${encHeader(a.from.name)} ` : ''}<${a.from.email}>`, `To: ${a.to}`, ...(a.replyTo ? [`Reply-To: ${a.replyTo}`] : []), `Subject: ${encHeader(a.subject)}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', body(a.text),
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', body(a.html), `--${boundary}--`, '',
  ].join('\r\n');
}

export async function sendGmail(d: GmailDeps, a: GmailAccount, m: { from: { email: string; name?: string }; to: string; subject: string; text: string; html: string; replyTo?: string }): Promise<{ messageId: string }> {
  if (a.expiresAt <= d.now()) throw new Error(`The Gmail sign-in for ${a.email} expired. Reconnect it in Settings → E-mail.`);
  const chk = canSendAs(a, m.from.email); if (!chk.ok) throw new Error(chk.message);
  const res = await d.fetch(`${d.base || API}/messages/send`, { method: 'POST', headers: { ...auth(a), 'content-type': 'application/json' }, body: JSON.stringify({ raw: b64url(buildMime(m)) }) });
  if (!res.ok) { let msg = ''; try { msg = (await res.json()).error?.message || ''; } catch { /* */ } throw new Error(`Gmail ${res.status}${msg ? `: ${msg}` : ''}`); }
  return { messageId: (await res.json()).id || '' };
}
