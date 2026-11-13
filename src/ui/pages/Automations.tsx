import React, { useEffect, useMemo, useState } from 'react';
import * as S from '../../core/store';
import type { Action, ActionType, Automation, AutomationRun, EmailTemplate, TriggerType } from '../../core/types';
import { describeTrigger, deleteAutomation, listAutomations, listRuns, newAutomation, saveAutomation } from '../../automation/engine';
import { getTemplates } from '../../email/service';

import { Confirm, fmtTime, Modal, send, useAsync, useBase, useBases, useTable, useToast } from '../bridge';
import { FilterBuilder } from '../components/FilterBuilder';
import { DependencyFlow } from '../components/FieldManager';

const TRIGGERS: [TriggerType, string][] = [['recordCreated', 'A record is created'], ['recordUpdated', 'A record is updated'], ['fieldBecomesNonEmpty', 'A field becomes non-empty'], ['fieldBecomesEmpty', 'A field becomes empty'], ['fieldChanges', 'A field changes'], ['recordEntersView', 'A record enters a view'], ['scrapingCompleted', 'Scraping a record completes'], ['publicationFound', 'A publication is found'], ['scheduled', 'On a schedule'], ['manual', 'I run it manually']];
const ACTIONS: [ActionType, string][] = [['sendEmail', 'Send e-mail'], ['updateField', 'Update a field'], ['changeStatus', 'Change a status'], ['createRecord', 'Create a record'], ['runLookup', 'Run publication lookup'], ['downloadPdf', 'Download an authorised PDF'], ['updatePublication', 'Update publication metadata'], ['wait', 'Wait'], ['runAutomation', 'Run another automation']];
const needsField = (t: string) => ['fieldBecomesNonEmpty', 'fieldBecomesEmpty', 'fieldChanges'].includes(t);
const statusChip = (s: AutomationRun['status']) => <span className={`chip ${s === 'ok' ? 'good' : s === 'error' ? 'bad' : s === 'skipped' || s === 'waiting' ? 'warn' : ''}`}>{s === 'test' ? 'test run' : s}</span>;

