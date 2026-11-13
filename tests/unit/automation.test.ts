import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as S from '../../src/core/store';
import * as DB from '../../src/core/db';
import { fid, TABLE_ID } from '../../src/core/defaults';
import { cond, group, emptyGroup } from '../../src/core/filters';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings';
import { Engine, newAutomation, saveAutomation, listRuns, triggerMatch, MAX_DEPTH, listAutomations, describeTrigger } from '../../src/automation/engine';
import { renderEmail, sendRecordEmail, getTemplates, listEmailLog, saveTemplate, clearSenderCache } from '../../src/email/service';
import { applyEvent, summarize, syncBrevo, applyWebhookEvents } from '../../src/email/analytics';
import { buildMime, canSendAs, parseAuthRedirect, buildAuthUrl } from '../../src/email/gmail';
import { verifySender, EVENT_MAP } from '../../src/email/brevo';
import type { Action, Automation, EmailLog } from '../../src/core/types';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
let sentBodies: any[] = []; let brevoDown = false; let senders = [{ id: 1, name: 'VierApparatus', email: 'info@vierapparatus.com', active: true }]; let events: any[] = [];
const net = async (url: string, init?: RequestInit): Promise<Response> => {
  const u = new URL(url);
  if (u.host === 'api.brevo.com') {
    if (brevoDown) return json({ message: 'down' }, 500);
    if (u.pathname === '/v3/senders') return json({ senders });
    if (u.pathname === '/v3/smtp/email') { sentBodies.push({ headers: init?.headers, body: JSON.parse(String(init?.body)) }); return json({ messageId: `<msg-${sentBodies.length}@smtp>` }); }
    if (u.pathname === '/v3/smtp/statistics/events') return json({ events: events.filter(e => e.messageId === u.searchParams.get('messageId')) });
  }
  return new Response('not found', { status: 404 });
};

let settings: Settings; let engine: Engine; let now = new Date('2026-11-04T10:00:00Z');
const deps = () => ({ research: { fetch: net, settings, secrets: { brevoApiKey: 'test-key-1234' }, sleep: async () => {}, now: () => now }, email: { fetch: net, now: () => now, settings, secrets: { brevoApiKey: 'test-key-1234' } }, now: () => now });
const rec = (cells: Record<string, any>) => S.createRecord(TABLE_ID, cells, { silent: true });
const mkAuto = async (patch: Partial<Automation>) => { const a = { ...newAutomation(TABLE_ID, 'Test automation'), enabled: true, testMode: false, ...patch }; await saveAutomation(a); return a; };
const act = (type: Action['type'], extra: Partial<Action> = {}): Action => ({ id: Math.random().toString(36).slice(2), type, ...extra });

beforeAll(async () => { await S.ensureSeeded(); });
beforeEach(async () => {
  for (const a of await listAutomations()) await DB.del('automations', a.id);
  await DB.clear('runs'); await DB.clear('emailLog'); await DB.clear('pending'); await DB.kvSet('suppressed', []);
  for (const k of await DB.all<{ key: string }>('kv')) if (k.key.startsWith('autoKeys:')) await DB.del('kv', k.key);
  clearSenderCache(); sentBodies = []; brevoDown = false; events = []; senders = [{ id: 1, name: 'VierApparatus', email: 'info@vierapparatus.com', active: true }];
  settings = { ...DEFAULT_SETTINGS, sendingEnabled: true, minSendGapSec: 0, lookupDelayMs: 0 }; now = new Date('2026-11-04T10:00:00Z');
  engine = new Engine(deps()); S.onChange(() => {});
});
const wire = () => { const off = S.onChange(c => { engine = engine; return engine.handleChange(c); }); return off; };

