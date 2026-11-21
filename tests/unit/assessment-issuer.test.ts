import { describe, it, expect } from 'vitest';
import type { CellValue, Field, FieldType, RecordRow } from '../../src/core/types';
import {
  ISSUE_BATCH, ensureTokenFields, findNameField, issueTokensForRecords, requestTokens, type IssuerIo, type ServerResponse,
} from '../../src/assessment/issuer';

const TABLE = 'tbl_applicant';
const CFG = { baseUrl: 'http://localhost:3000', issuerKey: 'k'.repeat(40) };

function field(id: string, name: string, extra: Partial<Field> = {}): Field {
  return { id, tableId: TABLE, name, type: 'text', order: 0, ...extra } as Field;
}

/** An in-memory base with a fake server behind it. */
function harness(opts: { fields?: Field[]; names: (string | null)[]; emails?: (string | null)[]; serverReply?: (names: string[]) => Partial<ServerResponse> & { status?: number } }) {
  const fields: Field[] = opts.fields ?? (opts.emails ? [field('f_name', 'Full Name'), field('f_pos', 'Position'), field('f_mail', 'Email')] : [field('f_name', 'Full Name'), field('f_pos', 'Position')]);
  const records = new Map<string, RecordRow>();
  opts.names.forEach((name, i) => {
    const id = `rec_${i}`;
    const cells: Record<string, CellValue> = { f_pos: 'Analyst' };
    if (name !== null) cells.f_name = name;
    const mail = opts.emails?.[i];
    if (mail) cells.f_mail = mail;
    records.set(id, { id, tableId: TABLE, cells, createdAt: '', updatedAt: '' } as unknown as RecordRow);
  });
  const requests: { names: string[]; people: { fullName: string; email?: string; externalId: string }[]; replace: boolean; auth: string }[] = [];
  const added: { name: string; type: FieldType }[] = [];
  const io: IssuerIo = {
    fetch: async (_url, init) => {
      const parsed = JSON.parse(String(init.body)) as { people: { fullName: string; email?: string; externalId: string }[]; replace: boolean };
      const body = { names: parsed.people.map((p) => p.fullName), replace: parsed.replace };
      requests.push({ names: body.names, people: parsed.people, replace: body.replace, auth: String((init.headers as Record<string, string>).Authorization) });
      const reply = opts.serverReply ? opts.serverReply(body.names) : {};
      const status = reply.status ?? 200;
      const payload = status === 200
        ? { results: body.names.map((n) => ({ fullName: n, status: 'issued', token: `VA-TOK${n.length}-XXXX-YYYY-ZZZZ`, expiresAt: '2026-11-22T10:00:00.000Z', regenerated: false })), remainingToday: 5, resetsAt: '2026-11-19T00:00:00.000Z', ...reply }
        : { message: 'server said no' };
      return new Response(JSON.stringify(payload), { status });
    },
    listFields: async () => fields,
    addField: async (_t, spec) => {
      added.push({ name: spec.name, type: spec.type });
      const f = field(`f_${spec.name.replace(/\W/g, '_')}`, spec.name, { type: spec.type });
      fields.push(f);
      return f;
    },
    getRecord: async (id) => records.get(id) ?? null,
    updateRecord: async (id, cells) => {
      const r = records.get(id)!;
      const next = { ...r, cells: { ...r.cells, ...cells } } as RecordRow;
      records.set(id, next);
      return next;
    },
  };
  return { io, records, requests, added, fields };
}

describe('finding the name field', () => {
  it('uses the field key fullName, or a field called Full Name in any case', () => {
    expect(findNameField([field('a', 'Name')])).toBeUndefined();
    expect(findNameField([field('a', 'FULL NAME ')])?.id).toBe('a');
    expect(findNameField([field('a', 'Company'), field('b', 'Who', { key: 'fullName' })])?.id).toBe('b');
  });
});

describe('token fields', () => {
  it('creates "token" and "token expires" when the base does not have them', async () => {
    const h = harness({ names: [] });
    const { token, expires } = await ensureTokenFields(h.io, TABLE);
    expect(token.name).toBe('token');
    expect(expires.name).toBe('token expires');
    expect(h.added.map((a) => a.name)).toEqual(['token', 'token expires']);
  });

  it('reuses fields that already exist', async () => {
    const h = harness({ names: [], fields: [field('t', 'Token'), field('e', 'Token Expires')] });
    const { token, expires } = await ensureTokenFields(h.io, TABLE);
    expect([token.id, expires.id]).toEqual(['t', 'e']);
    expect(h.added).toEqual([]);
  });
});

