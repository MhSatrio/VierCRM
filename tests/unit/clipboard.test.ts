import { describe, it, expect } from 'vitest';
import { toTsv, parseTsv, copyRange, planPaste, normRange } from '../../src/core/clipboard';
import type { Field, RecordRow } from '../../src/core/types';

const F = (id: string, type: Field['type'], extra: Partial<Field> = {}): Field => ({ id, tableId: 't', name: id, type, order: 0, ...extra });
const fields: Field[] = [F('name', 'text'), F('email', 'email'), F('age', 'number'), F('ok', 'checkbox'), F('tags', 'multiSelect'), F('calc', 'formula'), F('created', 'createdTime')];
const row = (id: string, cells: Record<string, any>) => { const rec: RecordRow = { id, tableId: 't', cells, createdAt: 'x', updatedAt: 'x' }; return { rec, values: { ...cells, calc: 'computed' } as Record<string, any> }; };
const rows = () => [row('a', { name: 'Ada', email: 'ada@x.test', age: 36 }), row('b', { name: 'Bob', age: 40, ok: true }), row('c', { name: 'Cy' })];

describe('tab-separated text', () => {
  it('writes and reads what Excel writes, including quotes, tabs and line breaks inside a cell', () => {
    const grid = [['plain', 'has\ttab', 'say "hi"'], ['two\nlines', '', 'end']];
    const text = toTsv(grid);
    expect(text).toContain('"has\ttab"'); expect(text).toContain('"say ""hi"""');
    expect(parseTsv(text)).toEqual(grid);
  });
  it('keeps empty cells and empty lines so a pasted column stays aligned, and ignores one final line break', () => {
    expect(parseTsv('a\t\tc\r\n\r\nd\te\r\n')).toEqual([['a', '', 'c'], [''], ['d', 'e']]);
    expect(parseTsv('x')).toEqual([['x']]); expect(parseTsv('')).toEqual([]);
  });
});

describe('copying a range', () => {
  it('gives the shown values of the cells, a formula as its result, an empty cell as empty text', () => {
    const r = rows();
    expect(copyRange(r, fields, normRange({ r: 0, c: 0 }, { r: 1, c: 1 }))).toBe('Ada\tada@x.test\r\nBob\t');
    expect(copyRange(r, fields, { r1: 0, c1: 5, r2: 0, c2: 5 })).toBe('computed');
    expect(copyRange(r, fields, { r1: 1, c1: 3, r2: 1, c2: 3 })).toBe('true');
  });
});

describe('planning a paste', () => {
  it('writes a block at the cursor with types applied, and remembers the old values for Undo', () => {
    const r = rows();
    const p = planPaste({ grid: [['Zed', 'zed@X.test', '41'], ['', '', '']], start: { r: 1, c: 0 }, rows: r, fields });
    const b = p.updates.find(u => u.recordId === 'b')!; const c = p.updates.find(u => u.recordId === 'c')!;
    expect(b.cells).toMatchObject({ name: 'Zed', email: 'zed@x.test', age: 41 });      // e-mail lower-cased, number typed
    expect(b.before).toMatchObject({ name: 'Bob', age: 40 });
    expect(b.before.email).toBeUndefined();                                              // it was empty
    expect(c.cells).toMatchObject({ name: null });                                       // an empty cell clears
    expect(p.cells).toBe(4);                                                              // c: only name changes (others were empty already)
  });
  it('fills a whole selection when one value is pasted over several cells', () => {
    const p = planPaste({ grid: [['Team']], start: { r: 0, c: 0 }, rows: rows(), fields, fill: { r1: 0, c1: 0, r2: 2, c2: 0 } });
    expect(p.updates.map(u => u.cells.name)).toEqual(['Team', 'Team', 'Team']);
  });
  it('skips calculated fields, refuses text in a number field, and ignores lines and columns past the table', () => {
    const p = planPaste({ grid: [['x', 'y', 'abc', 'yes', 'a;b', 'calc!', 'when', 'extra'], ['1'], ['2'], ['3']], start: { r: 0, c: 0 }, rows: rows(), fields });
    expect(p.readOnly).toBe(2);                                                           // formula and createdTime
    expect(p.skipped).toEqual([{ row: 1, field: 'age', why: '“abc” is not a number' }]);
    expect(p.ignoredRows).toBe(1); expect(p.ignoredCols).toBe(1);
    const a = p.updates.find(u => u.recordId === 'a')!;
    expect(a.cells.ok).toBe(true); expect(a.cells.tags).toEqual(['a', 'b']); expect('age' in a.cells).toBe(false);
  });
  it('does not list a record whose pasted values equal what it already has', () => {
    const p = planPaste({ grid: [['Ada', 'ada@x.test', '36']], start: { r: 0, c: 0 }, rows: rows(), fields });
    expect(p.updates).toHaveLength(0); expect(p.cells).toBe(0);
  });
});
