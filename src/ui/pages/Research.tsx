import React, { useMemo, useState } from 'react';
import * as S from '../../core/store';
import type { MatchCandidate, Publication, RecordRow } from '../../core/types';
import { idOf } from '../../core/defaults';
import { cellText, isAttachment } from '../../core/values';
import { announceBases, ensureHostAccess, Field_, hasResearch, onRuntime, send, useBase, useBases, useTable, useToast } from '../bridge';
import { AttachmentCell } from '../components/attachments';
import { MatchChooser, PublicationCard, RecordPanel } from '../components/RecordPanel';

const SOURCES: [string, string][] = [['openalex', 'OpenAlex'], ['crossref', 'Crossref'], ['semanticscholar', 'Semantic Scholar'], ['pubmed', 'PubMed'], ['googlescholar', 'Google Scholar (your tab)'], ['researchgate', 'ResearchGate (your tab)']];

function AuthorSearch() {
  const toast = useToast(); const { tables } = useBases(); const [target, setTarget] = useBase('research', tables, t => !!t.autoResearch);
  const [q, setQ] = useState({ name: '', institution: '', yearFrom: '', yearTo: '', mustContain: '' }); const [sources, setSources] = useState<string[]>(['openalex', 'crossref', 'semanticscholar', 'pubmed']);
  const [res, setRes] = useState<any>(null); const [pub, setPub] = useState<Publication | null>(null); const [busy, setBusy] = useState(false);
  const opts = { yearFrom: q.yearFrom ? Number(q.yearFrom) : undefined, yearTo: q.yearTo ? Number(q.yearTo) : undefined, mustContain: q.mustContain || undefined };
  const search = async () => {
    if (!q.name.trim()) return toast('Type the researcher’s name.', 'bad'); setBusy(true); setRes(null); setPub(null);
    try { if (sources.some(s => ['googlescholar', 'researchgate'].includes(s))) await ensureHostAccess(); const r: any = await send({ type: 'author:search', name: q.name.trim(), institution: q.institution.trim() || undefined, sources, ...opts }); setRes(r); if (r.outcome.status === 'found') setPub(r.outcome.pub); }
    catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const latest = async (c: MatchCandidate) => { setBusy(true); try { if (c.publication) { setPub({ ...c.publication, authorMatch: { name: c.name, confidence: 1, reasons: ['chosen by you'] } }); return; } const r: any = await send({ type: 'author:latest', candidate: c, ...opts }); if (r.publication) setPub(r.publication); else toast('No publication found for that author in this range.', 'bad'); } catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); } };
  const saveContact = async () => {
    if (!pub || !target) return; const m = pub.authorMatch; const fields = await S.listFields(target); const K = (k: string) => idOf(fields, k); const name = K('fullName') ?? fields.find(f => f.primary)?.id; const search = fields.find(f => f.lookup?.kind === 'search');
    if (!name) return toast('That base has no name field.', 'bad');
    const cells: Record<string, any> = { [name]: q.name.trim() }; const inst = K('institution'); if (inst) cells[inst] = q.institution.trim() || m?.institution || null; const out = K('outreachStatus'); if (out) cells[out] = 'Not Contacted';
    await S.createRecord(target, cells, { meta: search ? { publications: { [search.id]: pub } } : undefined });
    toast(search ? 'Saved. Open it in the base and press “Run research” to fill the other publication fields.' : 'Saved (that base has no research fields yet – add them in Manage bases).', 'good');
  };
  return (
    <div className="col">
      <div className="card col">
        <div className="grid2"><Field_ label="Person's name"><input type="text" value={q.name} onChange={e => setQ({ ...q, name: e.target.value })} onKeyDown={e => e.key === 'Enter' && search()} placeholder="e.g. Anna Example" /></Field_><Field_ label="Institution (strongly recommended – it tells people with the same name apart)"><input type="text" value={q.institution} onChange={e => setQ({ ...q, institution: e.target.value })} /></Field_></div>
        <div className="row">{SOURCES.map(([id, l]) => <label key={id} className="chk"><input type="checkbox" checked={sources.includes(id)} onChange={e => setSources(e.target.checked ? [...sources, id] : sources.filter(x => x !== id))} />{l}</label>)}</div>
        <div className="grid4"><Field_ label="From year"><input type="number" value={q.yearFrom} onChange={e => setQ({ ...q, yearFrom: e.target.value })} /></Field_><Field_ label="To year"><input type="number" value={q.yearTo} onChange={e => setQ({ ...q, yearTo: e.target.value })} /></Field_><Field_ label="Must mention (comma = or)"><input type="text" value={q.mustContain} onChange={e => setQ({ ...q, mustContain: e.target.value })} /></Field_></div>
        <div className="row"><button className="primary" disabled={busy} onClick={search}>{busy ? 'Searching…' : 'Find latest publication'}</button><span className="muted small">Google Scholar and ResearchGate are read through a tab in your own browser, one page every 8 seconds, and stop at any human check.</span></div>
      </div>
      {res?.errors?.length > 0 && <div className="note warn">{res.errors.map((e: string) => <div key={e}>{e}</div>)}</div>}
      {res?.outcome?.status === 'none' && <div className="note warn"><b>No publication found.</b> {res.outcome.errors?.map((e: string) => <div key={e}>{e}</div>)} Try the institution, a different spelling, or another source.</div>}
      {res?.outcome?.status === 'ambiguous' && <MatchChooser candidates={res.outcome.candidates} busy={busy} onPick={latest} />}
      {pub && <><PublicationCard pub={pub} fieldName="Latest publication" /><div className="row"><span className="muted small">Save into</span><select aria-label="Save into base" value={target} onChange={e => setTarget(e.target.value)}>{tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><button onClick={saveContact}>Save as a record</button>{pub.pdfUrl && <a href={pub.pdfUrl} target="_blank" rel="noreferrer">Open PDF link ↗</a>}</div></>}
      {res?.candidates?.length > 0 && <div className="card"><h3>Authors found by author-based sources</h3><table className="t"><thead><tr><th>Author</th><th>Institution</th><th>Match</th><th></th></tr></thead><tbody>{res.candidates.map((c: MatchCandidate) => <tr key={c.source + c.id}><td><b>{c.name}</b><div className="muted small">{c.source}{c.worksCount ? ` · ${c.worksCount} works` : ''}{c.topics?.length ? ` · ${c.topics.join(', ')}` : ''}</div></td><td>{c.institution || '—'}</td><td><span className={`chip ${c.confidence >= 0.75 ? 'good' : c.confidence >= 0.5 ? 'warn' : ''}`}>{Math.round(c.confidence * 100)}%</span><div className="muted small">{c.reasons.join('; ')}</div></td><td><button className="sm" disabled={busy} onClick={() => latest(c)}>Latest work</button></td></tr>)}</tbody></table></div>}
    </div>
  );
}