describe('issuing tokens into the base', () => {
  it('writes each token and its expiry into the same record, with the right names', async () => {
    const h = harness({ names: ['Amara Osei', 'Lukas Brenner'] });
    const sum = await issueTokensForRecords(h.io, CFG, TABLE, ['rec_0', 'rec_1']);
    expect(sum.issued).toBe(2);
    expect(sum.skipped).toEqual([]);
    expect(h.requests[0].names).toEqual(['Amara Osei', 'Lukas Brenner']);
    expect(h.requests[0].auth).toBe(`Bearer ${CFG.issuerKey}`);
    // Cells are keyed by field id, so look the created fields up by name.
    const tokenId = h.fields.find((f) => f.name === 'token')!.id;
    const expiresId = h.fields.find((f) => f.name === 'token expires')!.id;
    const rec = h.records.get('rec_0')!;
    expect(rec.cells[tokenId]).toBe('VA-TOK10-XXXX-YYYY-ZZZZ');
    expect(rec.cells[expiresId]).toBe('2026-11-22T10:00:00.000Z');
    expect(rec.cells.f_pos).toBe('Analyst');
  });

  it('sends the name, never the token, and never writes a token to a record without a name', async () => {
    const h = harness({ names: ['  Priya   Raman -  ', null] });
    const sum = await issueTokensForRecords(h.io, CFG, TABLE, ['rec_0', 'rec_1']);
    expect(h.requests[0].names).toEqual(['Priya   Raman -']);
    expect(sum.skipped).toEqual([{ recordId: 'rec_1', name: '', reason: 'no full name' }]);
    const tokenId = h.fields.find((f) => f.name === 'token')!.id;
    expect(h.records.get('rec_1')!.cells[tokenId]).toBeUndefined();
  });

  it('splits large selections into batches of 20 and passes the replace flag through', async () => {
    const names = Array.from({ length: 25 }, (_, i) => `Person Number ${i}`);
    const h = harness({ names });
    const ids = names.map((_, i) => `rec_${i}`);
    const sum = await issueTokensForRecords(h.io, CFG, TABLE, ids, { replace: true });
    expect(h.requests.map((r) => r.names.length)).toEqual([ISSUE_BATCH, 5]);
    expect(h.requests.every((r) => r.replace === true)).toBe(true);
    expect(sum.issued).toBe(25);
  });

  it('sends the record id and the applicant e-mail with each name, so a corrected name stays the same candidate', async () => {
    const h = harness({ names: ['Amara Osei', 'Lukas Brenner'], emails: ['Amara.Osei@Example.com', null] });
    await issueTokensForRecords(h.io, CFG, TABLE, ['rec_0', 'rec_1']);
    expect(h.requests[0].people).toEqual([
      { fullName: 'Amara Osei', email: 'Amara.Osei@Example.com', externalId: 'rec_0' },
      { fullName: 'Lukas Brenner', externalId: 'rec_1' },
    ]);
  });

  it('lists refusals with the server reason and keeps the records that were issued', async () => {
    const h = harness({
      names: ['Good Name', 'Already Issued'],
      serverReply: (names) => ({
        results: names.map((n) => (n === 'Already Issued'
          ? { fullName: n, status: 'rejected', code: 'already_issued', message: 'A token for this name is still valid until later.' }
          : { fullName: n, status: 'issued', token: 'VA-AAAA-BBBB-CCCC-DDDD', expiresAt: '2026-11-22T10:00:00.000Z' })) as ServerResponse['results'],
        remainingToday: 19,
        resetsAt: '2026-11-19T00:00:00.000Z',
      }),
    });
    const sum = await issueTokensForRecords(h.io, CFG, TABLE, ['rec_0', 'rec_1']);
    expect(sum.issued).toBe(1);
    expect(sum.skipped).toEqual([{ recordId: 'rec_1', name: 'Already Issued', reason: 'A token for this name is still valid until later.' }]);
    expect(sum.remainingToday).toBe(19);
  });

  it('stops sending once the daily limit is reached, and marks the rest for tomorrow', async () => {
    const names = Array.from({ length: 25 }, (_, i) => `Cap Person ${i}`);
    const h = harness({
      names,
      serverReply: (ns) => ({
        results: ns.map((n) => ({ fullName: n, status: 'rejected', code: 'daily_cap', message: 'The daily limit has been reached.' })) as ServerResponse['results'],
        remainingToday: 0,
        resetsAt: '2026-11-19T00:00:00.000Z',
      }),
    });
    const sum = await issueTokensForRecords(h.io, CFG, TABLE, names.map((_, i) => `rec_${i}`));
    expect(h.requests).toHaveLength(1);
    expect(sum.issued).toBe(0);
    expect(sum.skipped).toHaveLength(25);
    expect(sum.skipped[24].reason).toBe('daily limit reached; issue these tomorrow');
  });

  it('explains what to fix when the base or the settings are not ready', async () => {
    await expect(issueTokensForRecords(harness({ names: ['A Name'], fields: [field('p', 'Position')] }).io, CFG, TABLE, ['rec_0'])).rejects.toThrow(/Full Name/);
    await expect(issueTokensForRecords(harness({ names: ['A Name'] }).io, { ...CFG, baseUrl: '' }, TABLE, ['rec_0'])).rejects.toThrow(/server address/);
    await expect(issueTokensForRecords(harness({ names: ['A Name'] }).io, { ...CFG, issuerKey: '' }, TABLE, ['rec_0'])).rejects.toThrow(/issuer key/);
  });
});

describe('server errors', () => {
  const fakeFetch = (status: number, body: unknown = {}) => async () => new Response(JSON.stringify(body), { status });

  it('turns a refused key into a message the user can act on', async () => {
    await expect(requestTokens({ fetch: fakeFetch(401) }, CFG, [{ fullName: 'A Name', externalId: 'rec_a' }], false)).rejects.toThrow(/refused the issuer key/);
  });

  it('turns a server with no key configured into a clear message', async () => {
    await expect(requestTokens({ fetch: fakeFetch(503) }, CFG, [{ fullName: 'A Name', externalId: 'rec_a' }], false)).rejects.toThrow(/TOKEN_ISSUER_KEY/);
  });

  it('includes the server message for other failures', async () => {
    await expect(requestTokens({ fetch: fakeFetch(422, { message: 'Send between 1 and 20 applicants.' }) }, CFG, [{ fullName: 'A Name', externalId: 'rec_a' }], false))
      .rejects.toThrow(/422: Send between 1 and 20 applicants/);
  });
});
