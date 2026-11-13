import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseCsv, autoMap, rowsFromCsv } from '../../src/core/csv';
import { buildDefaultFields, fid } from '../../src/core/defaults';
import { validateDependencies } from '../../src/core/deps';
import { evalGroup } from '../../src/core/filters';

describe('the shipped samples are valid', () => {
  const fields = buildDefaultFields();
  it('sample-researchers.csv: every column maps to a field and every row imports', () => {
    const grid = parseCsv(fs.readFileSync('samples/sample-researchers.csv', 'utf8')); const map = autoMap(grid[0], fields);
    expect(map.every(m => m.fieldId)).toBe(true); const rows = rowsFromCsv(grid, map, fields); expect(rows.length).toBe(grid.length - 1); expect(rows[0][fid('fullName')]).toBe('Prof. Dr. Anna Example'); expect(rows.every(r => /\.example$/.test(String(r[fid('email')] || 'x.example')))).toBe(true);
  });
  it('scraping configuration: well-formed mappings that point at real fields', () => {
    const cfg = JSON.parse(fs.readFileSync('samples/scrape-config-example.json', 'utf8')); const ids = new Set(fields.map(f => f.id));
    expect(cfg.mappings.every((m: any) => ids.has(m.fieldId) && m.selector)).toBe(true); expect(cfg.list.auto).toBe(false); expect(cfg.pagination.mode).toBe('next');
  });
  it('automation example: starts off and in test mode, conditions evaluate, default research fields have no dependency problems', () => {
    const a = JSON.parse(fs.readFileSync('samples/automation-example.json', 'utf8'));
    expect(a.enabled).toBe(false); expect(a.testMode).toBe(true); expect(evalGroup(a.conditions, { [fid('email')]: 'a@b.example', [fid('position')]: 'P', [fid('institution')]: 'I', [fid('outreachStatus')]: 'Not Contacted' })).toBe(true);
    expect(validateDependencies(fields)).toEqual([]);
  });
});
