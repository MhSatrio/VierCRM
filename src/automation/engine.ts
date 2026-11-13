// Automation engine: Trigger → Conditions → Actions.
//
// Safety rules built in:
//   * LOOPS   – every write an automation makes carries { chain, depth }. A change that already has automation A in its chain can never
//               trigger A again, and nothing runs deeper than MAX_DEPTH.
//   * REPEATS – one-shot triggers remember what they already handled (e.g. "Email becomes non-empty" for THIS value on THIS record).
//   * E-MAIL  – a real send needs: automation enabled + not in test mode + global "Allow sending" + every guard in email/service.ts.
//   * TEST    – test mode renders what would happen and writes/sends/downloads NOTHING.
import * as DB from '../core/db';
import * as S from '../core/store';
import type { Action, Automation, AutomationRun, CellValue, Field, PendingJob, RecordMeta, RecordRow, RunStep, Trigger, View } from '../core/types';
import { recordMatches } from '../core/filters';
import { computeRecord, cellText, coerceForField, isEmptyValue, templateLookup, byLowerName } from '../core/values';
import { renderTemplate } from '../core/template';
import { evaluateFormula } from '../core/formula';
import { emptyGroup } from '../core/filters';
import { fid } from '../core/defaults';
import { runLookups } from '../research/lookup';
import type { Ctx } from '../research/http';
import { sendRecordEmail, type EmailDeps } from '../email/service';

export const MAX_DEPTH = 4;
export interface EngineDeps { research: Ctx; email: EmailDeps; now: () => Date }

type Origin = NonNullable<RecordMeta['origin']>;
const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