describe('triggers', () => {
  const fields = [{ id: 'f', name: 'Email' }] as any; const r = (cells: any) => ({ id: 'r', tableId: 't', cells, createdAt: '', updatedAt: '' });
  it('fires on the right transitions only', () => {
    const t = (type: any, before: any, after: any, kind: any = 'updated') => triggerMatch({ type, fieldId: 'f' }, { kind, tableId: 't', record: r(after), before: before ? r(before) : undefined }, fields, []);
    expect(t('fieldBecomesNonEmpty', { f: '' }, { f: 'a@b.test' })).toBeTruthy(); expect(t('fieldBecomesNonEmpty', { f: 'x' }, { f: 'y' })).toBeNull(); expect(t('fieldBecomesEmpty', { f: 'x' }, { f: '' })).toBeTruthy();
    expect(t('fieldChanges', { f: 'x' }, { f: 'y' })).toBeTruthy(); expect(t('fieldChanges', { f: 'x' }, { f: 'x' })).toBeNull(); expect(t('recordCreated', null, { f: 'a' }, 'created')).toBeTruthy(); expect(t('recordCreated', { f: 'a' }, { f: 'b' })).toBeNull();
    expect(t('recordUpdated', { f: 'a' }, { f: 'b' })).toBeTruthy(); expect(t('recordUpdated', { f: 'a' }, { f: 'a' })).toBeNull();
    const view = { id: 'v', name: 'V', tableId: 't', filter: group('and', cond('f', 'isNotEmpty')), sort: [], hiddenFieldIds: [], order: 0 };
    expect(triggerMatch({ type: 'recordEntersView', viewId: 'v' }, { kind: 'updated', tableId: 't', record: r({ f: 'a' }), before: r({ f: '' }) }, fields, [view])).toBeTruthy();
    expect(triggerMatch({ type: 'recordEntersView', viewId: 'v' }, { kind: 'updated', tableId: 't', record: r({ f: 'b' }), before: r({ f: 'a' }) }, fields, [view])).toBeNull();
    expect(describeTrigger({ type: 'fieldBecomesNonEmpty', fieldId: 'f' }, fields, [])).toBe('When “Email” becomes non-empty');
  });
});

describe('conditions, actions and test mode', () => {
  it('runs actions only when the conditions hold; templates and =formulas can fill fields', async () => {
    const a = await mkAuto({ trigger: { type: 'manual' }, conditions: group('and', cond(fid('email'), 'isNotEmpty'), cond(fid('position'), 'isNotEmpty')),
      actions: [act('updateField', { fieldId: fid('notes'), value: 'Ready: {Full Name} at {Institution | fallback: unknown}' }), act('changeStatus', { statusFieldId: fid('outreachStatus'), markStatus: 'Follow-up needed' }), act('updateField', { fieldId: fid('phone'), value: '=UPPER(LEFT({Full Name}, 3))' })] });
    const ok = await rec({ [fid('fullName')]: 'Ada Lovelace', [fid('email')]: 'ada@u.test', [fid('position')]: 'Prof' }); const no = await rec({ [fid('fullName')]: 'Bob', [fid('email')]: 'b@u.test' });
    const [r1] = await engine.runManual(a.id, [ok.id]); const [r2] = await engine.runManual(a.id, [no.id]);
    expect(r1.status).toBe('ok'); const after = (await S.getRecord(ok.id))!; expect(after.cells[fid('notes')]).toBe('Ready: Ada Lovelace at unknown'); expect(after.cells[fid('outreachStatus')]).toBe('Follow-up needed'); expect(after.cells[fid('phone')]).toBe('ADA');
    expect(r2.status).toBe('skipped'); expect((await S.getRecord(no.id))!.cells[fid('notes')]).toBeUndefined();
  });
  it('test mode describes everything and changes nothing; calculated fields are refused', async () => {
    const a = await mkAuto({ testMode: true, actions: [act('updateField', { fieldId: fid('notes'), value: 'x' }), act('sendEmail', { templateId: 'tpl_intro' }), act('runLookup'), act('wait', { seconds: 5 })] });
    const r = await rec({ [fid('fullName')]: 'Ada', [fid('email')]: 'ada@u.test' }); const [run] = await engine.runManual(a.id, [r.id]);
    expect(run.status).toBe('test'); expect(run.steps.map(s => s.status)).toEqual(['test', 'test', 'test', 'test']); expect(run.steps[0].message).toMatch(/would set “Notes”/);
    expect((await S.getRecord(r.id))!.cells[fid('notes')]).toBeUndefined(); expect(sentBodies).toHaveLength(0); expect(await DB.all('pending')).toHaveLength(0);
    const bad = await mkAuto({ actions: [act('updateField', { fieldId: fid('created'), value: 'x' })] }); expect((await engine.runManual(bad.id, [r.id]))[0].steps[0].message).toMatch(/calculated/);
  });
  it('new automations start disabled and in test mode', () => { const a = newAutomation(TABLE_ID, 'x'); expect(a.enabled).toBe(false); expect(a.testMode).toBe(true); });
});

