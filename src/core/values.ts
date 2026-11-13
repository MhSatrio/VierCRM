// Turning stored cell values into text / typed values, including the computed field types (formula, created / modified time).
import type { AttachmentValue, CellValue, Field, RecordRow } from './types';
import { evaluateFormula, type FValue } from './formula';

export const isAttachment = (v: unknown): v is AttachmentValue => !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as AttachmentValue).files);

export function isEmptyValue(v: CellValue | FValue | undefined): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'boolean') return v === false;
  if (Array.isArray(v)) return v.length === 0;
  if (isAttachment(v)) return v.files.length === 0;
  return false;
}

/** Readable text for any cell (CSV export, templates, search, filters). */
export function cellText(v: CellValue | FValue | undefined): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.join(', ');
  if (isAttachment(v)) return v.files.map(f => f.name).join(', ') || (v.unavailable ?? '');
  return '';
}

export const byLowerName = (fields: Field[]) => new Map(fields.map(f => [f.name.trim().toLowerCase(), f]));

const NO_ERRORS: Record<string, string> = Object.freeze({}) as Record<string, string>;
const hasFormula = new WeakMap<Field[], boolean>();
/** All values of one record, computed fields included. Formula errors are returned in `errors`. */
export function computeRecord(fields: Field[], rec: RecordRow, now = new Date()): { values: Record<string, CellValue>; errors: Record<string, string> } {
  // fast path (the usual case): no formula field → plain copy, no name map, no closures
  let hf = hasFormula.get(fields); if (hf === undefined) { hf = fields.some(f => f.type === 'formula'); hasFormula.set(fields, hf); }
  if (!hf) {
    const values: Record<string, CellValue> = {}; const cells = rec.cells;
    for (let i = 0; i < fields.length; i++) { const f = fields[i]; values[f.id] = f.type === 'createdTime' ? rec.createdAt : f.type === 'lastModified' ? rec.updatedAt : (cells[f.id] ?? null); }
    return { values, errors: NO_ERRORS };
  }
  const values: Record<string, CellValue> = {}; const errors: Record<string, string> = {};
  const names = byLowerName(fields);
  const visiting = new Set<string>();
  const valueOf = (f: Field): CellValue => {
    if (f.id in values) return values[f.id];
    if (f.type === 'createdTime') return (values[f.id] = rec.createdAt);
    if (f.type === 'lastModified') return (values[f.id] = rec.updatedAt);
    if (f.type === 'formula') {
      if (visiting.has(f.id)) { errors[f.id] = 'Circular reference between formulas'; return (values[f.id] = null); }
      visiting.add(f.id);
      const src = f.options?.formula || '';
      const r = evaluateFormula(src, name => {
        const t = names.get(name.trim().toLowerCase());
        if (!t) throw new Error(`Unknown field {${name}}`);
        const v = valueOf(t);
        if (t.type === 'number' && typeof v === 'string' && v.trim() !== '') return Number(v);
        return isAttachment(v) ? cellText(v) : Array.isArray(v) ? v.join(', ') : (v as FValue);
      }, now);
      visiting.delete(f.id);
      if (r.error) { errors[f.id] = r.error; return (values[f.id] = null); }
      return (values[f.id] = r.value instanceof Date ? r.value.toISOString() : (r.value as CellValue));
    }
    return (values[f.id] = rec.cells[f.id] ?? null);
  };
  for (const f of fields) valueOf(f);
  return { values, errors };
}

/** Computed once per (field list, record object): changing a view, a filter, the sort or the search never recomputes unchanged records. */
const computed = new WeakMap<Field[], WeakMap<RecordRow, { values: Record<string, CellValue>; errors: Record<string, string> }>>();
export function computeRecordCached(fields: Field[], rec: RecordRow) {
  let m = computed.get(fields); if (!m) { m = new WeakMap(); computed.set(fields, m); }
  let r = m.get(rec); if (!r) { r = computeRecord(fields, rec); m.set(rec, r); } return r;
}

/** Field name → text, for templates. Returns undefined for a name the table does not have. */
export function templateLookup(fields: Field[], values: Record<string, CellValue>) {
  const names = byLowerName(fields);
  return (name: string): string | undefined => { const f = names.get(name.trim().toLowerCase()); return f ? cellText(values[f.id]) : undefined; };
}

export function coerceForField(f: Field, raw: string): CellValue {
  const s = raw.trim();
  if (s === '') return null;
  switch (f.type) {
    case 'number': { const n = Number(s.replace(/,/g, '')); return Number.isNaN(n) ? null : n; }
    case 'checkbox': return /^(1|true|yes|y|x|✓)$/i.test(s);
    case 'multiSelect': return s.split(/[;,|]/).map(x => x.trim()).filter(Boolean);
    case 'email': return s.toLowerCase();
    case 'date': { const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10); }
    default: return s;
  }
}
