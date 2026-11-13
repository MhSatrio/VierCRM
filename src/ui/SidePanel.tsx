import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import * as S from '../core/store';
import { idOf } from '../core/defaults';
import { cellText } from '../core/values';
import { announceBases, ToastProvider, useBase, useBases, useTable, wireChanges } from './bridge';
import { Scraper } from './pages/Scraper';
// the record viewer (and the research code behind it) is read only when a record is opened
const RecordPanel = lazy(() => import('./components/RecordPanel').then(m => ({ default: m.RecordPanel })));

function Records() {
  const { tables } = useBases(); const [baseId, setBase] = useBase('browse', tables);
  const data = useTable(baseId); const [q, setQ] = useState(''); const [open, setOpen] = useState<string | null>(null);
  const ids = useMemo(() => { const f = (k: string) => idOf(data.fields, k); return { name: data.fields.find(x => x.primary)?.id ?? data.fields[0]?.id, sub: ['position', 'institution', 'industry', 'location', 'website'].map(f).filter(Boolean) as string[], email: f('email'), pub: f('latestPublication') }; }, [data.fields]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase(); const take = (r: (typeof data.records)[number]) => `${ids.name ? cellText(r.cells[ids.name]) : ''} ${ids.sub.map(i => cellText(r.cells[i])).join(' ')} ${ids.email ? cellText(r.cells[ids.email]) : ''}`.toLowerCase();
    const out = []; for (const r of [...data.records].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) { if (!s || take(r).includes(s)) out.push(r); if (out.length >= 60) break; }
    return out;
  }, [data.records, q, ids]);
  return <div className="col">
    <div className="basepick"><span className="small muted">Base</span><select aria-label="Base" value={baseId} onChange={e => setBase(e.target.value)}>{tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
    <input type="search" aria-label="Search records" placeholder={`Search ${data.records.length.toLocaleString()} records…`} value={q} onChange={e => setQ(e.target.value)} />
    {rows.map(r => <button key={r.id} style={{ textAlign: 'left', display: 'block', fontWeight: 400, borderWidth: 1, borderColor: 'var(--line-2)', color: 'var(--ink)' }} onClick={() => setOpen(r.id)}><b style={{ fontWeight: 600 }}>{(ids.name && cellText(r.cells[ids.name])) || '(no name)'}</b><div className="small muted">{ids.sub.map(i => cellText(r.cells[i])).filter(Boolean).slice(0, 2).join(' · ')}</div>
      <div className="row small">{ids.email && (r.cells[ids.email] ? <span className="chip good">e-mail</span> : <span className="chip">no e-mail</span>)}{ids.pub && r.cells[ids.pub] ? <span className="chip good">publication</span> : null}</div></button>)}
    {!rows.length && <div className="muted">Nothing here yet – scrape a page in the Scrape tab.</div>}
    {open && <Suspense fallback={null}><RecordPanel recordId={open} fields={data.fields} onClose={() => setOpen(null)} onChanged={() => void data.refreshOne(open)} /></Suspense>}</div>;
}

export function SidePanel() {
  const [ready, setReady] = useState(false); const [tab, setTab] = useState<'scrape' | 'records'>('scrape');
  useEffect(() => { wireChanges(); void S.ensureSeeded().then(() => { announceBases(); setReady(true); }); }, []);
  return (
    <ToastProvider><div className="sp">
      <div className="sp-head"><div className="brand"><img src="brand/vier-black.svg" alt="VierApparatus" /><span className="eyebrow">CRM</span></div>
        <button className="sm right" title="Open the full VierCRM app in a tab" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('app.html') })}>Open app ↗</button></div>
      <div className="sp-body"><div className="tabs"><button className={tab === 'scrape' ? 'on' : ''} onClick={() => setTab('scrape')}>Scrape</button><button className={tab === 'records' ? 'on' : ''} onClick={() => setTab('records')}>Records</button></div>
        {!ready ? <div className="muted">Loading…</div> : tab === 'scrape' ? <Scraper compact /> : <Records />}</div>
    </div></ToastProvider>
  );
}
