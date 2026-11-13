import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { evaluateFormula, parse, referencedFields, FormulaError } from '../../src/core/formula';
import { renderTemplate, templateFields, textToHtml } from '../../src/core/template';
import { applyFilterSort, cond, emptyGroup, group, evalGroup } from '../../src/core/filters';
import { buildDedupeIndex, normalizeValue, fillEmptyCells } from '../../src/core/dedupe';
import { parseCsv, toCsv, autoMap, rowsFromCsv } from '../../src/core/csv';
import { topologicalOrder, validateDependencies, CycleError, dependencyEdges } from '../../src/core/deps';
import { computeRecord, templateLookup } from '../../src/core/values';
import { buildDefaultFields, buildDefaultViews, defaultRules, fid, TABLE_ID } from '../../src/core/defaults';
import * as S from '../../src/core/store';
import * as DB from '../../src/core/db';
import type { Field, RecordRow } from '../../src/core/types';

const ev = (src: string, vars: Record<string, any> = {}) => evaluateFormula(src, n => { if (!(n in vars)) throw new Error(`Unknown field {${n}}`); return vars[n]; }, new Date('2026-11-04T10:30:00Z'));

describe('formula engine (no eval)', () => {
  it('implements every required function', () => {
    expect(ev('IF(IS_NOT_EMPTY({Email}), "Ready", "Missing Email")', { Email: 'a@b.test' }).value).toBe('Ready');
    expect(ev('IF(IS_NOT_EMPTY({Email}), "Ready", "Missing Email")', { Email: '' }).value).toBe('Missing Email');
    expect(ev('AND(TRUE, 1 = 1)').value).toBe(true); expect(ev('OR(FALSE, 1 = 2)').value).toBe(false); expect(ev('NOT(FALSE)').value).toBe(true);
    expect(ev('CONCATENATE({A}, " ", {B})', { A: 'Ada', B: 'Lovelace' }).value).toBe('Ada Lovelace'); expect(ev('CONCAT("a","b","c")').value).toBe('abc');
    expect(ev('LOWER("AbC")').value).toBe('abc'); expect(ev('UPPER("AbC")').value).toBe('ABC'); expect(ev('TRIM("  a   b ")').value).toBe('a b');
    expect(ev('LEFT("Muhammad", 3)').value).toBe('Muh'); expect(ev('RIGHT("Muhammad", 3)').value).toBe('mad'); expect(ev('MID("Muhammad", 2, 3)').value).toBe('uha');
    expect(ev('LEN("héllo")').value).toBe(5); expect(ev('FIND("b", "abc")').value).toBe(2); expect(ev('FIND("z", "abc")').value).toBe(0);
    expect(ev('SUBSTITUTE("a-b-c", "-", "+")').value).toBe('a+b+c'); expect(ev('IS_EMPTY("")').value).toBe(true); expect(ev('IS_NOT_EMPTY("x")').value).toBe(true);
    expect((ev('TODAY()').value as Date).toISOString()).toBe('2026-11-04T00:00:00.000Z'); expect((ev('NOW()').value as Date).toISOString()).toBe('2026-11-04T10:30:00.000Z');
  });
  it('operators, precedence, comparisons and the & concatenation', () => {
    expect(ev('1 + 2 * 3').value).toBe(7); expect(ev('(1 + 2) * 3').value).toBe(9); expect(ev('-2 + 5').value).toBe(3); expect(ev('"a" & 1 + 1').value).toBe('a2');
    expect(ev('{n} >= 10', { n: 12 }).value).toBe(true); expect(ev('{n} != 3', { n: 3 }).value).toBe(false);
  });
  it('is safe: no code execution, helpful errors, never throws', () => {
    for (const bad of ['constructor.constructor("return 1")()', 'process.exit(1)', 'alert(1)', '1 +', 'IF(1)', 'UNKNOWN(1)', '"open', '{Missing']) {
      const r = ev(bad); expect(r.error, bad).toBeTruthy(); expect(r.value).toBeNull();
    }
    expect(() => parse('globalThis')).toThrow(FormulaError);
    expect(ev('1/0').error).toMatch(/zero/i);
  });
  it('lists the fields a formula reads', () => { expect(referencedFields('IF(IS_EMPTY({A b}), {C}, CONCAT({A b},"x"))').sort()).toEqual(['A b', 'C']); });
});

