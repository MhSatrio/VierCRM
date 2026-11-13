// CSV import / export (RFC 4180 quoting, UTF-8 BOM for Excel, formula-injection guard on export).
import type { CellValue, Field } from './types';
import { cellText, coerceForField } from './values';

export function parseCsv(text: string): string[][] {
  let s = text.replace(/^﻿/, '');
  const first = s.split(/\r?\n/, 1)[0] || '';
  const delim = (first.match(/;/g)?.length || 0) > (first.match(/,/g)?.length || 0) ? ';' : (first.match(/\t/g)?.length || 0) > (first.match(/,/g)?.length || 0) ? '\t' : ',';
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

const guard = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(fields: Field[], rows: Record<string, CellValue>[]): string {
  const cols = fields.filter(f => !f.hidden || true);
  const lines = [cols.map(f => quote(f.name)).join(',')];
  for (const r of rows) lines.push(cols.map(f => quote(guard(cellText(r[f.id])))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export interface CsvMapping { column: number; fieldId: string | null }

/** Match CSV headers to fields by name (case-insensitive); anything unmatched is left unmapped for the user to choose. */
export function autoMap(header: string[], fields: Field[]): CsvMapping[] {
  const byName = new Map(fields.filter(f => !['formula', 'createdTime', 'lastModified'].includes(f.type)).map(f => [f.name.trim().toLowerCase(), f.id]));
  return header.map((h, column) => ({ column, fieldId: byName.get(h.trim().toLowerCase()) ?? null }));
}

export function rowsFromCsv(grid: string[][], mapping: CsvMapping[], fields: Field[]): Record<string, CellValue>[] {
  const byId = new Map(fields.map(f => [f.id, f]));
  return grid.slice(1).map(r => {
    const cells: Record<string, CellValue> = {};
    // (the export prefixes risky cells such as "+31 …" with an apostrophe so spreadsheets never run them as formulas; undo exactly that)
    for (const m of mapping) { if (!m.fieldId) continue; const f = byId.get(m.fieldId); if (!f) continue; const v = coerceForField(f, (r[m.column] ?? '').replace(/^'([=+\-@])/, '$1')); if (v != null) cells[m.fieldId] = v; }
    return cells;
  }).filter(c => Object.keys(c).length > 0);
}
