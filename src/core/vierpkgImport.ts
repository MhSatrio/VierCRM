// Writes a Vier package into a base: creates the missing fields (when allowed), then the records, skipping the ones imported before
// (same externalId) and the ones the base's duplicate rules already know. No automation runs for imported records (silent writes).
import * as S from './store';
import { buildDedupeIndex } from './dedupe';
import { cellsFor, planImport, type VierPackage } from './vierpkg';

export interface ImportResult { created: number; duplicates: number; alreadyImported: number; newFields: number; unmatched: string[] }

export async function importPackage(tableId: string, pkg: VierPackage, o: { createMissing: boolean }): Promise<ImportResult> {
  const records = await S.listRecords(tableId);
  const existing = new Set(records.flatMap(r => r.meta?.external ?? []));
  const plan = planImport(pkg, await S.listFields(tableId), existing, o);
  const made: Record<string, string> = {};
  for (const m of plan.map) if (m.create) made[m.pkgName] = (await S.addField(tableId, { name: m.create.name, type: m.create.type })).id;
  const fields = await S.listFields(tableId);
  const target = new Map(plan.map.map(m => [m.pkgName, m.fieldId ?? made[m.pkgName] ?? null]));
  const index = buildDedupeIndex(await S.listRecords(tableId), await S.getDedupeRules(tableId));
  let created = 0; let duplicates = 0;
  for (const row of plan.rows) {
    const cells = cellsFor(pkg, row, fields, n => target.get(n) ?? null);
    if (index.find(cells)) { duplicates++; continue; }
    const r = await S.createRecord(tableId, cells, { silent: true, sourceUrl: row.sourceUrl, meta: row.externalId ? { external: [row.externalId] } : undefined });
    index.add(r); created++;
  }
  return { created, duplicates, alreadyImported: plan.skippedExisting, newFields: Object.keys(made).length, unmatched: plan.unmatched };
}
