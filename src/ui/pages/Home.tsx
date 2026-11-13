import React, { useEffect, useState } from 'react';
import * as DB from '../../core/db';
import * as S from '../../core/store';
import type { AutomationRun, ScrapeProgress, Table } from '../../core/types';
import { idOf, templateById } from '../../core/defaults';
import { cellText, isAttachment } from '../../core/values';
import { getSecrets, getSettings } from '../../core/settings';
import { listRuns } from '../../automation/engine';
import { listEmailLog } from '../../email/service';
import { summarize } from '../../email/analytics';
import { findCandidates } from '../../research/auto';
import type { DedupeRule } from '../../core/dedupe';
import { announceBases, Confirm, fmtTime, hasHostAccess, hasResearch, send, useAsync, useBases, useToast } from '../bridge';
import { AddBaseModal } from '../components/AddBase';

interface BaseStats { table: Table; count: number; withEmail: number; pubs: number; pdfs: number; waiting: number }

export function Dashboard() {
  // 1) what is cheap (counts per base, e-mail log, runs …) appears at once; 2) the statistics that need every record are filled in a moment later
  const { data } = useAsync(async () => {
    const tables = await S.listTables(); const counts = await Promise.all(tables.map(t => S.countRecords(t.id)));
    const [logs, runs, last, settings, secrets, host, autos] = await Promise.all([listEmailLog(), listRuns(undefined, 6), DB.kvGet<ScrapeProgress>('lastScrape'), getSettings(), getSecrets(), hasHostAccess(), DB.all<{ enabled: boolean }>('automations')]);
    return { tables, counts, logs, runs, last, settings, secrets, host, autos };
  }, []);
  const first = !!data;
  const { data: stats } = useAsync(async () => {
    if (!first) return undefined; await new Promise(r => setTimeout(r, 60));          // let the quick part paint before the heavy part starts
    const out: BaseStats[] = [];
    for (const table of await S.listTables()) {
      const [fields, recs] = await Promise.all([S.listFields(table.id), S.listRecords(table.id)]);
      const em = idOf(fields, 'email'), pub = idOf(fields, 'latestPublication'), file = idOf(fields, 'publicationFile');
      out.push({ table, count: recs.length, withEmail: em ? recs.filter(r => cellText(r.cells[em]).trim()).length : 0, pubs: pub ? recs.filter(r => cellText(r.cells[pub]).trim()).length : 0,
        pdfs: file ? recs.filter(r => isAttachment(r.cells[file]) && (r.cells[file] as any).files.length).length : 0, waiting: table.autoResearch ? findCandidates(fields, recs, Date.now(), 100000).length : 0 });
    }
    return out;
  }, [first]);
  if (!data) return <div className="main muted">Loading…</div>;
  const { tables, counts, logs, runs, last, settings, secrets, host, autos } = data; const sum = summarize(logs);
  const total = counts.reduce((a, n) => a + n, 0); const st = (f: (s: BaseStats) => number) => (stats ? stats.reduce((a, s) => a + f(s), 0) : null);
  const emails = st(s => s.withEmail), pubs = st(s => s.pubs), pdfs = st(s => s.pdfs), waiting = st(s => s.waiting);
  const num = (n: number | null) => (n == null ? '…' : n.toLocaleString());
  const tile = (v: number | string, l: string, href: string) => <a className="tile" href={href}><div className="v">{v}</div><div className="l">{l}</div></a>;
  const steps: [boolean, string, string][] = [[host, 'Allow VierCRM to read the websites you scrape', '#/settings'], [total > 0, 'Scrape a list into a base – or open a base and import a CSV', '#/scraper'], [!!settings.unpaywallEmail, 'Add your e-mail for Unpaywall (open-access PDF search)', '#/settings'], [!!secrets.brevoApiKey, 'Connect Brevo (sending + analytics)', '#/settings'], [autos.length > 0, 'Create an outreach automation (it starts off, in test mode)', '#/automations']];
  return (
    <div className="main">
      <div className="page-head"><div><h1>Dashboard</h1><div className="muted">Scrape lists into bases → enrich → personalised outreach.</div></div></div>
      <div className="grid4">{tables.map((t, i) => tile(counts[i].toLocaleString(), t.name, `#/base/${t.id}`))}</div>
      <div className="grid4" style={{ marginTop: 12 }}>{tile(num(emails), 'records with an e-mail address', tables[0] ? `#/base/${tables[0].id}` : '#/')}{(pubs ?? 1) > 0 && tile(num(pubs), 'with a publication found', '#/research')}{(pdfs ?? 1) > 0 && tile(num(pdfs), 'with a PDF attached', '#/research')}{tile(sum.sent, 'e-mails sent', '#/analytics')}{tile(sum.uniqueOpens, 'opened', '#/analytics')}</div>
      {(waiting ?? 0) > 0 && <div className="note">✦ <b>{num(waiting)}</b> record(s) have a name but no publication yet – they are looked up automatically, a few per minute, while the browser is open (<a href="#/research">details</a>).</div>}
      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="card"><h2>Getting started</h2>{steps.map(([ok, t, h]) => <div key={t} className="row" style={{ padding: '3px 0' }}><span className={`chip ${ok ? 'good' : 'warn'}`}>{ok ? 'done' : 'to do'}</span><a href={h}>{t}</a></div>)}</div>
        <div className="card"><h2>Last scrape</h2>{last ? <><div className="row small"><span className="chip">{last.found} read</span><span className="chip good">{last.saved} new</span><span className="chip warn">{last.skipped} skipped</span><span className={`chip ${last.errors?.length ? 'bad' : ''}`}>{last.errors?.length || 0} errors</span></div><div className="muted small">{fmtTime(new Date(last.startedAt).toISOString())} · {last.stopReason}</div></> : <div className="muted">Nothing scraped yet. Open a list page in a tab and press the VierCRM icon.</div>}
          <h2 style={{ marginTop: 14 }}>Recent automation runs</h2>{runs.length ? runs.map((r: AutomationRun) => <div key={r.id} className="small row"><span className={`chip ${r.status === 'ok' ? 'good' : r.status === 'error' ? 'bad' : ''}`}>{r.status}</span>{r.automationName}<span className="muted right">{fmtTime(r.at)}</span></div>) : <div className="muted">None yet.</div>}</div>
      </div>
    </div>
  );
}

