import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import * as S from '../../src/core/store';
import { issueTokensForRecords, TOKEN_FIELD_NAME, EXPIRES_FIELD_NAME } from '../../src/assessment/issuer';

describe('multi-select token issue writes the token into each record', () => {
  it('writes token and expiry for every selected record', async () => {
    const db = await S.createDatabase('Applicants');
    const table = await S.createTable(db.id, 'Applicants');
    const nameFieldId = (await S.listFields(table.id)).find((f) => f.key === 'fullName')!.id;
    const names = ['Rizky Kurniawan', 'Tiya Irnawati', 'Nelas Salgia', 'Mega Octaviana'];
    const records = [];
    for (const n of names) records.push(await S.createRecord(table.id, { [nameFieldId]: n }));

    const io = {
      fetch: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { people: { fullName: string }[] };
        return new Response(JSON.stringify({
          results: body.people.map((p) => ({ fullName: p.fullName, status: 'issued', token: `VA-TEST-${p.fullName.length}-XXXX-YYYY`, expiresAt: '2026-11-22T19:00:00.000Z' })),
          remainingToday: 0, resetsAt: '2026-11-19T00:00:00.000Z',
        }), { status: 200 });
      },
      listFields: S.listFields, addField: S.addField, getRecord: S.getRecord, updateRecord: S.updateRecord,
    };
    const summary = await issueTokensForRecords(io, { baseUrl: 'http://localhost:3000', issuerKey: 'k'.repeat(40) }, table.id, records.map((r) => r.id));
    expect(summary.skipped).toEqual([]);
    expect(summary.issued).toBe(4);

    const fields = await S.listFields(table.id);
    const tokenField = fields.find((f) => f.name.trim().toLowerCase() === TOKEN_FIELD_NAME);
    const expiresField = fields.find((f) => f.name.trim().toLowerCase() === EXPIRES_FIELD_NAME);
    expect(tokenField).toBeDefined();
    expect(expiresField).toBeDefined();
    for (const r of records) {
      const after = await S.getRecord(r.id);
      expect(after?.cells[tokenField!.id]).toMatch(/^VA-TEST-/);
      expect(after?.cells[expiresField!.id]).toBe('2026-11-22T19:00:00.000Z');
    }
  });
});