describe('templates', () => {
  const vars: Record<string, string> = { 'First Name': 'Ada', Institution: 'Example University', 'Latest Research': '', Empty: '' };
  const look = (n: string) => vars[n];
  it('substitutes fields, fallbacks and optional blocks', () => {
    const r = renderTemplate('Hi {First Name | fallback: Researcher},\nI noticed your research at {Institution}.\n[[I liked your work on {Latest Research}.]]\nBye', look);
    expect(r.text).toBe('Hi Ada,\nI noticed your research at Example University.\nBye');
    expect(renderTemplate('Hi {Empty | fallback: Researcher}', look)).toMatchObject({ text: 'Hi Researcher', usedFallback: ['Empty'] });
  });
  it('never invents values: empty stays empty and is reported; unknown fields are reported', () => {
    const r = renderTemplate('Dear {Empty} / {Nope}', look); expect(r.text).toBe('Dear /'); expect(r.missing).toEqual(['Empty']); expect(r.unknown).toEqual(['Nope']);
  });
  it('lists template fields and builds safe HTML', () => { expect(templateFields('{A} {B | fallback: x} [[{C}]]').sort()).toEqual(['A', 'B', 'C']); expect(textToHtml('a <b>\n\nhttps://x.test')).toContain('&lt;b&gt;'); });
});

