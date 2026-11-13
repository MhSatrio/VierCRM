import React, { useEffect, useRef, useState } from 'react';
import * as DB from '../../core/db';
import * as S from '../../core/store';
import { getSecrets, getSettings, mask, saveSecrets, saveSettings, type Secrets, type Settings } from '../../core/settings';
import { Confirm, download, Field_, hasHostAccess, send, useToast } from '../bridge';

export function SettingsPage() {
  const toast = useToast(); const [s, setS] = useState<Settings>(); const [sec, setSec] = useState<Secrets>({}); const [brevo, setBrevo] = useState(''); const [ss, setSs] = useState(''); const [clientId, setClientId] = useState('');
  const [host, setHost] = useState(false); const [wipe, setWipe] = useState(false); const [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge'); const file = useRef<HTMLInputElement>(null);
  const load = async () => { setS(await getSettings()); const x = await getSecrets(); setSec(x); setClientId(x.gmail?.clientId || ''); setHost(await hasHostAccess()); };
  useEffect(() => { void load(); }, []);
  if (!s) return <div className="main muted">Loading…</div>;
  const up = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  const save = async () => { await saveSettings(s); if (brevo.trim()) await saveSecrets({ brevoApiKey: brevo.trim() }); if (ss.trim()) await saveSecrets({ semanticScholarKey: ss.trim() }); await saveSecrets({ gmail: { ...(sec.gmail || {}), clientId: clientId.trim() || undefined } }); setBrevo(''); setSs(''); await load(); toast('Settings saved', 'good'); };
  const redirect = chrome.identity?.getRedirectURL?.() ?? '';
  return (
    <div className="main">
      <div className="page-head"><div><h1>Settings</h1><div className="muted">Everything is stored in this browser. API keys live in Chrome’s extension storage – never in exports, backups or logs.</div></div><button className="primary right" onClick={save}>Save settings</button></div>
      <div className="col">
        <div className="card col"><h2>Publication research</h2>
          <Field_ label="Your e-mail for Unpaywall (required by Unpaywall; sent only to Unpaywall)" hint="Used to look for legal open-access PDFs. Leave empty to skip Unpaywall."><input type="email" value={s.unpaywallEmail} onChange={e => up({ unpaywallEmail: e.target.value })} /></Field_>
          <div className="grid2"><Field_ label="Auto-accept an author match at confidence ≥" hint="Name + institution ≈ 0.8, name alone ≈ 0.5. Below this you are asked to choose."><input type="number" step="0.05" min={0.5} max={1} value={s.autoAcceptConfidence} onChange={e => up({ autoAcceptConfidence: Number(e.target.value) })} /></Field_><Field_ label="… and it must lead the runner-up by"><input type="number" step="0.05" min={0} max={1} value={s.autoAcceptMargin} onChange={e => up({ autoAcceptMargin: Number(e.target.value) })} /></Field_></div>
          <label className="chk"><input type="checkbox" checked={s.institutionalAccess} onChange={e => up({ institutionalAccess: e.target.checked })} />Try publisher PDFs with my own browser session (only works for papers my institution’s subscription legitimately gives me; never bypasses access control)</label>
          <Field_ label="Semantic Scholar API key (optional, avoids rate limits)"><input type="password" placeholder={sec.semanticScholarKey ? mask(sec.semanticScholarKey) : 'not set'} value={ss} onChange={e => setSs(e.target.value)} autoComplete="off" /></Field_>
          <div className="muted small">Sci-Hub and other shadow libraries are deliberately not supported: they distribute copyrighted papers without permission.</div></div>
        <div className="card col"><h2>E-mail</h2>
          <label className="chk"><input type="checkbox" checked={s.sendingEnabled} onChange={e => up({ sendingEnabled: e.target.checked })} /><b>Allow sending</b> – the global switch. While off, nothing is ever sent (previews and test sends still work).</label>
          <div className="grid2"><Field_ label="Default provider"><select value={s.defaultProvider} onChange={e => up({ defaultProvider: e.target.value as 'brevo' | 'gmail' })}><option value="brevo">Brevo</option><option value="gmail">Gmail</option></select></Field_><Field_ label="Default sender address"><input type="text" value={s.defaultSender} onChange={e => up({ defaultSender: e.target.value })} /></Field_><Field_ label="Sender name"><input type="text" value={s.senderName} onChange={e => up({ senderName: e.target.value })} /></Field_><Field_ label="Daily cap"><input type="number" min={1} value={s.dailySendCap} onChange={e => up({ dailySendCap: Number(e.target.value) })} /></Field_><Field_ label="Minimum seconds between e-mails"><input type="number" min={0} value={s.minSendGapSec} onChange={e => up({ minSendGapSec: Number(e.target.value) })} /></Field_></div>
          <Field_ label="Footer added to every e-mail (who you are and how to opt out)"><textarea rows={3} value={s.emailFooter} onChange={e => up({ emailFooter: e.target.value })} /></Field_>
          <div className="note warn">Cold e-mail to people who have not asked for it is regulated (GDPR / ePrivacy in Europe, CAN-SPAM in the US, and others). You are responsible for having a lawful basis, an honest sender identity, a working opt-out and a physical contact address in the footer. VierCRM never writes again to anyone who unsubscribed or bounced.</div>
          <h3>Brevo</h3><Field_ label="API key" hint="Brevo → SMTP & API → API keys. Stored only in this browser's extension storage."><input type="password" placeholder={sec.brevoApiKey ? `saved (${mask(sec.brevoApiKey)}) – type to replace` : 'not set'} value={brevo} onChange={e => setBrevo(e.target.value)} autoComplete="off" /></Field_>
          <h3>Gmail</h3><div className="grid2"><Field_ label="Google OAuth client id" hint="Google Cloud → APIs & Services → Credentials → OAuth client ID (Web application). Enable the Gmail API."><input type="text" value={clientId} onChange={e => setClientId(e.target.value)} /></Field_><Field_ label="Authorised redirect URI to add in Google Cloud"><input type="text" readOnly value={redirect} onFocus={e => e.target.select()} /></Field_></div>
          <div className="row"><button onClick={async () => { await save(); try { const r: any = await send({ type: 'gmail:connect' }); toast(`Connected ${r.email}`, 'good'); await load(); } catch (e: any) { toast(e.message, 'bad'); } }}>Connect Gmail</button>{(sec.gmail?.accounts || []).map(a => <span className="chip" key={a.email}>{a.email}</span>)}</div>
          <h3>Webhook backend (optional)</h3><div className="grid2"><Field_ label="Backend URL" hint="The small server in backend/ that receives Brevo webhooks. Needs a public HTTPS URL (e.g. via a tunnel)."><input type="text" placeholder="https://…" value={s.webhookUrl} onChange={e => up({ webhookUrl: e.target.value })} /></Field_><Field_ label="Backend token"><input type="password" value={s.webhookToken} onChange={e => up({ webhookToken: e.target.value })} autoComplete="off" /></Field_></div></div>
        <div className="card col"><h2>Website access</h2><div className="row"><span className={`chip ${host ? 'good' : 'warn'}`}>{host ? 'Granted' : 'Not granted yet'}</span>
          {!host && <button onClick={async () => { setHost(await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] })); }}>Allow VierCRM to read the sites I scrape</button>}{host && <button onClick={async () => { await chrome.permissions.remove({ origins: ['https://*/*', 'http://*/*'] }); setHost(false); }}>Revoke</button>}</div>
          <div className="muted small">Needed only when you scrape a directory or download an open-access PDF. It is asked for when you start, never at install, and can be revoked here or in chrome://extensions.</div></div>
        <div className="card col"><h2>Data</h2>
          <div className="row"><button onClick={async () => download(`viercrm-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await DB.exportBackup()), 'application/json')}>Download full backup (JSON)</button>
            <input ref={file} type="file" accept="application/json,.json" /><select value={restoreMode} onChange={e => setRestoreMode(e.target.value as 'merge' | 'replace')}><option value="merge">merge into current data</option><option value="replace">replace all current data</option></select>
            <button onClick={async () => { const f = file.current?.files?.[0]; if (!f) return toast('Choose a backup file first.', 'bad'); try { await DB.importBackup(JSON.parse(await f.text()), { replace: restoreMode === 'replace' }); toast('Backup restored', 'good'); } catch (e: any) { toast(e.message, 'bad'); } }}>Restore</button></div>
          <div className="row"><button onClick={async () => toast(`Loaded ${await S.loadSampleData()} sample (fictional) researchers`, 'good')}>Load sample data</button><span className="muted small">Four invented researchers on reserved .example domains, added to the Researchers base – for trying the app without scraping.</span></div>
          <div><button className="danger" onClick={() => setWipe(true)}>Delete all VierCRM data…</button></div></div>
      </div>
      {wipe && <Confirm danger confirmLabel="Delete everything" message="Delete every database, record, file, automation and e-mail log in this browser? Download a backup first if you may need it. API keys are kept." onNo={() => setWipe(false)} onYes={async () => { setWipe(false); await DB.wipeAll(); await S.ensureSeeded(); toast('All data deleted', 'good'); }} />}
    </div>
  );
}