function Status({ tableId }: { tableId: string }) {
  const toast = useToast(); const data = useTable(tableId); const [filter, setFilter] = useState<string>('all'); const [open, setOpen] = useState<string | null>(null); const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  React.useEffect(() => onRuntime<{ done: number; total: number }>('lookup:progress', m => setProgress(m.done >= m.total ? null : m)), []);
  const I = useMemo(() => { const K = (k: string) => idOf(data.fields, k); const search = data.fields.find(x => x.lookup?.kind === 'search'); return { name: search?.lookup?.nameFieldId ?? K('fullName') ?? data.fields[0]?.id ?? '', inst: K('institution'), search: search?.id ?? '', status: K('publicationStatus'), date: K('publicationDate'), url: K('publicationUrl'), file: K('publicationFile') }; }, [data.fields]);
  const statusOf = (r: RecordRow) => (I.status && cellText(r.cells[I.status])) || (I.search && cellText(r.cells[I.search]) ? 'Found' : 'Not researched');
  const all = useMemo(() => data.records.filter(r => cellText(r.cells[I.name])).map(r => ({ r, status: statusOf(r), hasPdf: !!I.file && isAttachment(r.cells[I.file]) && (r.cells[I.file] as any).files.length > 0 })), [data.records, I]);       // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => all.filter(x => filter === 'all' || x.status === filter), [all, filter]);
  const counts = (s: string) => all.filter(x => x.status === s).length;
  const run = async (ids: string[]) => { try { await ensureHostAccess(); setProgress({ done: 0, total: ids.length }); await send({ type: 'lookup:many', recordIds: ids }); toast('Research finished', 'good'); await data.reload(); } catch (e: any) { toast(e.message, 'bad'); } finally { setProgress(null); } };
  const todo = I.search ? data.records.filter(r => cellText(r.cells[I.name]) && !cellText(r.cells[I.search]) && !r.meta?.pending?.[I.search]) : [];
  return (
    <div className="col">
      <div className="row">{['all', 'Not researched', 'Found', 'Needs match', 'Not found', 'PDF attached', 'Full text unavailable'].map(s => <button key={s} className={filter === s ? 'primary sm' : 'sm'} onClick={() => setFilter(s)}>{s === 'all' ? `All (${all.length})` : `${s} (${counts(s)})`}</button>)}
        <button className="primary right" disabled={!todo.length || !!progress} onClick={() => run(todo.slice(0, 300).map(r => r.id))}>✦ Research {Math.min(todo.length, 300)} now (without waiting)</button></div>
      {progress && <div className="bar"><i style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>}
      <table className="t"><thead><tr><th>Researcher</th><th>Latest publication</th><th>Year</th><th>Status</th><th>Full text</th><th></th></tr></thead><tbody>
        {rows.slice(0, 300).map(({ r, status, hasPdf }) => <tr key={r.id}><td><b>{cellText(r.cells[I.name])}</b><div className="muted small">{I.inst ? cellText(r.cells[I.inst]) : ''}</div></td>
          <td className="small">{(I.search && cellText(r.cells[I.search])) || '—'}{I.url && r.cells[I.url] ? <> <a href={cellText(r.cells[I.url])} target="_blank" rel="noreferrer">↗</a></> : null}</td><td>{(I.date && cellText(r.cells[I.date]).slice(0, 4)) || '—'}</td>
          <td><span className={`chip ${status === 'Found' || status === 'PDF attached' ? 'good' : status === 'Needs match' || status === 'Full text unavailable' ? 'warn' : status === 'Not found' ? 'bad' : ''}`}>{status}</span></td>
          <td>{I.file ? <AttachmentCell value={isAttachment(r.cells[I.file]) ? (r.cells[I.file] as any) : null} publicationUrl={(I.url && cellText(r.cells[I.url])) || undefined} /> : '—'}{hasPdf ? '' : ''}</td>
          <td className="nowrap"><button className="sm" onClick={() => run([r.id])}>Run</button> <button className="sm" onClick={() => setOpen(r.id)}>Open</button></td></tr>)}</tbody></table>
      {rows.length === 0 && <div className="muted">Nothing in this group.</div>}
      {open && <RecordPanel recordId={open} fields={data.fields} onClose={() => setOpen(null)} onChanged={() => void data.reload()} />}
    </div>
  );
}