function ActionEditor({ a, onChange, onRemove, fields, templates, autos }: { a: Action; onChange(a: Action): void; onRemove(): void; fields: ReturnType<typeof useTable>['fields']; templates: EmailTemplate[]; autos: Automation[] }) {
  const writable = fields.filter(f => !['formula', 'createdTime', 'lastModified', 'attachment'].includes(f.type));
  const fsel = (key: keyof Action, list = writable, label = 'field') => <select aria-label={label} value={(a[key] as string) || ''} onChange={e => onChange({ ...a, [key]: e.target.value || undefined })}><option value="">— {label} —</option>{list.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select>;
  return (
    <div className="card col" style={{ background: '#fafcff' }}>
      <div className="row"><b>{ACTIONS.find(x => x[0] === a.type)?.[1]}</b><button className="ghost sm right" aria-label="Remove action" onClick={onRemove}>✕</button></div>
      {a.type === 'sendEmail' && <div className="grid2">
        <select aria-label="Template" value={a.templateId || ''} onChange={e => onChange({ ...a, templateId: e.target.value })}><option value="">— e-mail template —</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <select aria-label="Provider" value={a.providerId || 'brevo'} onChange={e => onChange({ ...a, providerId: e.target.value as 'brevo' | 'gmail' })}><option value="brevo">Brevo (with analytics)</option><option value="gmail">Gmail (no analytics)</option></select>
        <input type="text" aria-label="Sender" placeholder="sender, e.g. info@vierapparatus.com" value={a.senderEmail || ''} onChange={e => onChange({ ...a, senderEmail: e.target.value })} />
        {fsel('toFieldId', fields.filter(f => f.type === 'email' || f.type === 'text'), 'recipient field (default: Email)')}</div>}
      {(a.type === 'updateField') && <div className="grid2">{fsel('fieldId')}<input type="text" aria-label="Value" placeholder="value, with {Field} placeholders – or =FORMULA" value={a.value || ''} onChange={e => onChange({ ...a, value: e.target.value })} /></div>}
      {a.type === 'changeStatus' && <div className="grid2">{fsel('statusFieldId', fields.filter(f => f.options?.choices?.length), 'status field')}<input type="text" aria-label="New status" placeholder="e.g. Contacted" value={a.markStatus || ''} onChange={e => onChange({ ...a, markStatus: e.target.value })} /></div>}
      {a.type === 'runLookup' && <div className="row">{fsel('fieldId', fields.filter(f => f.lookup), 'only this research field (optional)')}<span className="muted small">Leave empty to run every research field in dependency order.</span></div>}
      {a.type === 'downloadPdf' && <div className="row">{fsel('fieldId', fields.filter(f => f.lookup?.kind === 'pdf'), 'PDF field')}<span className="muted small">Only lawful open-access PDFs; paywalls are never bypassed.</span></div>}
      {a.type === 'updatePublication' && <span className="muted small">Refreshes DOI, date, URL, abstract and keywords from the publication already found. Runs nothing if the publication field is empty.</span>}
      {a.type === 'wait' && <label className="row"><input type="number" min={1} aria-label="Seconds" value={a.seconds ?? 60} onChange={e => onChange({ ...a, seconds: Number(e.target.value) })} style={{ width: 90 }} />seconds</label>}
      {a.type === 'runAutomation' && <select aria-label="Automation" value={a.automationId || ''} onChange={e => onChange({ ...a, automationId: e.target.value })}><option value="">— automation —</option>{autos.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
      {a.type === 'createRecord' && <div className="col">{Object.entries(a.cells || {}).map(([k, v]) => <div className="rule" key={k}><select value={k} onChange={e => { const c = { ...a.cells }; delete c[k]; c[e.target.value] = v; onChange({ ...a, cells: c }); }}>{writable.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select><input type="text" value={v} onChange={e => onChange({ ...a, cells: { ...a.cells, [k]: e.target.value } })} /><button className="ghost sm" onClick={() => { const c = { ...a.cells }; delete c[k]; onChange({ ...a, cells: c }); }}>✕</button></div>)}<button className="sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange({ ...a, cells: { ...a.cells, [(writable.find(f => f.key === 'notes') ?? writable[0])?.id ?? '']: '' } })}>+ value</button></div>}
    </div>
  );
}

function Builder({ auto, onChange, onDelete }: { auto: Automation; onChange(a: Automation): void; onDelete(): void }) {
  const toast = useToast(); const data = useTable(auto.tableId); const { data: templates } = useAsync(getTemplates, []); const { data: autos } = useAsync(() => listAutomations(), []);
  const { data: runs, reload } = useAsync(() => listRuns(auto.id, 40), [auto.id]); const [confirmOn, setConfirmOn] = useState(false); const [showRuns, setShowRuns] = useState<AutomationRun | null>(null); const [busy, setBusy] = useState(false);
  const [viewForRun, setViewForRun] = useState('');
  const hasEmail = auto.actions.some(a => a.type === 'sendEmail');
  const set = (patch: Partial<Automation>) => onChange({ ...auto, ...patch });
  const t = auto.trigger;
  const problems = useMemo(() => {
    const p: string[] = []; if (!auto.actions.length) p.push('Add at least one action.');
    if (needsField(t.type) && !t.fieldId) p.push('Choose the field this trigger watches.'); if (t.type === 'recordEntersView' && !t.viewId) p.push('Choose the view.');
    for (const a of auto.actions) { if (a.type === 'sendEmail' && !a.templateId) p.push('Choose an e-mail template.'); if ((a.type === 'updateField') && !a.fieldId) p.push('Choose the field to update.'); if (a.type === 'runAutomation' && !a.automationId) p.push('Choose the automation to run.'); }
    return p;
  }, [auto, t]);
  const toggle = (on: boolean) => { if (on && problems.length) return toast(problems[0], 'bad'); if (on && hasEmail && !auto.testMode) return setConfirmOn(true); set({ enabled: on }); };
  const runOn = async (testMode: boolean, limit: number) => {
    const view = data.views.find(v => v.id === viewForRun) ?? data.views[0]; if (!view) return; setBusy(true);
    try {
      const { applyFilterSort } = await import('../../core/filters'); const ids = applyFilterSort(data.fields, data.records, view.filter, view.sort).slice(0, limit).map(r => r.rec.id);
      await saveAutomation(auto); const r: any = await send({ type: 'auto:run', automationId: auto.id, recordIds: ids, testMode });
      toast(`${testMode ? 'Test run' : 'Run'} finished for ${ids.length} record(s): ${r.runs.filter((x: AutomationRun) => x.status === 'error').length} error(s).`, 'good'); reload();
    } catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <div className="col">
      <div className="row"><input type="text" aria-label="Automation name" value={auto.name} onChange={e => set({ name: e.target.value })} style={{ fontSize: 18, fontWeight: 600, minWidth: 280 }} />
        <label className="chk"><input type="checkbox" checked={auto.testMode} onChange={e => set({ testMode: e.target.checked })} />Test mode (nothing is changed or sent)</label>
        <label className="chk"><input type="checkbox" checked={auto.enabled} onChange={e => toggle(e.target.checked)} /><b>{auto.enabled ? 'Active' : 'Off'}</b></label>
        <button className="danger sm right" onClick={onDelete}>Delete</button></div>
      {hasEmail && <div className="note warn">This automation can send e-mail. New automations start <b>off</b> and in <b>test mode</b>. Nothing is sent to contacts until you switch test mode off and turn it on – and the global “Allow sending” switch in Settings must also be on.</div>}
      {problems.length > 0 && <div className="note">{problems[0]}</div>}
      <div className="card col"><h3>When</h3>
        <div className="row"><select aria-label="Trigger" value={t.type} onChange={e => set({ trigger: { type: e.target.value as TriggerType } })}>{TRIGGERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          {needsField(t.type) && <select aria-label="Watched field" value={t.fieldId || ''} onChange={e => set({ trigger: { ...t, fieldId: e.target.value } })}><option value="">— field —</option>{data.fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select>}
          {t.type === 'recordEntersView' && <select aria-label="View" value={t.viewId || ''} onChange={e => set({ trigger: { ...t, viewId: e.target.value } })}><option value="">— view —</option>{data.views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>}
          {t.type === 'scheduled' && <label className="row">every <input type="number" min={1} value={t.everyMinutes ?? 60} onChange={e => set({ trigger: { ...t, everyMinutes: Number(e.target.value) } })} style={{ width: 80 }} /> minutes</label>}</div>
        <div className="muted small">{describeTrigger(t, data.fields, data.views)}.</div></div>
      <div className="card col"><h3>Only if</h3><FilterBuilder group={auto.conditions} fields={data.fields} onChange={g => set({ conditions: g })} /><div className="muted small">Leave empty to run for every record that triggers it.</div></div>
      <div className="card col"><h3>Then</h3>
        {auto.actions.map((a, i) => <ActionEditor key={a.id} a={a} fields={data.fields} templates={templates || []} autos={(autos || []).filter(x => x.id !== auto.id)} onChange={na => set({ actions: auto.actions.map((x, j) => (j === i ? na : x)) })} onRemove={() => set({ actions: auto.actions.filter((_, j) => j !== i) })} />)}
        <div className="row"><span className="muted small">Add action:</span>{ACTIONS.map(([k, l]) => <button key={k} className="sm" onClick={() => set({ actions: [...auto.actions, { id: S.uid('act'), type: k, ...(k === 'sendEmail' ? { providerId: 'brevo' as const, senderEmail: 'info@vierapparatus.com' } : {}), ...(k === 'wait' ? { seconds: 60 } : {}) }] })}>{l}</button>)}</div></div>
      <div className="card col"><h3>Run it now</h3>
        <div className="row"><span className="muted small">On records of view</span><select value={viewForRun} onChange={e => setViewForRun(e.target.value)}><option value="">{data.views[0]?.name}</option>{data.views.slice(1).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
          <button disabled={busy} onClick={() => runOn(true, 5)}>Test on 5 records</button><button disabled={busy || !auto.enabled} title={auto.enabled ? '' : 'Turn the automation on first'} className="primary" onClick={() => runOn(auto.testMode, 25)}>Run on up to 25 records{auto.testMode ? ' (test mode)' : ''}</button></div></div>
      <div className="card col"><h3>Field dependencies</h3><DependencyFlow fields={data.fields} /></div>
      <div className="card"><div className="row"><h3 style={{ margin: 0 }}>History</h3><button className="sm right" onClick={reload}>↻</button></div>
        <table className="t"><thead><tr><th>When</th><th>Trigger</th><th>Result</th><th></th></tr></thead><tbody>{(runs || []).map(r => <tr key={r.id}><td className="small nowrap">{fmtTime(r.at)}</td><td className="small">{r.trigger}</td><td>{statusChip(r.status)} <span className="small muted">{r.error || r.steps.map(s => s.message).join(' · ').slice(0, 90)}</span></td><td className="nowrap"><button className="sm" onClick={() => setShowRuns(r)}>Details</button>{r.status === 'error' && <button className="sm" onClick={async () => { await send({ type: 'auto:retry', runId: r.id }); reload(); }}>Retry</button>}</td></tr>)}</tbody></table>
        {!runs?.length && <div className="muted">No runs yet.</div>}</div>
      {showRuns && <Modal title="Run details" onClose={() => setShowRuns(null)}><div className="small muted">{fmtTime(showRuns.at)} · {showRuns.trigger} · chain depth {showRuns.depth}</div><table className="t"><tbody>{showRuns.steps.map((s, i) => <tr key={i}><td>{s.type}</td><td>{statusChip(s.status as any)}</td><td className="small">{s.message}</td></tr>)}</tbody></table>{showRuns.error && <div className="note bad">{showRuns.error}</div>}</Modal>}
      {confirmOn && <Confirm danger confirmLabel="Turn on" message="This automation will send real e-mail to contacts whenever its trigger fires (within your daily cap and the guard rails in Settings). Turn it on?" onNo={() => setConfirmOn(false)} onYes={() => { setConfirmOn(false); set({ enabled: true }); }} />}
    </div>
  );
}

export function Automations() {
  const { data: list, reload } = useAsync(() => listAutomations(), []); const [sel, setSel] = useState<string | null>(null); const [draft, setDraft] = useState<Automation | null>(null);
  const [del, setDel] = useState(false); const { tables } = useBases(); const [newBase, setNewBase] = useBase('automations', tables);
  useEffect(() => { if (!sel && list?.length) setSel(list[0].id); }, [list, sel]);
  useEffect(() => { setDraft(list?.find(a => a.id === sel) ?? null); }, [sel, list]);
  useEffect(() => { if (!draft) return; const t = setTimeout(() => { void saveAutomation(draft).then(reload); }, 500); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [JSON.stringify(draft && { ...draft, updatedAt: '' })]);
  const create = async () => { if (!newBase) return; const a = newAutomation(newBase, 'New automation'); await saveAutomation(a); await reload(); setSel(a.id); };
  return (
    <div className="main">
      <div className="page-head"><div><h1>Automations</h1><div className="muted">Trigger → conditions → actions. Changes are saved as you type.</div></div><span className="right row"><label className="row small"><span className="muted">for base</span><select aria-label="Base for the new automation" value={newBase} onChange={e => setNewBase(e.target.value)}>{tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><button className="primary" onClick={create}>+ New automation</button></span></div>
      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16 }}>
        <div className="col" role="list">{(list || []).map(a => <button key={a.id} role="listitem" className={a.id === sel ? 'primary' : ''} style={{ textAlign: 'left' }} onClick={() => setSel(a.id)}>{a.name}<div className="small" style={{ opacity: .85 }}>{a.enabled ? (a.testMode ? '● active · test mode' : '● active') : '○ off'}</div></button>)}{!list?.length && <div className="muted">No automations yet.</div>}</div>
        <div>{draft ? <Builder key={draft.id} auto={draft} onChange={setDraft} onDelete={() => setDel(true)} /> : <div className="card muted">Create an automation to get started. Example: “When a record enters <i>Ready for Outreach</i> → send the introduction e-mail from info@vierapparatus.com” – start it in test mode and look at the history before turning it on.</div>}</div>
      </div>
      {del && draft && <Confirm danger confirmLabel="Delete" message={`Delete “${draft.name}” and its history?`} onNo={() => setDel(false)} onYes={async () => { setDel(false); await deleteAutomation(draft.id); setSel(null); setDraft(null); reload(); }} />}
    </div>
  );
}
