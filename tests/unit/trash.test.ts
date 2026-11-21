import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as S from '../../src/core/store';
import * as DB from '../../src/core/db';
import { fid, TABLE_ID, CONTACTS_ID } from '../../src/core/defaults';

const make = (tableId: string, name: string) => S.createRecord(tableId, { [fid('fullName')]: name }, { silent: true });

describe('undo for deleted records (trash)', () => {
  beforeAll(async () => { await S.ensureSeeded(); });
  beforeEach(async () => { await DB.kvSet('trash', []); await DB.clear('records'); });

  it('keeps a copy of what was deleted and puts it back with the same ids and values', async () => {
    const a = await make(TABLE_ID, 'Ada'); const b = await make(TABLE_ID, 'Bob');
    const ids = await S.deleteRecords([a.id, b.id]);
    expect(ids).toHaveLength(1);                                                // both were in one base: one batch
    expect(await S.getRecord(a.id)).toBeUndefined();
    const n = await S.restoreTrash(ids[0]);
    expect(n).toBe(2);
    expect((await S.getRecord(a.id))!.cells[fid('fullName')]).toBe('Ada');
    expect((await S.getRecord(b.id))!.id).toBe(b.id);
    expect(await S.listTrash()).toHaveLength(0);                                // a restored batch is used up
  });

  it('makes one batch per base when records of two bases are deleted together', async () => {
    const a = await make(TABLE_ID, 'Ada'); const c = await make(CONTACTS_ID, 'Cy');
    const ids = await S.deleteRecords([a.id, c.id]);
    expect(ids).toHaveLength(2);
    expect((await S.listTrash()).map(x => x.tableId).sort()).toEqual([CONTACTS_ID, TABLE_ID].sort());
  });

  it('does not duplicate a record that already exists again, and refuses an unknown batch', async () => {
    const a = await make(TABLE_ID, 'Ada'); const [id] = await S.deleteRecords([a.id]);
    await DB.put('records', a);                                                 // someone re-created it meanwhile
    expect(await S.restoreTrash(id)).toBe(0);
    await expect(S.restoreTrash('trash_nope')).rejects.toThrow(/no longer available/);
  });

  it('refuses to restore into a base that was deleted', async () => {
    const a = await make(TABLE_ID, 'Ada'); const [id] = await S.deleteRecords([a.id]);
    const trash = await S.listTrash(); await DB.kvSet('trash', trash.map(t => ({ ...t, tableId: 'tbl_gone' })));
    await expect(S.restoreTrash(id)).rejects.toThrow(/base .* deleted/);
  });

  it('keeps at most 10 batches and at most 5000 records, dropping the oldest first but never the newest', async () => {
    for (let i = 0; i < 12; i++) { const r = await make(TABLE_ID, `n${i}`); await S.deleteRecords([r.id]); }
    const list = await S.listTrash(); expect(list).toHaveLength(S.TRASH_MAX_BATCHES);
    expect(list[list.length - 1].records[0].cells[fid('fullName')]).toBe('n11');
    // one oversized deletion is still kept (the newest batch is never dropped), older ones go
    const many = []; for (let i = 0; i < S.TRASH_MAX_RECORDS + 5; i++) many.push({ id: `rec_bulk_${i}`, tableId: TABLE_ID, cells: { [fid('fullName')]: `b${i}` }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
    await DB.putMany('records', many);
    await S.deleteRecords(many.map(m => m.id));
    const after = await S.listTrash(); expect(after).toHaveLength(1); expect(after[0].records).toHaveLength(S.TRASH_MAX_RECORDS + 5);
  });
});