export function Research() {
  const toast = useToast(); const [tab, setTab] = useState<'status' | 'find'>('status'); const { tables, reload } = useBases(); const [tableId, setTableId] = useBase('research', tables, t => !!t.autoResearch);
  const data = useTable(tableId); const base = tables.find(t => t.id === tableId); const has = hasResearch(data.fields); const [busy, setBusy] = useState(false);
  const setAuto = async (on: boolean) => { await S.setAutoResearch(tableId, on); if (on) void send({ type: 'auto:now', tableId }).catch(() => {}); announceBases(); await reload(); toast(on ? 'Automatic research is on for this base' : 'Automatic research is off', 'good'); };
  const addFields = async () => { setBusy(true); try { const a = await S.addResearchFields(tableId); await data.reload(); announceBases(); await reload(); toast(a.length ? `Added ${a.length} research fields to “${base?.name}” – existing records will be researched automatically` : 'Nothing to add', 'good'); void send({ type: 'auto:now', tableId }).catch(() => {}); } finally { setBusy(false); } };
  return (
    <div className="main">
      <div className="page-head"><div><h1>Research Finder</h1><div className="muted">Finds the latest scientific publication of the people in a base – automatically.</div></div></div>
      <div className="card col" style={{ marginBottom: 14 }}>
        <h3>What does this do?</h3>
        <div>For a person with a <b>name</b> (and ideally an institution), VierCRM searches OpenAlex, Crossref, Semantic Scholar and PubMed for their most recent publication and fills the <b>Latest Publication</b>, date, DOI, link and keywords fields – and a legal PDF when one exists. It is checked against the person’s institution, ORCID and topics; when two people could match, the record waits in <i>Needs match</i> and you choose. Nothing is guessed.</div>
        <div><b>It runs by itself.</b> In a base with research fields and “Find research automatically” switched on, every record that has a name but an empty Latest Publication is looked up a few at a time (about 5 per minute), whether it was scraped, imported or typed. People who cannot be found are tried again after 7 days. This page is only for checking progress and for one-off searches.</div>
      </div>
      <div className="row" style={{ marginBottom: 10 }}><b>Base</b><select aria-label="Base" value={tableId} onChange={e => setTableId(e.target.value)}>{tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        {has ? <label className="chk"><input type="checkbox" checked={!!base?.autoResearch} onChange={e => setAuto(e.target.checked)} />Find research automatically</label> : <><span className="muted small">“{base?.name}” has no research fields.</span><button className="primary sm" disabled={busy || !tableId} onClick={addFields}>✦ Add research fields</button></>}</div>
      <div className="tabs"><button className={tab === 'status' ? 'on' : ''} onClick={() => setTab('status')}>Progress in this base</button><button className={tab === 'find' ? 'on' : ''} onClick={() => setTab('find')}>Look up one person</button></div>
      {tab === 'find' ? <AuthorSearch /> : has ? <Status tableId={tableId} key={tableId} /> : <div className="muted">Add research fields to see progress here.</div>}
      <div className="note" style={{ marginTop: 14 }}>Full texts come only from lawful sources: open-access copies found through Unpaywall, OpenAlex, Europe PMC and arXiv, repository pages, PDFs you attach yourself, and – if you switch it on in Settings – publisher PDFs your own institutional login already lets you read. VierCRM does not use Sci-Hub or similar sites and never bypasses a paywall. When no PDF is available the publication’s details and links are still saved and the field says “Full text unavailable”. Automatic research looks up details only; PDFs are fetched when you ask (or through an automation).</div>
    </div>
  );
}
void ({} as RecordRow);
