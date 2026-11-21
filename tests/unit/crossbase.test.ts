import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as S from '../../src/core/store';
import * as DB from '../../src/core/db';
import { CONTACTS_ID, fid, fidFor, TABLE_ID } from '../../src/core/defaults';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings';
import { Engine, moveAutomationToBase, newAutomation, saveAutomation, listRuns } from '../../src/automation/engine';
import { cond, emptyGroup, group } from '../../src/core/filters';
import { clearSenderCache } from '../../src/email/service';
import type { Automation } from '../../src/core/types';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
let sent: any[] = [];
const net = async (url: string, init?: RequestInit): Promise<Response> => {
  const u = new URL(url);
  if (u.host === 'api.brevo.com') {
    if (u.pathname === '/v3/senders') return json({ senders: [{ id: 1, name: 'VierApparatus', email: 'info@vierapparatus.com', active: true }] });
    if (u.pathname === '/v3/smtp/email') { sent.push(JSON.parse(String(init?.body))); return json({ messageId: `<m${sent.length}@smtp>` }); }
  }
  return new Response('not found', { status: 404 });
};

let settings: Settings;
const now = new Date('2026-11-18T10:00:00Z');
const engine = () => new Engine({
  research: { fetch: net, settings, secrets: { brevoApiKey: 'test-key-1234' }, sleep: async () => {}, now: () => now },
  email: { fetch: net, now: () => now, settings, secrets: { brevoApiKey: 'test-key-1234' } },
  now: () => now,
} as any);

beforeAll(async () => { await S.ensureSeeded(); });
beforeEach(async () => {
  for (const a of await DB.all<Automation>('automations')) await DB.del('automations', a.id);
  await DB.clear('runs'); await DB.clear('emailLog'); await DB.kvSet('suppressed', []); clearSenderCache(); sent = [];
  settings = { ...DEFAULT_SETTINGS, sendingEnabled: true, minSendGapSec: 0 };
});

const mkAuto = async (tableId: string): Promise<Automation> => {
  const a = { ...newAutomation(tableId, 'Intro to the test base'), enabled: true, testMode: false, trigger: { type: 'manual' as const },
    actions: [{ id: 'act1', type: 'sendEmail' as const, templateId: 'tpl_intro', providerId: 'brevo' as const, senderEmail: 'info@vierapparatus.com' }] };
  await saveAutomation(a); return a;
};

describe('an automation only works on its own base', () => {
  it('a record of ANOTHER base is refused: nothing is sent and the run says why', async () => {
    const a = await mkAuto(TABLE_ID);                                       // automation on the Researchers base
    const other = await S.createRecord(CONTACTS_ID, { [fidFor(CONTACTS_ID, 'fullName')]: 'Other Base Person', [fidFor(CONTACTS_ID, 'email')]: 'other@example.test' }, { silent: true });
    const [run] = await engine().runManual(a.id, [other.id]);
    expect(run.status).toBe('error'); expect(run.error).toMatch(/another base/);
    expect(sent).toHaveLength(0);
    expect((await listRuns(a.id, 5))[0].status).toBe('error');
  });

  it('a record of the automation’s own base is still sent', async () => {
    const a = await mkAuto(TABLE_ID);
    const own = await S.createRecord(TABLE_ID, { [fid('fullName')]: 'Own Base Person', [fid('email')]: 'own@example.test' }, { silent: true });
    const [run] = await engine().runManual(a.id, [own.id]);
    expect(run.status).toBe('ok');
    expect(sent).toHaveLength(1); expect(sent[0].to).toEqual([{ email: 'own@example.test' }]);
  });
});

describe('moving an automation to another base', () => {
  it('its base changes; its conditions, trigger field and field-based actions are cleared; the e-mail template and the rest stay', () => {
    const a = { ...newAutomation(TABLE_ID, 'Move me'), trigger: { type: 'recordUpdated' as const, fieldId: 'fld_email' },
      conditions: group('and', cond('fld_emailStatus', 'isEmpty')),
      actions: [
        { id: 'a1', type: 'sendEmail' as const, templateId: 'tpl_intro', providerId: 'gmail' as const, toFieldId: 'fld_email' },
        { id: 'a2', type: 'updateField' as const, fieldId: 'fld_notes', value: 'checked' },
      ] };
    const b = moveAutomationToBase(a, CONTACTS_ID);
    expect(b.tableId).toBe(CONTACTS_ID);
    expect(b.conditions).toEqual(emptyGroup());
    expect(b.trigger.fieldId).toBeUndefined(); expect(b.trigger.type).toBe('recordUpdated');
    expect(b.actions[0]).toMatchObject({ type: 'sendEmail', templateId: 'tpl_intro', providerId: 'gmail' }); expect(b.actions[0].toFieldId).toBeUndefined();
    expect(b.actions[1]).toMatchObject({ type: 'updateField', value: 'checked' }); expect(b.actions[1].fieldId).toBeUndefined();
  });
});

describe('a skipped e-mail stops the record, and a new custom base works with automations', () => {
  it('an automation on a new blank base works on its records', async () => {
    const base = await S.createBase('My custom base', 'blank');
    const rec = await S.createRecord(base.id, { [fidFor(base.id, 'fullName')]: 'Custom Person' }, { silent: true });
    const a = { ...newAutomation(base.id, 'Custom base automation'), enabled: true, testMode: false, trigger: { type: 'manual' as const },
      actions: [{ id: 'u1', type: 'updateField' as const, fieldId: fidFor(base.id, 'notes'), value: 'updated by automation' }] };
    await saveAutomation(a);
    const [run] = await engine().runManual(a.id, [rec.id]);
    expect(run.status).toBe('ok');
    expect((await S.getRecord(rec.id))!.cells[fidFor(base.id, 'notes')]).toBe('updated by automation');
  });

  it('a send on a base with no e-mail field is skipped, and the status change after it does not run', async () => {
    const base = await S.createBase('No mail base', 'blank');
    const rec = await S.createRecord(base.id, { [fidFor(base.id, 'fullName')]: 'No Mail Person' }, { silent: true });
    const a = { ...newAutomation(base.id, 'Mail on blank'), enabled: true, testMode: false, trigger: { type: 'manual' as const },
      actions: [
        { id: 's1', type: 'sendEmail' as const, templateId: 'tpl_intro', providerId: 'brevo' as const },
        { id: 'u2', type: 'updateField' as const, fieldId: fidFor(base.id, 'notes'), value: 'sent' },
      ] };
    await saveAutomation(a);
    const [run] = await engine().runManual(a.id, [rec.id]);
    expect(run.status).toBe('skipped'); expect(run.steps).toHaveLength(1); expect(run.steps[0].message).toMatch(/no e-mail/);
    expect((await S.getRecord(rec.id))!.cells[fidFor(base.id, 'notes')]).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