describe('loop and repeat prevention', () => {
  it('an automation that updates the field that triggers it runs exactly once', async () => {
    const off = wire();
    const a = await mkAuto({ name: 'self', trigger: { type: 'fieldChanges', fieldId: fid('notes') }, actions: [act('updateField', { fieldId: fid('notes'), value: '{Notes}!' })] });
    const r = await S.createRecord(TABLE_ID, { [fid('fullName')]: 'Loop' }); await S.updateRecord(r.id, { [fid('notes')]: 'a' });
    off(); const runs = await listRuns(a.id); expect(runs).toHaveLength(1); expect((await S.getRecord(r.id))!.cells[fid('notes')]).toBe('a!');
  });
  it('A → B → A is cut off; nothing runs deeper than MAX_DEPTH', async () => {
    const off = wire();
    const A = await mkAuto({ name: 'A', trigger: { type: 'fieldChanges', fieldId: fid('notes') }, actions: [act('updateField', { fieldId: fid('phone'), value: 'x{Notes}' })] });
    const B = await mkAuto({ name: 'B', trigger: { type: 'fieldChanges', fieldId: fid('phone') }, actions: [act('updateField', { fieldId: fid('notes'), value: 'y{Phone}' })] });
    const r = await S.createRecord(TABLE_ID, {}); await S.updateRecord(r.id, { [fid('notes')]: 'start' }); off();
    expect(await listRuns(A.id)).toHaveLength(1); expect(await listRuns(B.id)).toHaveLength(1);
    const direct = await mkAuto({ name: 'C', actions: [act('runAutomation', { automationId: A.id })], trigger: { type: 'manual' } }); void direct;
    const self = await mkAuto({ name: 'S', trigger: { type: 'manual' }, actions: [] }); await saveAutomation({ ...self, actions: [act('runAutomation', { automationId: self.id })] });
    const [run] = await engine.runManual(self.id, [r.id]); expect(run.steps[0].message).toMatch(/loop/); expect(MAX_DEPTH).toBeGreaterThan(1);
  });
  it('"becomes non-empty" fires once per value, not on every later edit', async () => {
    const off = wire(); const a = await mkAuto({ trigger: { type: 'fieldBecomesNonEmpty', fieldId: fid('email') }, actions: [act('updateField', { fieldId: fid('notes'), value: 'has email' })] });
    const r = await S.createRecord(TABLE_ID, {}); await S.updateRecord(r.id, { [fid('email')]: 'a@b.test' }); await S.updateRecord(r.id, { [fid('email')]: '' }); await S.updateRecord(r.id, { [fid('email')]: 'a@b.test' });
    await S.updateRecord(r.id, { [fid('email')]: '' }); await S.updateRecord(r.id, { [fid('email')]: 'c@d.test' }); off(); expect(await listRuns(a.id)).toHaveLength(2);       // a@b.test (once) and c@d.test
  });
  it('Wait pauses the run and processPending continues it; retry re-runs a failed run', async () => {
    const a = await mkAuto({ trigger: { type: 'manual' }, actions: [act('updateField', { fieldId: fid('notes'), value: 'one' }), act('wait', { seconds: 60 }), act('updateField', { fieldId: fid('phone'), value: 'two' })] });
    const r = await rec({ [fid('fullName')]: 'W' }); const [run] = await engine.runManual(a.id, [r.id]); expect(run.status).toBe('waiting');
    expect((await S.getRecord(r.id))!.cells[fid('notes')]).toBe('one'); expect((await S.getRecord(r.id))!.cells[fid('phone')]).toBeUndefined();
    expect(await engine.processPending()).toHaveLength(0); now = new Date(now.getTime() + 61000); const cont = await engine.processPending(); expect(cont).toHaveLength(1); expect((await S.getRecord(r.id))!.cells[fid('phone')]).toBe('two');
    const bad = await mkAuto({ trigger: { type: 'manual' }, actions: [act('updateField', { fieldId: 'gone', value: 'x' })] }); const [fail] = await engine.runManual(bad.id, [r.id]); expect(fail.status).toBe('error');
    await saveAutomation({ ...bad, actions: [act('updateField', { fieldId: fid('notes'), value: 'fixed' })] }); const again = await engine.retryRun(fail.id); expect(again!.status).toBe('ok'); expect(again!.retryOf).toBe(fail.id);
  });
});

