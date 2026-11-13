// Duplicate detection with configurable matching rules. A rule matches when ALL of its fields are non-empty and equal (after
// normalisation); a record is a duplicate when ANY rule matches.
import type { CellValue, Field, RecordRow } from './types';
import { cellText } from './values';

export type Normalizer = 'text' | 'email' | 'url' | 'doi';
export interface DedupeRule {
  id: string; name: string; fieldIds: string[]; normalize: Normalizer; enabled: boolean;
  /** weak rules (matching on a name) never match when BOTH records have a value in one of these fields and the values differ – two different people can share a name */
  unlessDifferent?: { fieldId: string; normalize: Normalizer }[];
}

export const normalizeValue = (raw: string, kind: Normalizer): string => {
  const s = raw.trim().toLowerCase();
  if (!s) return '';
  switch (kind) {
    case 'email': return s.replace(/^mailto:/, '').replace(/\s+/g, '');
    case 'doi': return s.replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
    case 'url': { try { const u = new URL(s.startsWith('http') ? s : `https://${s}`); return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`; } catch { return s.replace(/\/+$/, ''); } }
    default: return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
};

/** Rules for the Researchers base (field ids are the stable default ids); other bases get theirs from defaults.rulesFor. */
export const defaultDedupeRules = (idOf: (key: string) => string): DedupeRule[] => [
  { id: 'dd-email', name: 'Same e-mail address', fieldIds: [idOf('email')], normalize: 'email', enabled: true },
  { id: 'dd-profile', name: 'Same profile URL', fieldIds: [idOf('profileUrl')], normalize: 'url', enabled: true },
  { id: 'dd-doi', name: 'Same publication DOI', fieldIds: [idOf('publicationDoi')], normalize: 'doi', enabled: false },
  { id: 'dd-name-inst', name: 'Same name at the same institution (unless e-mail or profile differ)', fieldIds: [idOf('fullName'), idOf('institution')], normalize: 'text', enabled: true, unlessDifferent: [{ fieldId: idOf('email'), normalize: 'email' }, { fieldId: idOf('profileUrl'), normalize: 'url' }] },
];

const keyFor = (rule: DedupeRule, cells: Record<string, CellValue>): string | null => {
  const parts = rule.fieldIds.map(id => normalizeValue(cellText(cells[id]), rule.normalize));
  return parts.every(Boolean) ? `${rule.id}|${parts.join('|')}` : null;
};

export interface DuplicateHit { record: RecordRow; rule: DedupeRule }

/** Index existing records once, then look candidates up in O(1) – needed when scraping thousands of researchers. */
export function buildDedupeIndex(records: RecordRow[], rules: DedupeRule[]) {
  const active = rules.filter(r => r.enabled);
  const index = new Map<string, RecordRow>();
  // the newest version of a record always replaces the older one under the same key (a merged record must be found with its new values)
  const add = (rec: RecordRow) => { for (const r of active) { const k = keyFor(r, rec.cells); if (k) index.set(k, rec); } };
  records.forEach(add);
  return {
    add,
    find(cells: Record<string, CellValue>): DuplicateHit | null {
      for (const r of active) {
        const k = keyFor(r, cells); const hit = k && index.get(k); if (!hit) continue;
        const conflict = (r.unlessDifferent || []).some(u => { const a = normalizeValue(cellText(cells[u.fieldId]), u.normalize); const b = normalizeValue(cellText(hit.cells[u.fieldId]), u.normalize); return !!a && !!b && a !== b; });
        if (!conflict) return { record: hit, rule: r };
      }
      return null;
    },
  };
}

/** Existing values always win: scraping a profile again only fills in what was empty. */
export function fillEmptyCells(existing: Record<string, CellValue>, incoming: Record<string, CellValue>, fields: Field[]): { cells: Record<string, CellValue>; changed: string[] } {
  const cells = { ...existing }; const changed: string[] = [];
  for (const f of fields) {
    if (f.type === 'formula' || f.type === 'createdTime' || f.type === 'lastModified') continue;
    const inc = incoming[f.id]; if (inc == null || cellText(inc).trim() === '') continue;
    if (cellText(cells[f.id]).trim() === '') { cells[f.id] = inc; changed.push(f.id); }
  }
  return { cells, changed };
}
