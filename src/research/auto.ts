// Auto-research: in a base with the research fields and "Find research automatically" switched on, every record that HAS a name but NO latest
// publication is looked up (OpenAlex / Crossref / … – the field's own sources) without the user doing anything.
//   · slow on purpose: a few records per minute, the same pace as manual lookups;
//   · a person who cannot be found is retried after 7 days, a failed request after 1 hour, an ambiguous match never until the user chooses;
//   · nothing is ever invented: ambiguous people wait in "Needs match".
import * as S from '../core/store';
import { cellText, isEmptyValue } from '../core/values';
import type { Field, RecordRow, Table } from '../core/types';
import type { Ctx } from './http';
import { runLookups } from './lookup';

export const RETRY_NONE_MS = 7 * 86400000;
export const RETRY_ERROR_MS = 3600000;
export const PER_TICK = 5;

/** the field whose emptiness triggers a lookup, and the field holding the person's name */
export function searchTarget(fields: Field[]): { search: Field; name: Field } | null {
  const search = fields.find(f => f.lookup?.kind === 'search'); if (!search) return null;
  const name = fields.find(f => f.id === search.lookup!.nameFieldId); return name ? { search, name } : null;
}

/** Records that should be researched now (newest first). Pure – no network, no writes. */
export function findCandidates(fields: Field[], records: RecordRow[], now: number, limit = PER_TICK): RecordRow[] {
  const t = searchTarget(fields); if (!t) return [];
  const out: RecordRow[] = [];
  for (const r of records) {
    if (cellText(r.cells[t.name.id]).trim().length < 3) continue;
    if (!isEmptyValue(r.cells[t.search.id])) continue;
    if (r.meta?.pending?.[t.search.id]) continue;
    const a = r.meta?.autoTried;
    if (a) {
      const age = now - new Date(a.at).getTime();
      if (a.outcome === 'needsMatch') continue;
      if (a.outcome === 'error' && age < RETRY_ERROR_MS) continue;
      if ((a.outcome === 'none' || a.outcome === 'found') && age < RETRY_NONE_MS) continue;
    }
    out.push(r);
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out.slice(0, limit);
}

export interface AutoResult { tableId: string; recordId: string; outcome: 'found' | 'none' | 'needsMatch' | 'error' }

/** Look up these records (already filtered with findCandidates). */
async function researchRecords(tableId: string, fields: Field[], recs: RecordRow[], ctx: Ctx, now: number): Promise<AutoResult[]> {
  const t = searchTarget(fields); const done: AutoResult[] = []; if (!t) return done; const fieldIds = fields.filter(f => f.lookup && f.lookup.kind !== 'pdf').map(f => f.id);
  for (const rec of recs) {
    let outcome: AutoResult['outcome'] = 'error';
    try {
      const run = await runLookups(rec.id, ctx, { fieldIds });   // metadata only – PDFs are downloaded on request, never in bulk
      const rep = run.reports.find(x => x.fieldId === t.search.id);
      outcome = rep?.status === 'filled' ? 'found' : rep?.status === 'needsMatch' ? 'needsMatch' : rep?.status === 'error' ? 'error' : 'none';
    } catch { outcome = 'error'; }
    await S.updateRecord(rec.id, {}, { silent: true, meta: { autoTried: { at: new Date(now).toISOString(), outcome } } });
    done.push({ tableId, recordId: rec.id, outcome });
  }
  return done;
}

/** Research up to `limit` records of one base. `more` tells the caller whether anything is still waiting. */
export async function autoResearchTable(table: Table, ctx: Ctx, limit = PER_TICK, now = Date.now()): Promise<{ done: AutoResult[]; more: boolean }> {
  const fields = await S.listFields(table.id); if (!searchTarget(fields)) return { done: [], more: false };
  const all = findCandidates(fields, await S.listRecords(table.id), now, limit + 1);
  return { done: await researchRecords(table.id, fields, all.slice(0, limit), ctx, now), more: all.length > limit };
}

/** The records the user is looking at right now (a view): the same rules, in small batches, so what is on screen fills in first. */
export async function autoResearchRecords(table: Table, ctx: Ctx, recordIds: string[], limit = PER_TICK, now = Date.now()): Promise<AutoResult[]> {
  if (!table.autoResearch) return [];
  const fields = await S.listFields(table.id); const recs = (await Promise.all(recordIds.slice(0, 200).map(id => S.getRecord(id)))).filter((r): r is RecordRow => !!r && r.tableId === table.id);
  return researchRecords(table.id, fields, findCandidates(fields, recs, now, limit), ctx, now);
}

/** One scheduler step across the given bases: stops after `limit` records in total. */
export async function autoResearchTick(ctx: Ctx, tableIds: string[], limit = PER_TICK): Promise<{ done: AutoResult[]; pending: string[] }> {
  const done: AutoResult[] = []; const pending: string[] = [];
  for (const id of tableIds) {
    const left = limit - done.length; if (left <= 0) { pending.push(id); continue; }
    const t = await S.getTable(id); if (!t?.autoResearch) continue;
    const r = await autoResearchTable(t, ctx, left); done.push(...r.done); if (r.more) pending.push(id);
  }
  return { done, pending };
}
