import React, { useEffect, useState } from 'react';
import * as S from '../../core/store';
import * as DB from '../../core/db';
import type { CellValue, EmailLog, Field, MatchCandidate, Publication, RecordRow } from '../../core/types';
import { cellText, computeRecord, isAttachment } from '../../core/values';
import { attachUserPdf } from '../../research/lookup';
import type { LookupReport } from '../../research/lookup';
import { ensureHostAccess, fmtTime, send, useToast } from '../bridge';
import { AttachmentCell } from './attachments';
import { isComputed } from './Grid';

export function PublicationCard({ pub, fieldName }: { pub: Publication; fieldName: string }) {
  const [more, setMore] = useState(false); const m = pub.authorMatch;
  return (
    <div className="card col" style={{ gap: 4 }}>
      <div className="row"><span className="chip dark">{fieldName}</span><span className="chip">{pub.source}</span>{pub.access && <span className={`chip ${/open|free/i.test(pub.access) ? 'good' : 'warn'}`}>{pub.access}</span>}</div>
      <b>{pub.title}</b>
      <div className="muted small">{[pub.year, pub.venue].filter(Boolean).join(' · ')}{pub.authors.length ? ` · ${pub.authors.slice(0, 6).join(', ')}${pub.authors.length > 6 ? '…' : ''}` : ''}</div>
      <div className="row small">{pub.doi && <a href={`https://doi.org/${pub.doi}`} target="_blank" rel="noreferrer">DOI {pub.doi}</a>}{pub.url && <a href={pub.url} target="_blank" rel="noreferrer">Publication page ↗</a>}{pub.fullTextUrl && <a href={pub.fullTextUrl} target="_blank" rel="noreferrer">Full-text page ↗</a>}</div>
      {m && <div className="muted small">Author match {Math.round(m.confidence * 100)}% — {m.reasons.join('; ')}</div>}
      {pub.abstract && <><button className="sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setMore(!more)}>{more ? 'Hide abstract' : 'Show abstract'}</button>{more && <div className="small">{pub.abstract}</div>}</>}
    </div>
  );
}

export function MatchChooser({ candidates, onPick, busy }: { candidates: MatchCandidate[]; onPick(c: MatchCandidate): void; busy: boolean }) {
  return (
    <div className="note warn">
      <b>Which one is this person?</b> More than one author fits – nothing was chosen automatically.
      <table className="t"><tbody>{candidates.map(c => <tr key={`${c.source}${c.id}`}>
        <td><b>{c.name}</b><div className="muted small">{[c.institution, c.worksCount ? `${c.worksCount} works` : '', c.topics?.join(', ')].filter(Boolean).join(' · ')}</div><div className="muted small">{c.source} · {Math.round(c.confidence * 100)}% — {c.reasons.join('; ')}{c.orcid ? ` · ${c.orcid}` : ''}</div>{c.publication && <div className="small">“{c.publication.title}” ({c.publication.year ?? 'n.d.'})</div>}</td>
        <td className="nowrap">{c.url && <a href={c.url} target="_blank" rel="noreferrer">profile ↗</a>} <button className="sm primary" disabled={busy} onClick={() => onPick(c)}>This is them</button></td></tr>)}</tbody></table>
    </div>
  );
}

export function RecordPanel({ recordId, fields, onClose, onChanged }: { recordId: string; fields: Field[]; onClose(): void; onChanged(): void }) {
  const toast = useToast(); const [rec, setRec] = useState<RecordRow>(); const [logs, setLogs] = useState<EmailLog[]>([]); const [reports, setReports] = useState<LookupReport[]>([]); const [busy, setBusy] = useState(false);
  const load = async () => { setRec(await S.getRecord(recordId)); setLogs((await DB.byIndex<EmailLog>('emailLog', 'recordId', recordId)).sort((a, b) => b.sentAt.localeCompare(a.sentAt))); };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [recordId]);
  useEffect(() => S.onRemoteRefresh(() => { void load(); }), [recordId]);
  if (!rec) return null;
  const { values, errors } = computeRecord(fields, rec); const name = cellText(values[(fields.find(f => f.primary) ?? fields[0]).id]) || 'Untitled';
  const save = async (f: Field, raw: string) => {
    let v: CellValue = raw.trim() === '' ? null : raw; if (f.type === 'number') v = raw.trim() === '' ? null : Number(raw); if (f.type === 'multiSelect') v = raw.split(',').map(x => x.trim()).filter(Boolean);
    if (JSON.stringify(v ?? null) === JSON.stringify(rec.cells[f.id] ?? null)) return; await S.updateRecord(rec.id, { [f.id]: v }); onChanged(); await load();
  };
  const research = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try { if (!(await ensureHostAccess())) toast('Without access to other sites, PDFs and Scholar pages cannot be fetched – API lookups still run.'); const r: any = await send({ type: 'lookup:run', recordId, ...extra }); setReports(r.run.reports); await load(); onChanged(); toast(r.run.found ? 'Publication found' : 'Research finished – see the log below', r.run.found ? 'good' : ''); }
    catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const upload = async (field: Field, file: File) => { try { if (file.size > 60e6) throw new Error('That file is larger than 60 MB.'); await attachUserPdf(rec.id, field.id, { name: file.name, bytes: await file.arrayBuffer() }); toast('PDF attached', 'good'); await load(); onChanged(); } catch (e: any) { toast(e.message, 'bad'); } };
  const pubs = Object.entries(rec.meta?.publications || {}); const pending = Object.entries(rec.meta?.pending || {});
  return (
    <aside className="drawer" aria-label={`Record: ${name}`}>
      <div className="modal-h"><h2 className="grow">{name}</h2><button className="ghost" aria-label="Close record" onClick={onClose}>✕</button></div>
      <div className="drawer-b col">
        <div className="row"><button className="primary" disabled={busy} onClick={() => research()}>{busy ? 'Researching…' : '✦ Run research'}</button><button disabled={busy} onClick={() => research({ force: true })} title="Replace values that research fields already hold">Redo (overwrite)</button>
          <button className="danger right" onClick={async () => { if (confirm(`Delete ${name}?`)) { await S.deleteRecords([rec.id]); onChanged(); onClose(); } }}>Delete</button></div>
        {pending.map(([fid, p]) => <MatchChooser key={fid} candidates={p.candidates} busy={busy} onPick={c => research({ choice: { fieldId: fid, candidate: c } })} />)}
        {pubs.map(([fid, p]) => <PublicationCard key={fid} pub={p} fieldName={fields.find(f => f.id === fid)?.name ?? 'Publication'} />)}
        {fields.filter(f => f.type === 'attachment').map(f => <div key={f.id}><h3>{f.name}</h3><AttachmentCell value={isAttachment(values[f.id]) ? (values[f.id] as any) : null} full publicationUrl={pubs[0]?.[1].url} />
          <label className="btn small" style={{ display: 'inline-block', marginTop: 6 }}><span className="muted small">Attach a PDF I have (my own copy or one I am authorised to use): </span><input type="file" accept="application/pdf,.pdf" onChange={e => { const file = e.target.files?.[0]; if (file) void upload(f, file); e.target.value = ''; }} /></label></div>)}
        {reports.length > 0 && <div><h3>Research log</h3><table className="t"><tbody>{reports.map(r => <tr key={r.fieldId}><td className="nowrap">{r.fieldName}</td><td><span className={`chip ${r.status === 'filled' ? 'good' : r.status === 'error' ? 'bad' : r.status === 'needsMatch' ? 'warn' : ''}`}>{r.status}</span></td><td className="small">{r.message}{r.log && <details><summary className="muted">how files were looked for</summary>{r.log.map((l, i) => <div key={i} className="small">{l}</div>)}</details>}</td></tr>)}</tbody></table></div>}
        {Object.entries(rec.meta?.lookupErrors || {}).length > 0 && <div className="note warn">{Object.entries(rec.meta!.lookupErrors!).map(([k, v]) => <div key={k}><b>{fields.find(f => f.id === k)?.name}:</b> {v}</div>)}</div>}
        <h3>Fields</h3>
        {fields.filter(f => f.type !== 'attachment').map(f => <label key={f.id} className="f"><span>{f.name}{f.lookup ? ' ✦' : ''}</span>
          {isComputed(f) ? <div className={errors[f.id] ? 'note bad' : ''}>{errors[f.id] ?? (cellText(values[f.id]) || '—')}</div>
            : f.type === 'checkbox' ? <input type="checkbox" checked={!!rec.cells[f.id]} onChange={async e => { await S.updateRecord(rec.id, { [f.id]: e.target.checked }); onChanged(); await load(); }} />
            : f.options?.choices?.length && ['singleSelect', 'scrapingStatus', 'emailStatus', 'publicationStatus'].includes(f.type) ? <select value={cellText(rec.cells[f.id])} onChange={e => save(f, e.target.value)}><option value="">—</option>{f.options.choices.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}</select>
            : f.type === 'longText' ? <textarea rows={3} defaultValue={cellText(rec.cells[f.id])} onBlur={e => save(f, e.target.value)} />
            : <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} defaultValue={cellText(rec.cells[f.id])} onBlur={e => save(f, e.target.value)} />}</label>)}
        {rec.meta?.scrape && <><h3>Scraped</h3><div className="small muted">{fmtTime(rec.meta.scrape.at)} · {rec.meta.scrape.status}{rec.meta.scrape.error ? ` · ${rec.meta.scrape.error}` : ''}{rec.sourceUrl ? <> · <a href={rec.sourceUrl} target="_blank" rel="noreferrer">source ↗</a></> : null}</div>
          {(rec.meta.scrape.identifiers?.length || 0) > 0 && <div className="small">Identity links on the profile: {rec.meta.scrape.identifiers!.map(u => <a key={u} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>{new URL(u).hostname.replace('www.', '')} ↗</a>)}</div>}
          {(rec.meta.scrape.publicationLinks?.length || 0) > 0 && <div className="small">Publication links on the profile: {rec.meta.scrape.publicationLinks!.map(u => <a key={u} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>{new URL(u).hostname.replace('www.', '')} ↗</a>)}</div>}</>}
        {logs.length > 0 && <><h3>E-mail history</h3><table className="t"><tbody>{logs.map(l => <tr key={l.id}><td className="small nowrap">{fmtTime(l.sentAt)}</td><td className="small">{l.subject}</td><td><span className={`chip ${l.status === 'failed' || l.bounced ? 'bad' : l.opened ? 'good' : ''}`}>{l.status}{l.opened ? ' · opened' : ''}{l.clicked ? ' · clicked' : ''}</span></td></tr>)}</tbody></table></>}
      </div>
    </aside>
  );
}