// ------------------------------------------------------------------ storage
export const listAutomations = async (tableId?: string) => { const all = tableId ? await DB.byIndex<Automation>('automations', 'tableId', tableId) : await DB.all<Automation>('automations'); return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); };
export const getAutomation = (id: string) => DB.get<Automation>('automations', id);
export const saveAutomation = (a: Automation) => DB.put('automations', { ...a, updatedAt: new Date().toISOString() });
export const deleteAutomation = (id: string) => DB.del('automations', id);
export async function listRuns(automationId?: string, limit = 200): Promise<AutomationRun[]> {
  const rows = automationId ? await DB.byIndex<AutomationRun>('runs', 'automationId', automationId) : await DB.all<AutomationRun>('runs');
  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
/** New automations are created DISABLED and in test mode – nothing happens until the user switches them on. */
export function newAutomation(tableId: string, name: string): Automation {
  const t = new Date().toISOString();
  return { id: S.uid('auto'), tableId, name, enabled: false, testMode: true, trigger: { type: 'manual' }, conditions: emptyGroup(), actions: [], createdAt: t, updatedAt: t, runCount: 0 };
}

const isEmptyCell = (v: CellValue | undefined) => isEmptyValue(v);
const sameCell = (a: CellValue | undefined, b: CellValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Does this change fire this trigger? Returns a label (and a repeat-protection key) or null. */
export function triggerMatch(t: Trigger, change: S.Change, fields: Field[], views: View[]): { label: string; key?: string } | null {
  if (change.kind === 'deleted') return null;
  const after = change.record; const before = change.before;
  const val = (r: RecordRow | undefined, id?: string) => (id ? r?.cells[id] : undefined);
  switch (t.type) {
    case 'recordCreated': return change.kind === 'created' ? { label: 'record created' } : null;
    case 'recordUpdated': return change.kind === 'updated' && !sameAllCells(before, after) ? { label: 'record updated' } : null;
    case 'fieldBecomesNonEmpty': { if (!t.fieldId) return null; const was = val(before, t.fieldId); const now = val(after, t.fieldId); return isEmptyCell(was) && !isEmptyCell(now) ? { label: `${nameOf(fields, t.fieldId)} became non-empty`, key: `nonEmpty|${after.id}|${t.fieldId}|${hash(cellText(now))}` } : null; }
    case 'fieldBecomesEmpty': { if (!t.fieldId) return null; return !isEmptyCell(val(before, t.fieldId)) && isEmptyCell(val(after, t.fieldId)) ? { label: `${nameOf(fields, t.fieldId)} became empty` } : null; }
    case 'fieldChanges': { if (!t.fieldId) return null; return change.kind === 'updated' && !sameCell(val(before, t.fieldId), val(after, t.fieldId)) ? { label: `${nameOf(fields, t.fieldId)} changed` } : null; }
    case 'recordEntersView': {
      const v = views.find(x => x.id === t.viewId); if (!v) return null;
      const was = before ? recordMatches(v.filter, fields, before) : false; const now = recordMatches(v.filter, fields, after);
      return !was && now ? { label: `entered view “${v.name}”` } : null;
    }
    default: return null;
  }
}
const nameOf = (fields: Field[], id: string) => fields.find(f => f.id === id)?.name ?? id;
const sameAllCells = (a?: RecordRow, b?: RecordRow) => !!a && !!b && JSON.stringify(a.cells) === JSON.stringify(b.cells);

export interface ExecOpts { chain?: string[]; depth?: number; testMode?: boolean; startIndex?: number; retryOf?: string; logSkipped?: boolean; runId?: string }

export class Engine {
  constructor(public deps: EngineDeps) {}

  // ---------------------------------------------------------------- entry points
  /** Called for every record change made through the store. */
  async handleChange(change: S.Change): Promise<AutomationRun[]> {
    if (change.kind === 'deleted') return [];
    const autos = (await listAutomations(change.tableId)).filter(a => a.enabled); if (!autos.length) return [];
    const [fields, views] = await Promise.all([S.listFields(change.tableId), S.listViews(change.tableId)]);
    const out: AutomationRun[] = [];
    for (const a of autos) {
      const origin = change.origin;
      if (origin && (origin.chain.includes(a.id) || origin.depth >= MAX_DEPTH)) continue;            // loop prevention
      const m = triggerMatch(a.trigger, change, fields, views); if (!m) continue;
      if (m.key && !(await this.remember(a.id, m.key))) continue;                                   // repeat prevention
      const run = await this.execute(a, change.record.id, m.label, { chain: origin?.chain ?? [], depth: origin?.depth ?? 0 });
      if (run) out.push(run);
    }
    return out;
  }

  /** scrapingCompleted / publicationFound are raised by the scraper and the research module. */
  async fire(type: 'scrapingCompleted' | 'publicationFound', recordId: string, detail = ''): Promise<AutomationRun[]> {
    const rec = await S.getRecord(recordId); if (!rec) return [];
    const autos = (await listAutomations(rec.tableId)).filter(a => a.enabled && a.trigger.type === type); const out: AutomationRun[] = [];
    for (const a of autos) {
      if (!(await this.remember(a.id, `${type}|${recordId}|${hash(detail)}`))) continue;
      const run = await this.execute(a, recordId, type === 'scrapingCompleted' ? 'scraping completed' : 'publication found', {}); if (run) out.push(run);
    }
    return out;
  }

  /** Run one automation on chosen records (manual trigger / "Run now" / "Test on this record"). */
  async runManual(automationId: string, recordIds: string[], opts: { testMode?: boolean } = {}): Promise<AutomationRun[]> {
    const a = await getAutomation(automationId); if (!a) throw new Error('Automation not found');
    const out: AutomationRun[] = [];
    for (const id of recordIds) { const r = await this.execute(a, id, 'manual run', { testMode: opts.testMode, logSkipped: true }); if (r) out.push(r); }
    return out;
  }

  /** Scheduled automations: for every record that matches the conditions, at most `maxPerRun` per tick. */
  async runDueScheduled(): Promise<AutomationRun[]> {
    const now = this.deps.now(); const out: AutomationRun[] = [];
    for (const a of (await listAutomations()).filter(x => x.enabled && x.trigger.type === 'scheduled')) {
      const every = Math.max(1, a.trigger.everyMinutes || 60);
      if (a.lastRunAt && now.getTime() - new Date(a.lastRunAt).getTime() < every * 60000) continue;
      const fields = await S.listFields(a.tableId); const recs = (await S.listRecords(a.tableId)).filter(r => recordMatches(a.conditions, fields, r));
      let n = 0; const cap = a.maxPerRun ?? 25;
      for (const r of recs) { if (n >= cap) break; const run = await this.execute(a, r.id, 'scheduled', {}); if (run && run.status !== 'skipped') n++; if (run) out.push(run); }
      await saveAutomation({ ...(await getAutomation(a.id))!, lastRunAt: now.toISOString() });
    }
    return out;
  }

  /** Continue runs that were paused by a Wait action. */
  async processPending(): Promise<AutomationRun[]> {
    const now = this.deps.now().getTime(); const out: AutomationRun[] = [];
    for (const job of (await DB.all<PendingJob>('pending')).filter(j => j.runAt <= now)) {
      await DB.del('pending', job.id);
      const a = await getAutomation(job.payload.automationId); if (!a || !a.enabled) continue;
      const run = await this.execute(a, job.payload.recordId, `${job.payload.trigger} (after wait)`, { chain: job.payload.chain.filter(c => c !== a.id), depth: Math.max(0, job.payload.depth - 1), startIndex: job.payload.fromActionIndex, testMode: job.payload.testMode });
      if (run) out.push(run);
    }
    return out;
  }

  async retryRun(runId: string): Promise<AutomationRun | null> {
    const r = await DB.get<AutomationRun>('runs', runId); if (!r || !r.recordId) return null;
    const a = await getAutomation(r.automationId); if (!a) throw new Error('Automation no longer exists');
    return this.execute(a, r.recordId, `retry of ${r.trigger}`, { retryOf: runId, logSkipped: true });
  }

  // ---------------------------------------------------------------- repeat protection
  private async remember(automationId: string, key: string): Promise<boolean> {
    const kv = `autoKeys:${automationId}`; const keys = ((await DB.kvGet<string[]>(kv, [])) || []);
    if (keys.includes(key)) return false;
    keys.push(key); await DB.kvSet(kv, keys.slice(-20000)); return true;
  }

  // ---------------------------------------------------------------- execution
  async execute(a: Automation, recordId: string, trigger: string, o: ExecOpts): Promise<AutomationRun | null> {
    const chain = [...(o.chain || []), a.id]; const depth = (o.depth || 0) + 1;
    const testMode = o.testMode ?? a.testMode;
    const base: AutomationRun = { id: o.runId || S.uid('run'), automationId: a.id, automationName: a.name, recordId, tableId: a.tableId, at: this.deps.now().toISOString(), status: 'ok', trigger, steps: [], chain, depth, retryOf: o.retryOf };
    const finish = async (run: AutomationRun) => {
      await DB.put('runs', run);
      const cur = await getAutomation(a.id); if (cur && run.status !== 'skipped') await DB.put('automations', { ...cur, lastRunAt: run.at, runCount: (cur.runCount || 0) + (o.startIndex ? 0 : 1) });
      return run;
    };
    if (depth > MAX_DEPTH) return finish({ ...base, status: 'error', error: `Stopped: automations were calling each other more than ${MAX_DEPTH} levels deep.` });

    const rec = await S.getRecord(recordId); if (!rec) return null;
    const fields = await S.listFields(rec.tableId);
    if (!o.startIndex && !recordMatches(a.conditions, fields, rec)) { if (!o.logSkipped) return null; return finish({ ...base, status: 'skipped', error: 'The conditions are not met for this record.' }); }

    const origin: Origin = { automationId: a.id, chain, depth };
    const step = (action: Action, status: RunStep['status'], message: string) => base.steps.push({ actionId: action.id, type: action.type, status, message, at: this.deps.now().toISOString() });
    let any = { error: false, skipped: false, test: false };

    for (let i = o.startIndex || 0; i < a.actions.length; i++) {
      const action = a.actions[i];
      try {
        const live = await S.getRecord(recordId); if (!live) { step(action, 'error', 'The record was deleted'); any.error = true; break; }
        const r = await this.runAction(a, action, live, fields, testMode, origin);
        step(action, r.status, r.message);
        if (r.status === 'error') { any.error = true; break; }
        if (r.status === 'skipped') any.skipped = true; if (r.status === 'test') any.test = true;
        if (r.wait) {
          const job: PendingJob = { id: S.uid('pend'), runAt: this.deps.now().getTime() + r.wait * 1000, kind: 'continueRun', payload: { automationId: a.id, recordId, fromActionIndex: i + 1, chain: chain, depth, trigger, testMode } };
          await DB.put('pending', job); base.status = 'waiting'; break;
        }
      } catch (e: any) { step(action, 'error', String(e?.message || e)); any.error = true; break; }
    }
    if (base.status !== 'waiting') base.status = any.error ? 'error' : testMode || any.test ? 'test' : any.skipped && base.steps.every(s => s.status === 'skipped') ? 'skipped' : 'ok';
    if (any.error) base.error = base.steps.find(s => s.status === 'error')?.message;
    return finish(base);
  }

  private async runAction(a: Automation, action: Action, rec: RecordRow, fields: Field[], testMode: boolean, origin: Origin): Promise<{ status: RunStep['status']; message: string; wait?: number }> {
    const byId = new Map(fields.map(f => [f.id, f])); const tpl = (s: string, r = rec) => renderTemplate(s, templateLookup(fields, computeRecord(fields, r).values));
    const valueFor = (raw: string): string => {
      if (raw.trim().startsWith('=')) { const names = byLowerName(fields); const { values } = computeRecord(fields, rec); const res = evaluateFormula(raw.trim().slice(1), n => { const f = names.get(n.trim().toLowerCase()); if (!f) throw new Error(`Unknown field {${n}}`); return cellText(values[f.id]); }, this.deps.now()); if (res.error) throw new Error(res.error); return cellText(res.value as CellValue); }
      return tpl(raw).text;
    };
    const writable = (f: Field | undefined, label: string) => { if (!f) throw new Error(`${label}: choose a field`); if (['formula', 'createdTime', 'lastModified'].includes(f.type)) throw new Error(`“${f.name}” is calculated and cannot be written to`); return f; };

    switch (action.type) {
      case 'updateField': case 'changeStatus': {
        const f = writable(byId.get((action.type === 'changeStatus' ? action.statusFieldId || action.fieldId : action.fieldId) || ''), action.type === 'changeStatus' ? 'Change status' : 'Update field');
        const text = valueFor(action.type === 'changeStatus' ? action.markStatus ?? action.value ?? '' : action.value ?? '');
        if (testMode) return { status: 'test', message: `would set “${f.name}” to “${text}”` };
        await S.updateRecord(rec.id, { [f.id]: coerceForField(f, text) }, { origin }); return { status: 'ok', message: `set “${f.name}” to “${text.slice(0, 60)}”` };
      }
      case 'createRecord': {
        const tableId = action.tableId || rec.tableId; const tf = await S.listFields(tableId); const cells: Record<string, CellValue> = {};
        for (const [k, v] of Object.entries(action.cells || {})) { const f = tf.find(x => x.id === k); if (f) cells[k] = coerceForField(f, valueFor(v)); }
        if (testMode) return { status: 'test', message: `would create a record in ${tableId === rec.tableId ? 'this table' : 'another table'} with ${Object.keys(cells).length} value(s)` };
        const created = await S.createRecord(tableId, cells, { origin }); return { status: 'ok', message: `created record ${created.id}` };
      }
      case 'runLookup': case 'updatePublication': case 'downloadPdf': {
        let ids: string[] | undefined = action.fieldId ? [action.fieldId] : undefined;
        if (action.type === 'updatePublication') ids = fields.filter(f => f.lookup && f.lookup.kind !== 'search' && f.lookup.kind !== 'pdf').map(f => f.id);
        if (action.type === 'downloadPdf') ids = action.fieldId ? [action.fieldId] : fields.filter(f => f.lookup?.kind === 'pdf').map(f => f.id);
        if (action.type === 'downloadPdf' && !ids?.length) throw new Error('No publication PDF field to fill');
        if (testMode) return { status: 'test', message: `would run ${ids ? ids.map(i => `“${byId.get(i)?.name}”`).join(', ') : 'all research lookups'} (no request is made in test mode)` };
        const run = await runLookups(rec.id, this.deps.research, { fieldIds: ids, origin });
        const done = run.reports.filter(r => r.status === 'filled'); const bad = run.reports.filter(r => r.status === 'error');
        if (run.found) await this.fire('publicationFound', rec.id, rec.id + (run.record.cells[fid('latestPublication')] ?? ''));
        if (bad.length && !done.length) return { status: 'error', message: bad.map(b => `${b.fieldName}: ${b.message}`).join(' · ') };
        const needs = run.reports.find(r => r.status === 'needsMatch');
        return { status: done.length ? 'ok' : 'skipped', message: done.length ? `filled ${done.map(d => d.fieldName).join(', ')}` : needs ? `${needs.fieldName}: ${needs.message}` : run.reports.map(r => `${r.fieldName}: ${r.message}`).slice(0, 3).join(' · ') || 'nothing to do' };
      }
      case 'sendEmail': {
        if (!action.templateId) throw new Error('Choose an e-mail template');
        const live = a.enabled && !testMode;
        const out = await sendRecordEmail(this.deps.email, { recordId: rec.id, templateId: action.templateId, providerId: action.providerId, senderEmail: action.senderEmail, toFieldId: action.toFieldId, automationId: a.id, testMode: !live });
        if (out.status === 'error') return { status: 'error', message: out.message };
        return { status: out.status === 'sent' ? 'ok' : out.status === 'test' ? 'test' : 'skipped', message: out.message };
      }
      case 'wait': {
        const s = Math.max(1, Math.round(action.seconds || 0)); if (testMode) return { status: 'test', message: `would wait ${s} s` };
        return { status: 'ok', message: `waiting ${s} s`, wait: s };
      }
      case 'runAutomation': {
        const target = await getAutomation(action.automationId || ''); if (!target) throw new Error('The automation to run no longer exists');
        if (origin.chain.includes(target.id)) throw new Error(`Running “${target.name}” from here would loop back into itself`);
        if (testMode) return { status: 'test', message: `would run “${target.name}”` };
        const sub = await this.execute(target, rec.id, `called by “${a.name}”`, { chain: origin.chain, depth: origin.depth, logSkipped: true });
        return { status: sub?.status === 'error' ? 'error' : 'ok', message: `ran “${target.name}” → ${sub?.status ?? 'nothing'}${sub?.error ? ` (${sub.error})` : ''}` };
      }
    }
  }
}

/** For the Automation Builder: a plain-language sentence for the trigger. */
export function describeTrigger(t: Trigger, fields: Field[], views: View[]): string {
  const f = t.fieldId ? nameOf(fields, t.fieldId) : '…'; const v = views.find(x => x.id === t.viewId)?.name ?? '…';
  return ({ recordCreated: 'When a record is created', recordUpdated: 'When a record is updated', fieldBecomesNonEmpty: `When “${f}” becomes non-empty`, fieldBecomesEmpty: `When “${f}” becomes empty`, fieldChanges: `When “${f}” changes`, recordEntersView: `When a record enters “${v}”`, scrapingCompleted: 'When scraping a record completes', publicationFound: 'When a publication is found', scheduled: `Every ${t.everyMinutes || 60} minutes`, manual: 'When you run it manually' } as Record<string, string>)[t.type];
}
