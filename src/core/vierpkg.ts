// Vier package format v1 (see vier-contracts/SPEC.md): this app READS packages written by other Vier apps (Job Search today).
// The validator is this app's copy of vier-contracts/vierpkg.mjs; its tests read the shared sample file so the copies stay in step.
import type { CellValue, Field, FieldType } from './types';
import { coerceForField } from './values';

export const FORMAT = 'vierpkg';
export const VERSION = 1;
export const LIMITS = { records: 50000, fields: 100, text: 20000, name: 120 };
export const PKG_FIELD_TYPES = ['text', 'longText', 'email', 'phone', 'url', 'number', 'date', 'checkbox', 'singleSelect', 'multiSelect'] as const;
export type PkgFieldType = (typeof PKG_FIELD_TYPES)[number];

export interface PkgField { name: string; type: PkgFieldType; key?: string }
export interface PkgRecord { externalId?: string; sourceUrl?: string; values: Record<string, unknown> }
export interface VierPackage { format: 'vierpkg'; version: 1; type: 'records'; source: { app: string; version?: string; exportedAt?: string }; table: { name?: string; fields: PkgField[] }; records: PkgRecord[] }

const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === 'object' && !Array.isArray(x);

export function validatePackage(pkg: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = []; const bad = (m: string) => { if (errors.length < 20) errors.push(m); };
  if (!isObj(pkg)) return { ok: false, errors: ['The file is not a Vier package (it is not a JSON object).'] };
  if (pkg.format !== FORMAT) return { ok: false, errors: ['The file is not a Vier package (its "format" is not "vierpkg").'] };
  if (pkg.version !== VERSION) return { ok: false, errors: [`This package is version ${String(pkg.version)}; this app reads version ${VERSION}.`] };
  if (pkg.type !== 'records') return { ok: false, errors: [`Package type "${String(pkg.type)}" is not supported (only "records").`] };
  if (!isObj(pkg.source) || typeof pkg.source.app !== 'string' || !pkg.source.app) bad('source.app is missing.');
  if (!isObj(pkg.table) || !Array.isArray(pkg.table.fields)) return { ok: false, errors: [...errors, 'table.fields is missing.'] };
  if (!Array.isArray(pkg.records)) return { ok: false, errors: [...errors, 'records is missing.'] };
  if (pkg.table.fields.length === 0 || pkg.table.fields.length > LIMITS.fields) bad(`A package needs 1 to ${LIMITS.fields} fields.`);
  if (pkg.records.length > LIMITS.records) bad(`A package may hold at most ${LIMITS.records} records.`);
  const names = new Set<string>(); const types = new Map<string, string>();
  pkg.table.fields.forEach((f: any, i: number) => {
    if (!isObj(f) || typeof f.name !== 'string' || !f.name.trim() || f.name.length > LIMITS.name) return bad(`Field ${i + 1} has no valid name.`);
    if (!(PKG_FIELD_TYPES as readonly string[]).includes(f.type)) return bad(`Field "${f.name}" has an unknown type "${String(f.type)}".`);
    if (f.key !== undefined && (typeof f.key !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(f.key))) bad(`Field "${f.name}" has an invalid key.`);
    if (names.has(f.name.toLowerCase())) bad(`Two fields are called "${f.name}".`);
    names.add(f.name.toLowerCase()); types.set(f.name, f.type);
  });
  const ids = new Set<string>();
  pkg.records.forEach((r: any, i: number) => {
    if (errors.length >= 20) return;
    if (!isObj(r) || !isObj(r.values)) return bad(`Record ${i + 1} has no values.`);
    if (r.externalId !== undefined) { if (typeof r.externalId !== 'string' || !r.externalId || r.externalId.length > 200) bad(`Record ${i + 1} has an invalid externalId.`); else if (ids.has(r.externalId)) bad(`externalId "${r.externalId}" appears twice.`); else ids.add(r.externalId); }
    if (r.sourceUrl !== undefined && (typeof r.sourceUrl !== 'string' || !/^https?:\/\//i.test(r.sourceUrl))) bad(`Record ${i + 1}: sourceUrl must be an http(s) address.`);
    for (const [k, v] of Object.entries(r.values)) {
      const t = types.get(k);
      if (!t) { bad(`Record ${i + 1}: "${k}" is not a field of this package.`); continue; }
      if (v === null || v === undefined || v === '') continue;
      const okType = t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'checkbox' ? typeof v === 'boolean' : t === 'multiSelect' ? Array.isArray(v) && v.every(x => typeof x === 'string') : typeof v === 'string';
      if (!okType) bad(`Record ${i + 1}: "${k}" does not match its type (${t}).`);
      else if (typeof v === 'string' && v.length > LIMITS.text) bad(`Record ${i + 1}: "${k}" is longer than ${LIMITS.text} characters.`);
    }
  });
  return { ok: errors.length === 0, errors };
}

const isComputed = (f: Field) => ['formula', 'createdTime', 'lastModified', 'attachment', 'scrapingStatus', 'emailStatus', 'publicationStatus'].includes(f.type);

export interface ImportPlan {
  /** one entry per package field: the base's field it goes into, a field to create, or nothing */
  map: { pkgName: string; fieldId: string | null; create?: { name: string; type: FieldType }; how: 'key' | 'name' | 'new' | 'none' }[];
  /** the records to import: their place in the package, and the identity they carry */
  rows: { index: number; externalId?: string; sourceUrl?: string }[];
  skippedExisting: number;
  /** package fields that go nowhere because "create missing fields" is off or the matching field is calculated */
  unmatched: string[];
}

/**
 * Decides where each package field goes (by key, then by name, otherwise a new field if allowed). Records whose externalId was
 * imported before are skipped. Pure: new fields are created by the caller, which then converts the values with cellsFor.
 */
export function planImport(pkg: VierPackage, fields: Field[], existingExternalIds: Set<string>, o: { createMissing: boolean }): ImportPlan {
  const usable = fields.filter(f => !isComputed(f));
  const used = new Set<string>();
  const map: ImportPlan['map'] = pkg.table.fields.map(pf => {
    const byKey = pf.key ? usable.find(f => f.key === pf.key && !used.has(f.id)) : undefined;
    const hit = byKey ?? usable.find(f => f.name.trim().toLowerCase() === pf.name.trim().toLowerCase() && !used.has(f.id));
    if (hit) { used.add(hit.id); return { pkgName: pf.name, fieldId: hit.id, how: byKey ? 'key' as const : 'name' as const }; }
    if (o.createMissing) return { pkgName: pf.name, fieldId: null, create: { name: pf.name, type: pf.type as FieldType }, how: 'new' as const };
    return { pkgName: pf.name, fieldId: null, how: 'none' as const };
  });
  const unmatched = map.filter(m => m.how === 'none').map(m => m.pkgName);
  const rows: ImportPlan['rows'] = []; let skippedExisting = 0;
  pkg.records.forEach((r, index) => {
    if (r.externalId && existingExternalIds.has(r.externalId)) { skippedExisting++; return; }
    rows.push({ index, externalId: r.externalId, sourceUrl: r.sourceUrl });
  });
  return { map, rows, skippedExisting, unmatched };
}

/** The cells of one record to import, keyed by field id. `fieldIdFor` resolves a package field name to a field id (created ones included). */
export function cellsFor(pkg: VierPackage, row: ImportPlan['rows'][number], fields: Field[], fieldIdFor: (pkgName: string) => string | null): Record<string, CellValue> {
  const byId = new Map(fields.map(f => [f.id, f]));
  const r = pkg.records[row.index]; const cells: Record<string, CellValue> = {};
  for (const pf of pkg.table.fields) {
    const v = r.values[pf.name]; const id = fieldIdFor(pf.name);
    if (!id || v === null || v === undefined || v === '') continue;
    const f = byId.get(id);
    cells[id] = pf.type === 'number' ? Number(v) : pf.type === 'checkbox' ? Boolean(v) : pf.type === 'multiSelect' ? (v as string[]) : f ? coerceForField(f, String(v)) : String(v);
  }
  return cells;
}
