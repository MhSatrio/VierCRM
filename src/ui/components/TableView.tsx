// An Airtable-style table: views, filter, sort, fields, search, spreadsheet grid, record panel, CSV import / export, bulk actions.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as S from '../../core/store';
import { applyFilterSort, emptyGroup } from '../../core/filters';
import { buildDedupeIndex } from '../../core/dedupe';
import { autoMap, parseCsv, rowsFromCsv, toCsv, type CsvMapping } from '../../core/csv';
import { computeRecord } from '../../core/values';
import type { CellValue, ConditionGroup, SortSpec, View } from '../../core/types';
import { findCandidates } from '../../research/auto';
import { Confirm, Field_, Modal, download, ensureHostAccess, onRuntime, send, useTable, useToast } from '../bridge';
import { Grid } from './Grid';
import { FilterBuilder } from './FilterBuilder';
import { FieldManager } from './FieldManager';
import { RecordPanel } from './RecordPanel';

function ImportModal({ tableId, onClose, onDone }: { tableId: string; onClose(): void; onDone(): void }) {
  const toast = useToast(); const { fields } = useTable(tableId);
  const [grid, setGrid] = useState<string[][] | null>(null); const [map, setMap] = useState<CsvMapping[]>([]); const [busy, setBusy] = useState(false);
  const pick = async (f: File) => { const g = parseCsv(await f.text()); if (g.length < 2) return toast('That file has no data rows.', 'bad'); setGrid(g); setMap(autoMap(g[0], fields)); };
  const importNow = async () => {
    if (!grid) return; setBusy(true);
    try {
      const rows = rowsFromCsv(grid, map, fields); const index = buildDedupeIndex(await S.listRecords(tableId), await S.getDedupeRules(tableId)); let created = 0; let dup = 0;
      for (const cells of rows) { if (index.find(cells)) { dup++; continue; } const r = await S.createRecord(tableId, cells, { silent: true }); index.add(r); created++; }
      toast(`Imported ${created} record(s); ${dup} duplicate(s) skipped.`, 'good'); onDone(); onClose();
    } catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Import CSV" size="wide" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!grid || busy || !map.some(m => m.fieldId)} onClick={importNow}>{busy ? 'Importing…' : `Import ${grid ? grid.length - 1 : 0} rows`}</button></>}>
      <input type="file" accept=".csv,text/csv,.tsv,.txt" onChange={e => e.target.files?.[0] && pick(e.target.files[0])} />
      {grid && <><div className="note">Columns are matched to fields by name – change any that are wrong. Rows that match an existing record (same e-mail, profile URL, or name at the same institution) are skipped. Automations do not run for imported rows.</div>
        <table className="t"><thead><tr><th>CSV column</th><th>Example</th><th>Goes into</th></tr></thead><tbody>{grid[0].map((h, i) => <tr key={i}><td><b>{h || `(column ${i + 1})`}</b></td><td className="muted small">{grid[1][i]}</td><td><select aria-label={`Field for ${h}`} value={map[i]?.fieldId ?? ''} onChange={e => setMap(map.map((m, j) => (j === i ? { ...m, fieldId: e.target.value || null } : m)))}><option value="">— skip —</option>{fields.filter(f => !['formula', 'createdTime', 'lastModified', 'attachment'].includes(f.type)).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></td></tr>)}</tbody></table></>}
    </Modal>
  );
}

export function TableView({ tableId, title }: { tableId: string; title?: string }) {
  const data = useTable(tableId); const toast = useToast();
  const { fields, views, records } = data;
  const [viewId, setViewId] = useState<string>(''); const [search, setSearch] = useState(''); const [pop, setPop] = useState<'' | 'filter' | 'sort'>('');
  const [selected, setSelected] = useState<Set<string>>(new Set()); const [open, setOpen] = useState<string | null>(null); const [fm, setFm] = useState(false); const [imp, setImp] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false); const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [ovr, setOvr] = useState<Record<string, Partial<View>>>({});          // edits apply at once; saving happens in the background
  const baseView = views.find(v => v.id === viewId) ?? views[0];
  const view = baseView && ({ ...baseView, ...(ovr[baseView.id] || {}) } as View);
  useEffect(() => { if (views.length && !views.some(v => v.id === viewId)) setViewId(views[0].id); }, [views, viewId]);
  useEffect(() => onRuntime<{ done: number; total: number }>('lookup:progress', m => setProgress(m.done >= m.total ? null : { done: m.done, total: m.total })), []);

  const visibleFields = useMemo(() => fields.filter(f => !f.hidden && !(view?.hiddenFieldIds || []).includes(f.id)), [fields, view]);
  const rows = useMemo(() => (view ? applyFilterSort(fields, records, view.filter, view.sort, search) : []), [fields, records, view, search]);
  const errors = useMemo(() => { const out: Record<string, Record<string, string>> = {}; if (fields.some(f => f.type === 'formula')) for (const r of rows.slice(0, 400)) { const e = computeRecord(fields, r.rec).errors; if (Object.keys(e).length) out[r.rec.id] = e; } return out; }, [rows, fields]);

  const patchView = async (patch: Partial<View>) => { if (!view) return; setOvr(o => ({ ...o, [view.id]: { ...(o[view.id] || {}), ...patch } })); await S.saveView({ ...view, ...patch }); };
  const setFilter = (g: ConditionGroup) => patchView({ filter: g });
  const toggleSort = (fieldId: string) => { const cur = view.sort.find(s => s.fieldId === fieldId); const next: SortSpec[] = !cur ? [{ fieldId, dir: 'asc' }] : cur.dir === 'asc' ? [{ fieldId, dir: 'desc' }] : []; void patchView({ sort: next }); };
  const addView = async () => { const name = prompt('Name of the new view'); if (!name) return; const v = await S.createView(tableId, name.trim()); await data.reloadMeta(); setViewId(v.id); setPop('filter'); };
  const dupView = async () => { const v = await S.createView(tableId, `${view.name} copy`, structuredClone(view.filter), structuredClone(view.sort)); await data.reloadMeta(); setViewId(v.id); };
  const renameView = async () => { const n = prompt('Rename view', view.name); if (n?.trim()) await patchView({ name: n.trim() }); };
  const delView = async () => { if (views.length < 2) return toast('A table needs at least one view.', 'bad'); if (!confirm(`Delete the view “${view.name}”? Only the view goes – no records.`)) return; await S.deleteView(view.id); setViewId(''); await data.reloadMeta(); };

  const onEdit = async (id: string, fieldId: string, value: CellValue) => { try { data.upsert(await S.updateRecord(id, { [fieldId]: value })); } catch (e: any) { toast(e.message, 'bad'); } };
  const newRecord = async () => { const r = await S.createRecord(tableId, {}); data.upsert(r); setOpen(r.id); };
  const exportCsv = (onlySel: boolean) => { const rs = rows.filter(r => !onlySel || selected.has(r.rec.id)); download(`${(title || data.table?.name || 'records').replace(/\W+/g, '-')}.csv`, toCsv(visibleFields, rs.map(r => r.values)), 'text/csv;charset=utf-8'); };
  const research = async (ids: string[]) => { if (!ids.length) return; try { await ensureHostAccess(); setProgress({ done: 0, total: ids.length }); await send({ type: 'lookup:many', recordIds: ids }); toast(`Research finished for ${ids.length} record(s). Open a record to see what was found.`, 'good'); await data.reload(); } catch (e: any) { toast(e.message, 'bad'); } finally { setProgress(null); } };
  const sample = records[0];
  const hasSearch = fields.some(f => f.lookup?.kind === 'search'); const auto = !!data.table?.autoResearch && hasSearch;
  // auto-research of what is on screen: records in this view with a name but no latest publication are looked up a few at a time (see src/research/auto.ts)
  const waiting = useMemo(() => (auto ? findCandidates(fields, rows.map(r => r.rec), Date.now(), 5) : []), [auto, fields, rows]);
  const waitKey = waiting.map(r => r.id).join(',');
  useEffect(() => {
    if (!waitKey) return; let dead = false;
    const t = setTimeout(() => { void send<{ done?: number }>({ type: 'auto:records', tableId, recordIds: waitKey.split(',') }).catch(() => {}); }, 1500);          // the changed records arrive through the change broadcast
    return () => { dead = true; clearTimeout(t); };
    // eslint-disable-next-line
  }, [waitKey, tableId]);
  const activeFilter = view && (view.filter.items.length > 0);

  if (data.loading) return <div className="main muted">Loading…</div>;
  return (
    <div className="tv">
      <div className="tv-head">
        <div className="row" style={{ marginBottom: 6 }}><h1 style={{ margin: 0 }}>{title || data.table?.name}</h1><span className="muted">{data.partial ? 'loading all records…' : `${records.length.toLocaleString()} records`}</span>{auto && <span className="chip" title="Records in this base that have a name but no latest publication are researched automatically">✦ researching automatically{waiting.length ? ` · ${waiting.length}+ waiting` : ''}</span>}</div>
        <div className="tv-views" role="tablist" aria-label="Views">{views.map(v => <button key={v.id} role="tab" aria-selected={v.id === view?.id} className={v.id === view?.id ? 'on' : ''} onClick={() => { setViewId(v.id); setSelected(new Set()); }}>{v.name}</button>)}<button onClick={addView} aria-label="New view">+ View</button></div>
      </div>
      <div className="tv-bar">
        <button className={activeFilter ? 'primary' : ''} onClick={() => setPop(pop === 'filter' ? '' : 'filter')}>⚲ Filter{activeFilter ? ` · ${view.filter.items.length}` : ''}</button>
        <button className={view?.sort.length ? 'primary' : ''} onClick={() => setPop(pop === 'sort' ? '' : 'sort')}>⇅ Sort{view?.sort.length ? ` · ${view.sort.length}` : ''}</button>
        <button onClick={() => setFm(true)}>☰ Fields</button>
        <input type="search" placeholder="Search…" aria-label="Search records" value={search} onChange={e => setSearch(e.target.value)} />
        <span className="muted small">{rows.length.toLocaleString()} shown</span>
        <span className="right row"><button onClick={() => setImp(true)}>Import CSV</button><button onClick={() => exportCsv(false)}>Export CSV</button>
          {hasSearch && <button onClick={() => research(rows.map(r => r.rec.id).slice(0, 500))} disabled={!!progress} title="Find the latest publication (and everything that depends on it) for every record in this view">✦ Research this view</button>}
          <button className="primary" onClick={newRecord}>+ Record</button>
          <span className="row" style={{ gap: 2 }}><button className="ghost sm" onClick={renameView} title="Rename view">Rename</button><button className="ghost sm" onClick={dupView}>Duplicate</button><button className="ghost sm" onClick={delView} disabled={view?.builtin && false}>Delete view</button></span></span>
      </div>
      {progress && <div className="panel-pop"><div className="bar" role="progressbar" aria-valuenow={progress.done} aria-valuemax={progress.total}><i style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div><span className="small muted">Researching {progress.done} / {progress.total}…</span></div>}
      {pop === 'filter' && view && <div className="panel-pop"><FilterBuilder group={view.filter} fields={fields} onChange={setFilter} /><div className="row" style={{ marginTop: 6 }}><button className="sm" onClick={() => setFilter(emptyGroup())}>Clear filter</button><span className="muted small">Saved automatically with this view.</span></div></div>}
      {pop === 'sort' && view && <div className="panel-pop">{view.sort.map((s, i) => <div className="rule" key={i}><select value={s.fieldId} onChange={e => patchView({ sort: view.sort.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)) })}>{fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select><select value={s.dir} onChange={e => patchView({ sort: view.sort.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)) })}><option value="asc">A → Z / low → high</option><option value="desc">Z → A / high → low</option></select><button className="ghost sm" onClick={() => patchView({ sort: view.sort.filter((_, j) => j !== i) })}>✕</button></div>)}<button className="sm" onClick={() => patchView({ sort: [...view.sort, { fieldId: fields[0].id, dir: 'asc' }] })}>+ Sort</button></div>}
      {selected.size > 0 && <div className="selbar" role="toolbar"><b>{selected.size.toLocaleString()} selected</b><button onClick={() => research([...selected].slice(0, 500))}>✦ Research</button><button onClick={() => exportCsv(true)}>Export CSV</button><button onClick={() => setConfirmDel(true)}>Delete</button><button className="ghost" style={{ color: '#fff' }} onClick={() => setSelected(new Set())}>Clear</button></div>}
      <Grid fields={visibleFields} rows={rows} errors={errors} selected={selected} onSelect={setSelected} sort={view?.sort || []} onSort={toggleSort} onEdit={onEdit} onOpen={setOpen} />
      {open && <RecordPanel recordId={open} fields={fields} onClose={() => setOpen(null)} onChanged={() => void data.refreshOne(open)} />}
      {fm && <FieldManager tableId={tableId} fields={fields} sample={sample} onClose={() => setFm(false)} onChanged={() => void data.reloadMeta()} />}
      {imp && <ImportModal tableId={tableId} onClose={() => setImp(false)} onDone={() => void data.reload()} />}
      {confirmDel && <Confirm danger confirmLabel={`Delete ${selected.size}`} message={`Delete ${selected.size.toLocaleString()} record(s)? This cannot be undone. Export a CSV first if you may need them.`} onNo={() => setConfirmDel(false)} onYes={async () => { setConfirmDel(false); const ids = [...selected]; await S.deleteRecords(ids); data.remove(ids); setSelected(new Set()); toast('Deleted', 'good'); }} />}
    </div>
  );
}
void useRef; void Field_;