export function DedupeRules({ tableId }: { tableId: string }) {
  const [rules, setRules] = useState<DedupeRule[]>([]); const toast = useToast();
  useEffect(() => { void S.getDedupeRules(tableId).then(setRules); }, [tableId]);
  const upd = async (next: DedupeRule[]) => { setRules(next); await S.saveDedupeRules(tableId, next); toast('Duplicate rules saved', 'good'); };
  return <div className="col"><div className="muted small">A scraped or imported record is a duplicate when ANY enabled rule matches. Matching ignores case, accents and punctuation. Existing values are never overwritten – a duplicate only fills in what was empty.</div>
    {rules.map(r => <label key={r.id} className="chk"><input type="checkbox" checked={r.enabled} onChange={e => upd(rules.map(x => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} />{r.name}</label>)}{!rules.length && <div className="muted">No rules for this base.</div>}</div>;
}

function BaseCard({ t, count, onChanged }: { t: Table; count: number; onChanged(): void }) {
  const toast = useToast(); const { data: fields, reload } = useAsync(() => S.listFields(t.id), [t.id]); const [del, setDel] = useState(false); const [busy, setBusy] = useState(false);
  const research = !!fields && hasResearch(fields); const tpl = templateById(t.template);
  const [open, setOpen] = useState(false);
  return (
    <div className="card col">
      <div className="row"><span className="ico" aria-hidden style={{ color: 'var(--blue)', fontSize: 20 }}>{tpl.icon}</span><h2 style={{ margin: 0 }}>{t.name}</h2><span className="chip">{t.template ?? 'blank'}</span><span className="muted small">{count.toLocaleString()} records · {fields?.length ?? '…'} fields</span>
        <span className="right row"><a className="sm" href={`#/base/${t.id}`}><button className="sm">Open</button></a>
          <button className="sm" onClick={async () => { const n = prompt('Rename this base', t.name); if (n?.trim()) { await S.renameTable(t.id, n.trim()); announceBases(); onChanged(); } }}>Rename</button>
          <button className="sm" onClick={() => setDel(true)}>Delete</button></span></div>
      <div className="row">
        {research ? <label className="chk"><input type="checkbox" checked={!!t.autoResearch} onChange={async e => { await S.setAutoResearch(t.id, e.target.checked); if (e.target.checked) void send({ type: 'auto:now', tableId: t.id }).catch(() => {}); announceBases(); onChanged(); toast(e.target.checked ? 'Records with a name will now be researched automatically' : 'Automatic research switched off', 'good'); }} />Find research automatically (every record that has a name but no latest publication)</label>
          : <><span className="muted small">No research fields.</span><button className="sm" disabled={busy || !fields} onClick={async () => { setBusy(true); try { const added = await S.addResearchFields(t.id); toast(added.length ? `Added ${added.length} research fields` : 'This base already has them', 'good'); reload(); announceBases(); onChanged(); void send({ type: 'auto:now', tableId: t.id }).catch(() => {}); } finally { setBusy(false); } }}>✦ Add research fields</button></>}
      </div>
      <div><button className="sm ghost" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} Duplicate detection</button>{open && <DedupeRules tableId={t.id} />}</div>
      {del && <Confirm danger confirmLabel="Delete base" message={`Delete “${t.name}” with its ${count.toLocaleString()} records, fields, views and automations? This cannot be undone.`} onNo={() => setDel(false)} onYes={async () => { await S.deleteTable(t.id); setDel(false); announceBases(); onChanged(); toast('Base deleted', 'good'); }} />}
    </div>
  );
}

export function Bases() {
  const { tables, counts, reload } = useBases(); const [adding, setAdding] = useState(false);
  return (
    <div className="main">
      <div className="page-head"><div><h1>Bases</h1><div className="muted">A base is one list of records – people, companies, anything. Add as many as you need; every base has its own fields, views, duplicate rules and (optionally) research fields.</div></div><button className="primary right" onClick={() => setAdding(true)}>＋ Add base</button></div>
      <div className="note"><b>How to add a base:</b> press <b>＋ Add base</b> (here or in the left menu), pick a starting point – <i>Contacts</i>, <i>Companies</i>, <i>Researchers</i> or <i>Blank</i> – and give it a name. Then choose it in the Scraper under <b>Save to base</b>, or import a CSV into it.</div>
      <div className="col">{tables.map(t => <BaseCard key={t.id} t={t} count={counts[t.id] ?? 0} onChanged={reload} />)}</div>
      {adding && <AddBaseModal onClose={() => setAdding(false)} onCreated={t => { location.hash = `#/base/${t.id}`; }} />}
    </div>
  );
}
