// Spreadsheet clipboard for the grid: a range of cells to tab-separated text (what Excel, Google Sheets and LibreOffice put on the
// clipboard) and back. Pure: nothing here touches the database, so a paste can be planned, shown and undone.
import type { CellValue, Field, RecordRow } from './types';
import type { RowView } from './filters';
import { cellText, coerceForField } from './values';

/** A block of cells in the visible grid: rows and columns are positions in the visible rows and visible fields (inclusive). */
export interface CellRange { r1: number; c1: number; r2: number; c2: number }
export const normRange = (a: { r: number; c: number }, b: { r: number; c: number }): CellRange => ({ r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) });

/** Fields whose value the app computes or stores as files: they are never written by a paste. */
export const isReadOnlyField = (f: Field) => ['formula', 'createdTime', 'lastModified', 'attachment'].includes(f.type);

/** Tab-separated text as Excel writes it: a cell holding a tab, a line break or a quote is wrapped in quotes. */
export function toTsv(grid: string[][]): string {
  return grid.map(r => r.map(v => (/[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join('\t')).join('\r\n');
}

/** Reads tab-separated text. Empty cells and empty lines are kept (a blank line in a pasted column is a blank cell); one final line break is ignored. */
export function parseTsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false; let touched = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"' && cell === '') { q = true; touched = true; }
    else if (c === '\t') { row.push(cell); cell = ''; touched = true; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; touched = false; }
    else { cell += c; touched = true; }
  }
  if (touched || cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** The text of a range, one line per row. A formula copies the number or text it shows, not its formula. */
export function copyRange(rows: RowView[], fields: Field[], range: CellRange): string {
  const grid: string[][] = [];
  for (let r = range.r1; r <= Math.min(range.r2, rows.length - 1); r++) {
    const line: string[] = [];
    for (let c = range.c1; c <= Math.min(range.c2, fields.length - 1); c++) line.push(cellText(rows[r].values[fields[c].id]));
    grid.push(line);
  }
  return toTsv(grid);
}

export interface PastedRecord { recordId: string; cells: Record<string, CellValue>; /** the values before, for Undo (undefined = the cell was empty) */ before: Record<string, CellValue | undefined> }
export interface PastePlan {
  updates: PastedRecord[]; cells: number;
  skipped: { row: number; field: string; why: string }[];
  /** lines below the last visible row, and columns right of the last visible field: not written */
  ignoredRows: number; ignoredCols: number; readOnly: number;
}

/**
 * Plans a paste of `grid` with its top-left cell at (start.r, start.c). One value pasted over a selection of several cells fills the whole
 * selection (spreadsheet behaviour). Calculated and file fields are skipped; a text that is not a number is not written into a number field.
 */
export function planPaste(o: { grid: string[][]; start: { r: number; c: number }; rows: RowView[]; fields: Field[]; fill?: CellRange | null }): PastePlan {
  const { grid, rows, fields } = o;
  const plan: PastePlan = { updates: [], cells: 0, skipped: [], ignoredRows: 0, ignoredCols: 0, readOnly: 0 };
  const byRec = new Map<string, PastedRecord>();
  const put = (r: number, c: number, raw: string) => {
    if (r >= rows.length) { plan.ignoredRows++; return; }
    const f = fields[c]; if (!f) { plan.ignoredCols++; return; }
    if (isReadOnlyField(f)) { plan.readOnly++; return; }
    const rec: RecordRow = rows[r].rec;
    const t = raw.trim();
    const value = coerceForField(f, raw);
    if (f.type === 'number' && t !== '' && value === null) { plan.skipped.push({ row: r + 1, field: f.name, why: `“${t.slice(0, 30)}” is not a number` }); return; }
    let u = byRec.get(rec.id); if (!u) { u = { recordId: rec.id, cells: {}, before: {} }; byRec.set(rec.id, u); }
    if (!(f.id in u.before)) u.before[f.id] = rec.cells[f.id];
    u.cells[f.id] = value; plan.cells++;
  };
  const single = grid.length === 1 && grid[0].length === 1;
  const fill = o.fill;
  if (single && fill && (fill.r2 > fill.r1 || fill.c2 > fill.c1)) {
    for (let r = fill.r1; r <= fill.r2; r++) for (let c = fill.c1; c <= fill.c2; c++) put(r, c, grid[0][0]);
  } else {
    grid.forEach((line, i) => line.forEach((raw, j) => put(o.start.r + i, o.start.c + j, raw)));
  }
  // only cells whose value really changes are written (an empty cell pasted over an empty cell is not a change)
  for (const u of byRec.values()) for (const k of Object.keys(u.cells)) if (JSON.stringify(u.cells[k] ?? null) === JSON.stringify(u.before[k] ?? null)) { delete u.cells[k]; delete u.before[k]; }
  plan.updates = [...byRec.values()].filter(u => Object.keys(u.cells).length > 0);
  plan.cells = plan.updates.reduce((n, u) => n + Object.keys(u.cells).length, 0);
  return plan;
}