describe('filters, sorting and views', () => {
  const fields = buildDefaultFields(); const mk = (cells: Record<string, any>): RecordRow => ({ id: Math.random().toString(36), tableId: TABLE_ID, cells, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' });
  const recs = [
    mk({ [fid('fullName')]: 'Ada', [fid('email')]: 'ada@x.test', [fid('position')]: 'Prof', [fid('institution')]: 'U1', [fid('outreachStatus')]: 'Not Contacted' }),
    mk({ [fid('fullName')]: 'Bob', [fid('position')]: 'Dr', [fid('institution')]: 'U2', [fid('outreachStatus')]: 'Not Contacted' }),
    mk({ [fid('fullName')]: 'Cy', [fid('email')]: 'cy@x.test', [fid('position')]: 'Dr', [fid('institution')]: 'U3', [fid('outreachStatus')]: 'Contacted', [fid('emailSent')]: true }),
  ];
  const names = (viewId: string) => { const v = buildDefaultViews().find(x => x.id === viewId)!; return applyFilterSort(fields, recs, v.filter, v.sort).map(r => r.values[fid('fullName')]); };
  it('the default views select the right records', () => {
    expect(names('view_all')).toHaveLength(3); expect(names('view_noemail')).toEqual(['Bob']); expect(names('view_ready')).toEqual(['Ada']);
    expect(names('view_nopub')).toHaveLength(3); expect(names('view_sent')).toEqual(['Cy']); expect(names('view_failed')).toEqual([]);
  });
  it('AND / OR / NOT, numeric / text / date operators and sorting (empty last)', () => {
    const v = (g: any) => applyFilterSort(fields, recs, g, []).map(r => r.values[fid('fullName')]);
    expect(v(group('or', cond(fid('fullName'), 'is', 'ada'), cond(fid('fullName'), 'contains', 'cy')))).toEqual(['Ada', 'Cy']);
    expect(v({ ...group('and', cond(fid('email'), 'isNotEmpty')), not: true })).toEqual(['Bob']);
    expect(applyFilterSort(fields, recs, emptyGroup(), [{ fieldId: fid('email'), dir: 'asc' }]).map(r => r.values[fid('fullName')])).toEqual(['Ada', 'Cy', 'Bob']);
    expect(evalGroup(group('and', cond('n', 'gt', 5), cond('d', 'after', '2026-01-01')), { n: 9, d: '2026-06-01' })).toBe(true);
    expect(evalGroup(group('and', cond('d', 'before', 'today')), { d: '2020-01-01' })).toBe(true);
  });
  it('formula and time fields are computed for filtering', () => {
    const f: Field[] = [...fields.slice(0, 1), { id: 'f1', tableId: TABLE_ID, name: 'Ready?', type: 'formula', order: 99, options: { formula: 'IF(IS_NOT_EMPTY({Full Name}), "yes", "no")' } }, { id: 'f2', tableId: TABLE_ID, name: 'Broken', type: 'formula', order: 100, options: { formula: 'FOO(' } }];
    const { values, errors } = computeRecord(f, recs[0]); expect(values.f1).toBe('yes'); expect(errors.f2).toBeTruthy();
    expect(templateLookup(fields, computeRecord(fields, recs[0]).values)('full name')).toBe('Ada');
  });
});

describe('duplicate detection', () => {
  const fields = buildDefaultFields(); const rules = defaultRules();
  const rec = (cells: any): RecordRow => ({ id: 'r' + Math.random(), tableId: TABLE_ID, cells, createdAt: '', updatedAt: '' });
  it('matches by e-mail, normalised profile URL and name+institution; ignores empty keys', () => {
    const idx = buildDedupeIndex([rec({ [fid('email')]: 'Ada@X.test', [fid('profileUrl')]: 'https://www.u.test/p/ada/', [fid('fullName')]: 'Ada Lovelace', [fid('institution')]: 'Example Univ.' })], rules);
    expect(idx.find({ [fid('email')]: ' ada@x.test' })?.rule.id).toBe('dd-email');
    expect(idx.find({ [fid('profileUrl')]: 'u.test/p/ada' })?.rule.id).toBe('dd-profile');
    expect(idx.find({ [fid('fullName')]: 'ADA  lovelace', [fid('institution')]: 'example univ' })?.rule.id).toBe('dd-name-inst');
    expect(idx.find({ [fid('fullName')]: 'Ada Lovelace' })).toBeNull(); expect(idx.find({ [fid('email')]: '' })).toBeNull();
    // two different people can share a name: a differing e-mail or profile URL keeps them apart
    expect(idx.find({ [fid('fullName')]: 'Ada Lovelace', [fid('institution')]: 'Example Univ.', [fid('email')]: 'other.ada@x.test' })).toBeNull();
    expect(idx.find({ [fid('fullName')]: 'Ada Lovelace', [fid('institution')]: 'Example Univ.', [fid('email')]: '' })?.rule.id).toBe('dd-name-inst');
    expect(normalizeValue('https://doi.org/10.1/ABC', 'doi')).toBe('10.1/abc');
  });
  it('merging only fills empty cells – existing data always wins', () => {
    const r = fillEmptyCells({ [fid('email')]: 'keep@x.test', [fid('position')]: '' }, { [fid('email')]: 'new@x.test', [fid('position')]: 'Prof', [fid('phone')]: '123' }, fields);
    expect(r.cells[fid('email')]).toBe('keep@x.test'); expect(r.cells[fid('position')]).toBe('Prof'); expect(r.changed.sort()).toEqual([fid('phone'), fid('position')].sort());
  });
});

describe('CSV', () => {
  const fields = buildDefaultFields();
  it('parses quotes, embedded newlines, BOM and semicolon delimiters', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","line1\nline2"\r\n')).toEqual([['a', 'b'], ['x, y', 'line1\nline2']]);
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('round-trips and guards against formula injection on export', () => {
    const out = toCsv(fields.slice(0, 2), [{ [fid('fullName')]: '=HYPERLINK("x")', [fid('firstName')]: 'Ada, "A"' }]);
    expect(out).toContain("'=HYPERLINK"); const grid = parseCsv(out); expect(grid[1][1]).toBe('Ada, "A"');
  });
  it('a phone number like +31 20 … survives export → import unchanged', () => {
    const out = toCsv(fields.filter(f => f.id === fid('fullName') || f.id === fid('phone')), [{ [fid('fullName')]: 'A B', [fid('phone')]: '+31 20 555 0101' }]); const g = parseCsv(out);
    expect(g[1][1]).toBe("'+31 20 555 0101"); expect(rowsFromCsv(g, autoMap(g[0], fields), fields)[0][fid('phone')]).toBe('+31 20 555 0101');
  });
  it('maps headers to fields and coerces types', () => {
    const grid = parseCsv('Full Name,Email,Unknown\nAda,ADA@X.TEST,zzz'); const m = autoMap(grid[0], fields);
    expect(m.map(x => x.fieldId)).toEqual([fid('fullName'), fid('email'), null]); expect(rowsFromCsv(grid, m, fields)).toEqual([{ [fid('fullName')]: 'Ada', [fid('email')]: 'ada@x.test' }]);
  });
});

describe('field dependencies', () => {
  const fields = buildDefaultFields();
  it('orders upstream fields first (name → publication → DOI/PDF/abstract)', () => {
    const order = topologicalOrder(fields, f => !!f.lookup); const at = (k: string) => order.indexOf(fid(k));
    expect(at('latestPublication')).toBeLessThan(at('publicationDoi')); expect(at('latestPublication')).toBeLessThan(at('publicationFile')); expect(at('latestPublication')).toBeLessThan(at('researchKeywords'));
    expect(validateDependencies(fields)).toEqual([]); expect(dependencyEdges(fields).some(e => e.from === fid('fullName') && e.to === fid('latestPublication'))).toBe(true);
  });
  it('detects loops and bad configuration with readable messages', () => {
    const loop: Field[] = [{ id: 'a', tableId: 't', name: 'A', type: 'formula', order: 0, options: { formula: '{B}' } }, { id: 'b', tableId: 't', name: 'B', type: 'formula', order: 1, options: { formula: '{A}' } }];
    expect(() => topologicalOrder(loop)).toThrow(CycleError); expect(validateDependencies(loop)[0]).toMatch(/A → B → A|B → A → B/);
    const broken: Field[] = [{ id: 'x', tableId: 't', name: 'Pub', type: 'text', order: 0, lookup: { kind: 'search', output: 'title' } }, { id: 'y', tableId: 't', name: 'DOI', type: 'text', order: 1, lookup: { kind: 'derive', fromFieldId: 'gone', output: 'doi' } }];
    expect(validateDependencies(broken).join(' ')).toMatch(/needs a name field/); expect(validateDependencies(broken).join(' ')).toMatch(/no longer exists/);
  });
});

describe('store (IndexedDB)', () => {
  beforeAll(async () => { await S.ensureSeeded(); });
  it('seeds the Research Contacts database with all default fields and 11 views', async () => {
    const [fields, views] = await Promise.all([S.listFields(TABLE_ID), S.listViews(TABLE_ID)]);
    expect(fields.length).toBe(buildDefaultFields().length); expect(views.map(v => v.name)).toContain('Ready for Outreach'); expect(views).toHaveLength(11);
    for (const n of ['Full Name', 'Position', 'Department', 'Institution', 'Country', 'Email', 'Phone', 'Profile URL', 'About', 'Research Keywords', 'Latest Research', 'Latest Publication', 'Publication Date', 'Publication URL', 'Publication DOI', 'Publication File', 'Publication Access', 'Source URL', 'Scraping Date', 'Outreach Status', 'Email Opened', 'Notes']) expect(fields.some(f => f.name === n), n).toBe(true);
  });
  it('creates, updates, notifies listeners, and manages custom fields', async () => {
    const seen: string[] = []; const off = S.onChange(c => { seen.push(c.kind); });
    const r = await S.createRecord(TABLE_ID, { [fid('fullName')]: 'Test Person' }); await S.updateRecord(r.id, { [fid('email')]: 't@x.test' }); await S.deleteRecords([r.id]); off();
    expect(seen).toEqual(['created', 'updated', 'deleted']);
    const f = await S.addField(TABLE_ID, { name: 'Lab size', type: 'number' }); expect((await S.listFields(TABLE_ID)).some(x => x.id === f.id)).toBe(true);
    await S.deleteField(f.id); await expect(S.deleteField(fid('fullName'))).rejects.toThrow(/primary/);
  });
  it('scraped people are de-duplicated and re-scraping only fills empty cells', async () => {
    const fields = await S.listFields(TABLE_ID); const index = buildDedupeIndex(await S.listRecords(TABLE_ID), await S.getDedupeRules(TABLE_ID));
    const mk = (values: Record<string, string>) => ({ sourceUrl: 'https://u.test/dir', profileUrl: values[fid('profileUrl')] || '', values, fieldsFound: Object.keys(values), status: 'ok' as const });
    const a = await S.intakePerson(TABLE_ID, fields, mk({ [fid('fullName')]: 'Prof. Dr. Ada Lovelace', [fid('profileUrl')]: 'https://u.test/p/ada' }), index);
    expect(a.action).toBe('created'); expect(a.record!.cells[fid('firstName')]).toBe('Ada'); expect(a.record!.cells[fid('lastName')]).toBe('Lovelace'); expect(a.record!.cells[fid('outreachStatus')]).toBe('Not Contacted');
    const b = await S.intakePerson(TABLE_ID, fields, mk({ [fid('fullName')]: 'Ada Lovelace', [fid('profileUrl')]: 'https://u.test/p/ada/', [fid('email')]: 'ada@u.test', [fid('position')]: 'Professor' }), index);
    expect(b.action).toBe('merged'); expect(b.record!.cells[fid('email')]).toBe('ada@u.test');
    const c = await S.intakePerson(TABLE_ID, fields, mk({ [fid('fullName')]: 'Ada Lovelace', [fid('profileUrl')]: 'https://u.test/p/ada', [fid('email')]: 'other@u.test' }), index);
    expect(c.action).toBe('duplicate'); expect((await S.getRecord(a.record!.id))!.cells[fid('email')]).toBe('ada@u.test');
  });
  it('backup and restore round-trip', async () => {
    const dump = await DB.exportBackup(); expect(dump.app).toBe('VierCRM'); const n = (await S.listRecords(TABLE_ID)).length;
    await DB.wipeAll(); expect((await S.listRecords(TABLE_ID)).length).toBe(0); await DB.importBackup(JSON.parse(JSON.stringify(dump))); expect((await S.listRecords(TABLE_ID)).length).toBe(n);
    await expect(DB.importBackup({ app: 'other' })).rejects.toThrow(/not a VierCRM backup/);
  });
});
