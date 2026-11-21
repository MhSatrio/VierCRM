import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as S from '../../src/core/store';
import * as DB from '../../src/core/db';
import { COMPANIES_ID, CONTACTS_ID } from '../../src/core/defaults';
import { planImport, validatePackage, type VierPackage } from '../../src/core/vierpkg';
import { importPackage } from '../../src/core/vierpkgImport';

const sample = (): VierPackage => JSON.parse(readFileSync(new URL('../../samples/job-search-sample.vierpkg.json', import.meta.url), 'utf8'));

describe('Vier package: reading', () => {
  it('the shared sample (written by Job Search\'s format) is valid, and damaged ones are refused with reasons', () => {
    expect(validatePackage(sample())).toEqual({ ok: true, errors: [] });
    expect(validatePackage({ format: 'x' }).errors[0]).toMatch(/not a Vier package/);
    expect(validatePackage({ ...sample(), version: 3 }).errors[0]).toMatch(/version 3/);
    const p: any = sample(); p.records[0].values['Compatibility score'] = 'high'; p.records[1].externalId = p.records[0].externalId; p.records[1].sourceUrl = 'ftp://x';
    const e = validatePackage(p).errors.join(' | ');
    expect(e).toMatch(/does not match its type \(number\)/); expect(e).toMatch(/appears twice/); expect(e).toMatch(/sourceUrl must be/);
  });
});

describe('Vier package: importing into a base', () => {
  beforeAll(async () => { await S.ensureSeeded(); });
  beforeEach(async () => { await DB.clear('records'); });

  it('matches fields by meaning (key) first and by name second, and creates the rest only when allowed', async () => {
    const fields = await S.listFields(CONTACTS_ID);
    const on = planImport(sample(), fields, new Set(), { createMissing: true });
    const how = Object.fromEntries(on.map.map(m => [m.pkgName, m.how]));
    expect(how['Contact email']).toBe('key');         // the Contacts base has a field with key email
    expect(how['Company']).toBe('key'); expect(how['Job title']).toBe('key');            // key institution (shown as Company here) and key position
    expect(how['Country']).toBe('name');                                                  // no key, same name
    expect(how['Company website']).toBe('new'); expect(how['Compatibility score']).toBe('new');   // the Contacts base has no website field
    expect(on.rows).toHaveLength(2);
    const off = planImport(sample(), fields, new Set(), { createMissing: false });
    expect(off.unmatched).toContain('Compatibility score'); expect(off.map.find(m => m.pkgName === 'Compatibility score')!.fieldId).toBeNull();
  });

  it('imports the records with typed values, a source link and their identity; a second import adds nothing', async () => {
    const r1 = await importPackage(CONTACTS_ID, sample(), { createMissing: true });
    expect(r1.created).toBe(2); expect(r1.alreadyImported).toBe(0); expect(r1.newFields).toBeGreaterThan(0);
    const recs = await S.listRecords(CONTACTS_ID); const fields = await S.listFields(CONTACTS_ID);
    const byName = (n: string) => fields.find(f => f.name === n)!.id;
    const lab = recs.find(r => r.meta?.external?.includes('jobsearch:fixture-001'))!;
    expect(lab.sourceUrl).toBe('https://jobs.example.test/listing/001');
    expect(lab.cells[byName('Compatibility score')]).toBe(72);
    expect(lab.cells[byName('Shortlisted')]).toBe(true);
    expect(lab.cells[byName('Skills')]).toEqual(['PCR', 'microscopy', 'data entry']);
    expect(String(lab.cells[fields.find(f => f.key === 'email')!.id])).toBe('hr@marine.example.test');
    const r2 = await importPackage(CONTACTS_ID, sample(), { createMissing: true });
    expect(r2.created).toBe(0); expect(r2.alreadyImported).toBe(2); expect(r2.newFields).toBe(0);
    expect((await S.listRecords(CONTACTS_ID)).length).toBe(2);
  });

  it('without "create missing fields" only matching fields are filled and nothing new is added to the base', async () => {
    const before = (await S.listFields(COMPANIES_ID)).length;          // a base that no earlier test has added fields to
    const r = await importPackage(COMPANIES_ID, sample(), { createMissing: false });
    expect(r.created).toBeGreaterThan(0); expect(r.newFields).toBe(0); expect(r.unmatched).toContain('Compatibility score');
    expect((await S.listFields(COMPANIES_ID)).length).toBe(before);
  });
});