describe('e-mail: preview, guard rails, providers, analytics', () => {
  const ada = { [fid('fullName')]: 'Ada Lovelace', [fid('firstName')]: 'Ada', [fid('institution')]: 'Example University', [fid('email')]: 'ada@example-university.example', [fid('position')]: 'Prof', [fid('outreachStatus')]: 'Not Contacted' };

  it('previews the personalised message per contact: fallbacks, optional sentence, footer – nothing invented', async () => {
    const [tpl] = await getTemplates(); const fields = await S.listFields(TABLE_ID);
    const a = renderEmail(tpl, fields, await rec({ ...ada, [fid('latestResearch')]: 'Mass spectrometry of plants' }), settings);
    expect(a.subject).toBe('Laboratory equipment sourcing for Example University'); expect(a.text).toContain('Hi Ada,'); expect(a.text).toContain('I was particularly interested in your work on Mass spectrometry of plants.'); expect(a.text).toContain('reply "unsubscribe"'); expect(a.html).toContain('<p>');
    const b = renderEmail(tpl, fields, await rec({ [fid('email')]: 'x@y.test' }), settings);
    expect(b.text).toContain('Hi Researcher,'); expect(b.text).not.toContain('particularly interested'); expect(b.subject).toBe('Laboratory equipment sourcing for your laboratory');
    expect(renderEmail(tpl, fields, await rec({ [fid('fullName')]: 'No Mail' }), settings).problems[0]).toMatch(/no e-mail/);
  });

  it('sends through Brevo only when everything allows it, verifies the sender, logs and updates the contact', async () => {
    const r = await rec(ada); const base = { recordId: r.id, templateId: 'tpl_intro', providerId: 'brevo' as const, senderEmail: 'info@vierapparatus.com' };
    settings = { ...settings, sendingEnabled: false }; expect((await sendRecordEmail(deps().email as any, { ...base, })).message).toMatch(/switched off/);
    settings = { ...settings, sendingEnabled: true };
    const out = await sendRecordEmail({ ...deps().email, settings }, base); expect(out.status).toBe('sent');
    expect(sentBodies[0].body).toMatchObject({ sender: { email: 'info@vierapparatus.com', name: 'VierApparatus' }, to: [{ email: 'ada@example-university.example' }], tags: ['viercrm'] }); expect((sentBodies[0].headers as any)['api-key']).toBe('test-key-1234');
    const after = (await S.getRecord(r.id))!; expect(after.cells[fid('emailSent')]).toBe(true); expect(after.cells[fid('emailStatus')]).toBe('Sent'); expect(after.cells[fid('outreachStatus')]).toBe('Contacted');
    expect((await listEmailLog())[0]).toMatchObject({ provider: 'brevo', status: 'sent', messageId: '<msg-1@smtp>' });
    expect((await sendRecordEmail({ ...deps().email, settings }, base)).message).toMatch(/already sent/);
  });

  it('refuses unverified senders, bounced / unsubscribed / do-not-contact contacts, the daily cap and the minimum gap', async () => {
    senders = []; const r = await rec(ada); const e = { ...deps().email, settings };
    const base = { recordId: r.id, templateId: 'tpl_intro', providerId: 'brevo' as const, senderEmail: 'info@vierapparatus.com' };
    expect((await sendRecordEmail(e, base)).message).toMatch(/not a sender in this Brevo account/); expect(sentBodies).toHaveLength(0);
    senders = [{ id: 1, name: 'V', email: 'info@vierapparatus.com', active: false }]; expect((await verifySender({ fetch: net, apiKey: 'k' }, 'info@vierapparatus.com')).message).toMatch(/not active/);
    senders = [{ id: 1, name: 'V', email: 'info@vierapparatus.com', active: true }];
    for (const [cells, re] of [[{ [fid('outreachStatus')]: 'Do not contact' }, /Do not contact/], [{ [fid('emailStatus')]: 'Bounced' }, /bounced or unsubscribed/]] as const) { const x = await rec({ ...ada, [fid('email')]: `${Math.random().toString(36).slice(2)}@x.example`, ...cells }); expect((await sendRecordEmail(e, { ...base, recordId: x.id })).message).toMatch(re); }
    await DB.kvSet('suppressed', ['ada@example-university.example']); expect((await sendRecordEmail(e, base)).message).toMatch(/bounced or unsubscribed/); await DB.kvSet('suppressed', []);
    const capped = { ...e, settings: { ...settings, dailySendCap: 1 } }; expect((await sendRecordEmail(capped, base)).status).toBe('sent');
    const r2 = await rec({ ...ada, [fid('email')]: 'second@x.example' }); expect((await sendRecordEmail(capped, { ...base, recordId: r2.id })).message).toMatch(/Daily limit of 1/);
    const slow = { ...e, settings: { ...settings, dailySendCap: 99, minSendGapSec: 60 } }; expect((await sendRecordEmail(slow, { ...base, recordId: r2.id })).message).toMatch(/Minimum 60s/);
  });

  it('an automation sends only when enabled, live and allowed; test mode sends nothing', async () => {
    const a = await mkAuto({ trigger: { type: 'manual' }, testMode: true, actions: [act('sendEmail', { templateId: 'tpl_intro', providerId: 'brevo', senderEmail: 'info@vierapparatus.com' })] });
    const r = await rec(ada); const [t] = await engine.runManual(a.id, [r.id]); expect(t.status).toBe('test'); expect(t.steps[0].message).toMatch(/Nothing was sent/); expect(sentBodies).toHaveLength(0); expect((await listEmailLog())[0].provider).toBe('test');
    await saveAutomation({ ...a, testMode: false }); const [live] = await engine.runManual(a.id, [r.id]); expect(live.status).toBe('ok'); expect(sentBodies).toHaveLength(1);
    await saveAutomation({ ...a, testMode: false, enabled: false }); const r3 = await rec({ ...ada, [fid('email')]: 'third@x.example' }); const [off] = await engine.runManual(a.id, [r3.id]); expect(off.status).toBe('test'); expect(sentBodies).toHaveLength(1);
  });

  it('the “Ready for Outreach” scenario: a contact entering the view is e-mailed once the automation is activated', async () => {
    const off = wire(); const view = (await S.listViews(TABLE_ID)).find(v => v.name === 'Ready for Outreach')!;
    const a = await mkAuto({ name: 'Intro to ready contacts', trigger: { type: 'recordEntersView', viewId: view.id }, conditions: group('and', cond(fid('email'), 'isNotEmpty'), cond(fid('position'), 'isNotEmpty'), cond(fid('institution'), 'isNotEmpty'), cond(fid('outreachStatus'), 'is', 'Not Contacted')), actions: [act('sendEmail', { templateId: 'tpl_intro', providerId: 'brevo', senderEmail: 'info@vierapparatus.com' })] });
    const r = await S.createRecord(TABLE_ID, { [fid('fullName')]: 'Ada', [fid('institution')]: 'U', [fid('position')]: 'Prof', [fid('outreachStatus')]: 'Not Contacted' });
    expect(sentBodies).toHaveLength(0); await S.updateRecord(r.id, { [fid('email')]: 'ada@u.example' }); off();
    expect(sentBodies).toHaveLength(1); expect((await listRuns(a.id))[0].status).toBe('ok'); expect((await S.getRecord(r.id))!.cells[fid('outreachStatus')]).toBe('Contacted');
  });

  it('Brevo events update the e-mail log and the contact; opens are counted once; unsubscribes stop all future mail', async () => {
    const r = await rec(ada); const out = await sendRecordEmail({ ...deps().email, settings }, { recordId: r.id, templateId: 'tpl_intro', providerId: 'brevo', senderEmail: 'info@vierapparatus.com' });
    const id = out.log!.messageId!; events = [{ event: 'delivered', messageId: id, date: '2026-11-04T10:00:05Z' }, { event: 'opened', messageId: id, date: '2026-11-04T11:00:00Z' }, { event: 'opened', messageId: id, date: '2026-11-04T12:00:00Z' }, { event: 'clicks', messageId: id, date: '2026-11-04T11:05:00Z', link: 'https://vierapparatus.com' }];
    const res = await syncBrevo({ ...deps().email, settings }); expect(res).toMatchObject({ checked: 1, newEvents: 4, errors: [] });
    const rec2 = (await S.getRecord(r.id))!; expect(rec2.cells[fid('emailOpened')]).toBe(true); expect(rec2.cells[fid('lastOpened')]).toBe('2026-11-04'); expect(rec2.cells[fid('emailClicked')]).toBe(true); expect(rec2.cells[fid('emailStatus')]).toBe('Clicked');
    expect((await syncBrevo({ ...deps().email, settings })).newEvents).toBe(0);                          // idempotent
    const sum = summarize(await listEmailLog()); expect(sum).toMatchObject({ sent: 1, delivered: 1, uniqueOpens: 1, clicks: 1, bounces: 0, openRate: 100 });
    expect(await applyWebhookEvents([{ event: 'unsubscribed', 'message-id': id, date: '2026-11-04T13:00:00Z' } as any])).toBe(1);
    const after = (await S.getRecord(r.id))!; expect(after.cells[fid('emailStatus')]).toBe('Unsubscribed'); expect(after.cells[fid('outreachStatus')]).toBe('Do not contact'); expect(summarize(await listEmailLog()).unsubscribes).toBe(1);
    expect(EVENT_MAP.hardBounces).toBe('bounced'); expect(EVENT_MAP.loadedByProxy).toBe('opened');
    expect((await sendRecordEmail({ ...deps().email, settings }, { recordId: r.id, templateId: 'tpl_intro', providerId: 'brevo' })).status).toBe('skipped');
    const t = (await getTemplates())[0]; await saveTemplate({ ...t, id: 'tpl2', name: 'second' });
    expect((await sendRecordEmail({ ...deps().email, settings }, { recordId: r.id, templateId: 'tpl2', providerId: 'brevo' })).message).toMatch(/Do not contact|bounced or unsubscribed/);
  });

  it('a Brevo outage is reported, not swallowed', async () => {
    const r = await rec(ada); brevoDown = true; const out = await sendRecordEmail({ ...deps().email, settings }, { recordId: r.id, templateId: 'tpl_intro', providerId: 'brevo' });
    expect(out.status).toBe('error'); expect(out.message).toMatch(/Brevo 500/); expect((await listEmailLog())[0].status).toBe('failed'); expect((await S.getRecord(r.id))!.cells[fid('emailSent')]).toBeUndefined();
  });

  it('Gmail: MIME with non-ASCII, Send As rules, OAuth redirect parsing', () => {
    const mime = buildMime({ from: { email: 'info@vierapparatus.com', name: 'Vier Äpparatus' }, to: 'a@b.example', subject: 'Grüße – lab', text: 'Hallo', html: '<p>Hallo</p>' });
    expect(mime).toContain('From: =?UTF-8?B?'); expect(mime).toContain('Subject: =?UTF-8?B?'); expect(mime).toContain('multipart/alternative'); expect(mime.split('\r\n').every(l => l.length <= 998)).toBe(true);
    const acct = { email: 'me@gmail.test', accessToken: 't', expiresAt: Date.now() + 1e6, sendAs: [{ email: 'info@vierapparatus.com', verified: true }, { email: 'pending@vierapparatus.com', verified: false }] };
    expect(canSendAs(acct, 'info@vierapparatus.com').ok).toBe(true); expect(canSendAs(acct, 'me@gmail.test').ok).toBe(true); expect(canSendAs(acct, 'pending@vierapparatus.com').message).toMatch(/not verified/); expect(canSendAs(acct, 'other@x.test').message).toMatch(/not a Send As/);
    expect(parseAuthRedirect('https://abc.chromiumapp.org/#access_token=tok&expires_in=3599&token_type=Bearer')).toEqual({ accessToken: 'tok', expiresIn: 3599 }); expect(() => parseAuthRedirect('https://abc.chromiumapp.org/#error=access_denied')).toThrow(/access_denied/);
    expect(buildAuthUrl('cid', 'https://x.chromiumapp.org/')).toContain('gmail.send');
  });
});

void emptyGroup; void ({} as EmailLog);
