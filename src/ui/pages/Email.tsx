import React, { useEffect, useMemo, useState } from 'react';
import * as DB from '../../core/db';
import * as S from '../../core/store';
import type { EmailLog, EmailTemplate } from '../../core/types';
import { idOf } from '../../core/defaults';
import { cellText } from '../../core/values';
import { getSecrets, getSettings, type Secrets, type Settings } from '../../core/settings';
import { renderEmail, getTemplates, saveTemplate, deleteTemplate, listEmailLog } from '../../email/service';
import { summarize } from '../../email/analytics';
import { newAutomation, saveAutomation } from '../../automation/engine';
import { Confirm, Field_, fmtTime, send, useAsync, useBase, useBases, useTable, useToast } from '../bridge';

export function Email() {
  const toast = useToast(); const { tables } = useBases(); const [tableId, setTableId] = useBase('email', tables, t => t.template === 'contacts' || t.template === 'researchers'); const data = useTable(tableId); const { data: templates, reload } = useAsync(getTemplates, []); const { data: settings } = useAsync(getSettings, []); const { data: secrets, reload: reloadSecrets } = useAsync(getSecrets, []);
  const [sel, setSel] = useState<string | null>(null); const [tpl, setTpl] = useState<EmailTemplate | null>(null); const [recId, setRecId] = useState(''); const [testTo, setTestTo] = useState(''); const [confirmReal, setConfirmReal] = useState(false);
  const [provider, setProvider] = useState<'brevo' | 'gmail'>('brevo'); const [sender, setSender] = useState('info@vierapparatus.com'); const [verify, setVerify] = useState<{ ok: boolean; msg: string } | null>(null); const [viewId, setViewId] = useState('');
  useEffect(() => { if (settings) { setProvider(settings.defaultProvider); setSender(settings.defaultSender); } }, [settings]);
  useEffect(() => { if (!sel && templates?.length) setSel(templates[0].id); }, [templates, sel]);
  useEffect(() => { setTpl(templates?.find(t => t.id === sel) ?? null); }, [sel, templates]);
  const emailId = idOf(data.fields, 'email'); const nameId = data.fields.find(f => f.primary)?.id ?? idOf(data.fields, 'fullName');
  const withMail = useMemo(() => (emailId ? data.records.filter(r => cellText(r.cells[emailId])).slice(0, 200) : []), [data.records, emailId]);
  useEffect(() => { setRecId(''); setViewId(''); }, [tableId]);
  useEffect(() => { if (!recId && withMail.length) setRecId(withMail[0].id); }, [withMail, recId]);
  const rec = data.records.find(r => r.id === recId);
  const preview = tpl && rec && settings ? renderEmail(tpl, data.fields, rec, settings) : null;
  const save = async () => { if (tpl) { await saveTemplate(tpl); reload(); toast('Template saved', 'good'); } };
  const addTemplate = async () => { const t = new Date().toISOString(); const n: EmailTemplate = { id: S.uid('tpl'), name: 'New template', subject: 'Hello {First Name | fallback: there}', body: 'Hi {First Name | fallback: Researcher},\n\n…\n\nBest regards,\nVierApparatus', createdAt: t, updatedAt: t }; await saveTemplate(n); await reload(); setSel(n.id); };
  const sendTest = async (real: boolean) => {
    if (!tpl || !rec) return;
    try { const r: any = await send({ type: 'email:send', recordId: rec.id, templateId: tpl.id, providerId: provider, senderEmail: sender, testMode: !real, toOverride: real ? testTo.trim() : undefined }); toast(r.outcome.message, r.outcome.status === 'error' ? 'bad' : 'good'); }
    catch (e: any) { toast(e.message, 'bad'); }
  };
  const verifyBrevo = async () => { try { const r: any = await send({ type: 'email:verifyBrevo', sender }); setVerify(r.result ? { ok: r.result.ok, msg: r.result.message } : { ok: false, msg: r.error }); } catch (e: any) { setVerify({ ok: false, msg: e.message }); } };
  const connectGmail = async () => { try { const r: any = await send({ type: 'gmail:connect' }); toast(`Connected ${r.email}${r.sendAs?.length ? ` · ${r.sendAs.length} Send As identities` : ''}`, 'good'); reloadSecrets(); } catch (e: any) { toast(e.message, 'bad'); } };
  const makeAutomation = async () => {
    if (!tpl) return; const view = data.views.find(v => v.id === viewId) ?? data.views.find(v => v.name === 'Ready for Outreach') ?? data.views[0]; const a = newAutomation(tableId, `E-mail “${tpl.name}” to ${view.name}`);
    a.trigger = { type: 'manual' }; a.conditions = structuredClone(view.filter); a.actions = [{ id: S.uid('act'), type: 'sendEmail', templateId: tpl.id, providerId: provider, senderEmail: sender }];
    await saveAutomation(a); toast('Automation created – it is OFF and in test mode. Open Automations to test it on a few records, then activate it.', 'good'); location.hash = '#/automations';
  };
  return (
    <div className="main">
      <div className="page-head"><div><h1>Email Campaigns</h1><div className="muted">Templates with merge fields, per-record preview, sender selection, and a safe path from test to live.</div></div><label className="f right"><span>Preview and send from base</span><select aria-label="Base" value={tableId} onChange={e => setTableId(e.target.value)}>{tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label></div>
      {settings && !settings.sendingEnabled && <div className="note warn">Sending is switched <b>off</b> (Settings → E-mail → “Allow sending”). You can preview and run test sends; nothing is delivered until you turn it on.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '230px 1fr', gap: 16 }}>
        <div className="col"><button className="primary" onClick={addTemplate}>+ New template</button>{(templates || []).map(t => <button key={t.id} className={t.id === sel ? 'primary' : ''} style={{ textAlign: 'left' }} onClick={() => setSel(t.id)}>{t.name}</button>)}</div>
        <div className="col">{tpl && <>
          <div className="card col"><div className="row"><input type="text" aria-label="Template name" value={tpl.name} onChange={e => setTpl({ ...tpl, name: e.target.value })} style={{ fontWeight: 600, minWidth: 260 }} /><button className="primary right" onClick={save}>Save</button><button className="sm" onClick={async () => { if (confirm('Delete this template?')) { await deleteTemplate(tpl.id); setSel(null); reload(); } }}>Delete</button></div>
            <Field_ label="Subject"><input type="text" value={tpl.subject} onChange={e => setTpl({ ...tpl, subject: e.target.value })} /></Field_>
            <Field_ label="Message"><textarea rows={12} value={tpl.body} onChange={e => setTpl({ ...tpl, body: e.target.value })} spellCheck /></Field_>
            <div className="row"><select aria-label="Insert a field" value="" onChange={e => { if (e.target.value) setTpl({ ...tpl, body: `${tpl.body}{${e.target.value}}` }); }}><option value="">Insert field…</option>{data.fields.filter(f => !['attachment'].includes(f.type)).map(f => <option key={f.id} value={f.name}>{f.name}</option>)}</select>
              <span className="muted small">{'{Field}'} · {'{Field | fallback: text}'} · {'[[optional sentence with {Field}]]'} (dropped when a field inside is empty). Missing values are never invented.</span></div></div>
          <div className="card col"><h3>Preview for a record</h3>
            <select aria-label="Contact" value={recId} onChange={e => setRecId(e.target.value)}>{withMail.map(r => <option key={r.id} value={r.id}>{(nameId && cellText(r.cells[nameId])) || '(no name)'} — {emailId ? cellText(r.cells[emailId]) : ''}</option>)}</select>
            {!withMail.length && <div className="muted">No contacts with an e-mail address yet.</div>}
            {preview && <><div className="small muted">To: {preview.to || '—'} · From: {sender} via {provider === 'brevo' ? 'Brevo' : 'Gmail'}</div><div><b>{preview.subject}</b></div><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#f8fafc', padding: 12, borderRadius: 8, border: '1px solid var(--line)', margin: 0 }}>{preview.text}</pre>
              {preview.usedFallback.length > 0 && <div className="note">Fallback used for: {preview.usedFallback.join(', ')}.</div>}{preview.missing.length > 0 && <div className="note warn">Empty (left blank): {preview.missing.join(', ')}.</div>}{preview.problems.map(p => <div className="note bad" key={p}>{p}</div>)}</>}
            <div className="row"><button onClick={() => sendTest(false)} disabled={!preview}>Test send (nothing leaves your computer)</button><input type="email" placeholder="my own address" aria-label="Address for a real test" value={testTo} onChange={e => setTestTo(e.target.value)} /><button disabled={!preview || !/.+@.+\..+/.test(testTo)} onClick={() => setConfirmReal(true)}>Send ONE real test to this address</button></div></div>
          <div className="card col"><h3>Sender</h3>
            <div className="grid2"><Field_ label="Provider"><select value={provider} onChange={e => setProvider(e.target.value as 'brevo' | 'gmail')}><option value="brevo">Brevo – sends, tracks opens / clicks / bounces</option><option value="gmail">Gmail – sends only (no analytics)</option></select></Field_>
              <Field_ label="Send from"><input type="text" value={sender} onChange={e => setSender(e.target.value)} /></Field_></div>
            <div className="row">{provider === 'brevo' ? <><button onClick={verifyBrevo}>Verify sender with Brevo</button>{!secrets?.brevoApiKey && <span className="chip warn">no Brevo API key yet – add it in Settings</span>}</> : <><button onClick={connectGmail}>Connect a Gmail account</button>{(secrets?.gmail?.accounts || []).map(a => <span key={a.email} className="chip">{a.email} · {a.sendAs?.filter(s => s.verified).map(s => s.email).join(', ') || 'no aliases'}</span>)}</>}</div>
            {verify && <div className={`note ${verify.ok ? 'good' : 'bad'}`}>{verify.msg}</div>}
            <div className="muted small">info@vierapparatus.com can send through Gmail as a “Send As” identity of your Gmail account, but Gmail provides no open or click tracking. For analytics send through Brevo, where the sender must be verified.</div></div>
          <div className="card col"><h3>Outreach automation</h3><div className="row"><span className="muted small">Send this template to the contacts of view</span><select value={viewId || data.views.find(v => v.name === 'Ready for Outreach')?.id || data.views[0]?.id || ''} onChange={e => setViewId(e.target.value)}>{data.views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select><button onClick={makeAutomation}>Create automation (off, test mode)</button></div><div className="muted small">Newly scraped contacts are never e-mailed automatically: you review the automation, test it on a few records, switch test mode off and turn it on.</div></div></>}
        </div>
      </div>
      {confirmReal && <Confirm confirmLabel="Send the test" message={`Send ONE real e-mail (“${preview?.subject}”) to ${testTo} from ${sender} through ${provider === 'brevo' ? 'Brevo' : 'Gmail'}? It does not mark the contact as contacted.`} onNo={() => setConfirmReal(false)} onYes={() => { setConfirmReal(false); void sendTest(true); }} />}
    </div>
  );
}

export function Analytics() {
  const toast = useToast(); const { data: logs, reload } = useAsync(listEmailLog, []); const [busy, setBusy] = useState(false); const [settings, setSettings] = useState<Settings>();
  useEffect(() => { void getSettings().then(setSettings); }, []);
  const s = summarize(logs || []); const sync = async () => { setBusy(true); try { const r: any = await send({ type: 'email:sync' }); toast(`Checked ${r.brevo.checked} message(s); ${r.brevo.newEvents} new event(s)${r.brevo.errors?.length ? `; ${r.brevo.errors[0]}` : ''}`, r.brevo.errors?.length ? 'bad' : 'good'); reload(); } catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); } };
  const tile = (v: string | number, l: string, sub?: string) => <div className="tile"><div className="v">{v}</div><div className="l">{l}{sub && <div className="small">{sub}</div>}</div></div>;
  return (
    <div className="main">
      <div className="page-head"><div><h1>Analytics</h1><div className="muted">Delivery, opens, clicks, bounces and unsubscribes for e-mail sent through Brevo.</div></div><button className="primary right" disabled={busy} onClick={sync}>{busy ? 'Syncing…' : '↻ Sync from Brevo'}</button></div>
      <div className="grid4"><>{tile(s.sent, 'Emails sent')}{tile(s.delivered, 'Delivered')}{tile(s.uniqueOpens, 'Unique opens', `${s.openRate}%`)}{tile(s.clicks, 'Clicks', `${s.clickRate}%`)}{tile(s.bounces, 'Bounces', `${s.bounceRate}%`)}{tile(s.unsubscribes, 'Unsubscribes')}{tile(s.failed, 'Failed to send')}</></div>
      <div className="note" style={{ marginTop: 12 }}><b>About open numbers.</b> Opens are counted when an invisible tracking image loads. Apple Mail Privacy Protection and some security scanners load it automatically, so some “opens” are machines, and people who block images are never counted. Treat opens as a rough signal and clicks / replies as the real one. Gmail sends carry no analytics at all.</div>
      {settings?.webhookUrl ? <div className="note good">Webhook backend configured: {settings.webhookUrl}. Events also arrive in near real time.</div> : <div className="note">No webhook backend configured: events are fetched from Brevo’s API when you press Sync (and every {settings?.brevoSyncMinutes ?? 15} minutes while Chrome is open). A webhook needs the small backend described in the documentation because Brevo must reach a public URL.</div>}
      <div className="card" style={{ marginTop: 12 }}><table className="t"><thead><tr><th>Sent</th><th>To</th><th>Subject</th><th>Via</th><th>Status</th></tr></thead><tbody>{(logs || []).slice(0, 200).map((l: EmailLog) => <tr key={l.id}><td className="small nowrap">{fmtTime(l.sentAt)}</td><td className="small">{l.to}</td><td className="small">{l.subject}</td><td>{l.provider}</td><td><span className={`chip ${l.status === 'failed' || l.bounced ? 'bad' : l.clicked || l.opened ? 'good' : l.status === 'test' ? 'dark' : ''}`}>{l.status}{l.opened ? ' · opened' : ''}{l.clicked ? ' · clicked' : ''}</span></td></tr>)}</tbody></table>{!logs?.length && <div className="muted">Nothing sent yet.</div>}</div>
    </div>
  );
}
void DB; void ({} as Secrets);
