// View filters / automation conditions: AND / OR / NOT groups of field conditions.
import type { CellValue, Condition, ConditionGroup, Field, Op, RecordRow, SortSpec } from './types';
import { cellText, computeRecord, computeRecordCached, isEmptyValue } from './values';

export const emptyGroup = (): ConditionGroup => ({ kind: 'group', match: 'and', items: [] });
export const cond = (fieldId: string, op: Op, value?: string | number | boolean): Condition => ({ kind: 'condition', fieldId, op, value });
export const group = (match: 'and' | 'or', ...items: (Condition | ConditionGroup)[]): ConditionGroup => ({ kind: 'group', match, items });

export const OP_LABEL: Record<Op, string> = {
  is: 'is', isNot: 'is not', contains: 'contains', notContains: 'does not contain', isEmpty: 'is empty', isNotEmpty: 'is not empty',
  gt: 'is greater than', lt: 'is less than', gte: 'is at least', lte: 'is at most', before: 'is before', after: 'is after', isTrue: 'is checked', isFalse: 'is not checked',
};
export const OPS_FOR: Record<string, Op[]> = {
  text: ['contains', 'notContains', 'is', 'isNot', 'isEmpty', 'isNotEmpty'],
  number: ['is', 'isNot', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  date: ['is', 'before', 'after', 'isEmpty', 'isNotEmpty'],
  checkbox: ['isTrue', 'isFalse'],
  select: ['is', 'isNot', 'contains', 'isEmpty', 'isNotEmpty'],
  attachment: ['isEmpty', 'isNotEmpty'],
};
export function opsForType(t: Field['type']): Op[] {
  if (t === 'number') return OPS_FOR.number;
  if (t === 'date' || t === 'createdTime' || t === 'lastModified') return OPS_FOR.date;
  if (t === 'checkbox') return OPS_FOR.checkbox;
  if (t === 'singleSelect' || t === 'multiSelect' || t === 'scrapingStatus' || t === 'emailStatus' || t === 'publicationStatus') return OPS_FOR.select;
  if (t === 'attachment') return OPS_FOR.attachment;
  return OPS_FOR.text;
}
export const NO_VALUE: Op[] = ['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'];

const low = (v: CellValue) => cellText(v).trim().toLowerCase();
const asNum = (v: CellValue) => { const s = cellText(v).trim().replace(/,/g, ''); return s === '' ? NaN : Number(s); };
const asTime = (s: string) => { if (s.trim().toLowerCase() === 'today') { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); } const t = new Date(s).getTime(); return Number.isNaN(t) ? NaN : t; };

export function evalCondition(c: Condition, values: Record<string, CellValue>): boolean {
  const v = values[c.fieldId]; const target = c.value == null ? '' : String(c.value);
  switch (c.op) {
    case 'isEmpty': return isEmptyValue(v);
    case 'isNotEmpty': return !isEmptyValue(v);
    case 'isTrue': return v === true || low(v) === 'true';
    case 'isFalse': return !(v === true || low(v) === 'true');
    case 'is': { if (!Number.isNaN(asNum(v)) && target.trim() !== '' && !Number.isNaN(Number(target))) return asNum(v) === Number(target); if (Array.isArray(v)) return v.some(x => x.toLowerCase() === target.toLowerCase()); const tv = asTime(target); return low(v) === target.trim().toLowerCase() || (!Number.isNaN(tv) && /^\d{4}-\d{2}-\d{2}/.test(cellText(v)) && asTime(cellText(v).slice(0, 10)) === tv); }
    case 'isNot': return !evalCondition({ ...c, op: 'is' }, values);
    case 'contains': return low(v).includes(target.trim().toLowerCase());
    case 'notContains': return !low(v).includes(target.trim().toLowerCase());
    case 'gt': case 'lt': case 'gte': case 'lte': {
      const a = asNum(v); const b = Number(target); if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return c.op === 'gt' ? a > b : c.op === 'lt' ? a < b : c.op === 'gte' ? a >= b : a <= b;
    }
    case 'before': case 'after': {
      const a = asTime(cellText(v).slice(0, 10)); const b = asTime(target); if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return c.op === 'before' ? a < b : a > b;
    }
  }
}

export function evalGroup(g: ConditionGroup, values: Record<string, CellValue>): boolean {
  if (!g.items.length) return !g.not;       // an empty filter shows everything (and "NOT nothing" shows nothing)
  const and = g.match === 'and'; let r = and;
  for (const i of g.items) { const ok = i.kind === 'group' ? evalGroup(i, values) : evalCondition(i, values); if (and ? !ok : ok) { r = !and; break; } }      // stops at the first decisive condition
  return g.not ? !r : r;
}

export function recordMatches(g: ConditionGroup, fields: Field[], rec: RecordRow): boolean { return evalGroup(g, computeRecord(fields, rec).values); }

export interface RowView { rec: RecordRow; values: Record<string, CellValue> }

const collator = new Intl.Collator(undefined, { numeric: true });
/** Lower-cased text of every visible field, built once per (field list, record object) – a keystroke in the search box is then one `includes` per record. */
const blobs = new WeakMap<Field[], WeakMap<RecordRow, string>>();
function searchBlob(fields: Field[], rec: RecordRow, values: Record<string, CellValue>): string {
  let m = blobs.get(fields); if (!m) { m = new WeakMap(); blobs.set(fields, m); }
  let b = m.get(rec); if (b === undefined) { b = ''; for (const f of fields) if (!f.hidden) { const t = cellText(values[f.id]); if (t) b += t.toLowerCase() + '\u0001'; } m.set(rec, b); }
  return b;
}

export function applyFilterSort(fields: Field[], records: RecordRow[], filter: ConditionGroup, sort: SortSpec[], search = ''): RowView[] {
  const q = search.trim().toLowerCase();
  const rows: RowView[] = [];
  for (const rec of records) {
    const { values } = computeRecordCached(fields, rec);
    if (!evalGroup(filter, values)) continue;
    if (q && !searchBlob(fields, rec, values).includes(q)) continue;
    rows.push({ rec, values });
  }
  if (!sort.length) return rows;
  // sort keys are computed once per row (not once per comparison) and compared with one shared collator
  const fieldById = new Map(fields.map(f => [f.id, f]));
  const keyed = rows.map(r => ({ r, k: sort.map(s => { const f = fieldById.get(s.fieldId); const v = r.values[s.fieldId]; if (isEmptyValue(v)) return null; if (f?.type === 'number') return asNum(v); if (f?.type === 'checkbox') return v ? 1 : 0; return cellText(v).toLowerCase(); }) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < sort.length; i++) {
      const x = a.k[i], y = b.k[i];
      if (x == null && y == null) continue; if (x == null) return 1; if (y == null) return -1;      // empty values always last
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
      if (r) return sort[i].dir === 'desc' ? -r : r;
    }
    return 0;
  });
  return keyed.map(x => x.r);
}
