import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as S from '../../src/core/store';
import * as DB from '../../src/core/db';
import { fid, TABLE_ID } from '../../src/core/defaults';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings';
import { htmlToText, decodeEntities, signatureHtml, signatureText, sanitizeEmailHtml, isHtmlDocument, emailHtmlWarnings } from '../../src/core/template';
import { readFileSync } from 'fs';
import { renderEmail, sendRecordEmail, saveTemplate, getTemplates, clearSenderCache } from '../../src/email/service';
import { buildMime } from '../../src/email/gmail';
import type { EmailTemplate } from '../../src/core/types';

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

let settings: Settings; const now = new Date('2026-11-18T10:00:00Z');
const deps = () => ({ fetch: net, now: () => now, settings, secrets: { brevoApiKey: 'test-key-1234' } });
const rec = (cells: Record<string, any>) => S.createRecord(TABLE_ID, cells, { silent: true });
const HTML_TPL: EmailTemplate = {
  id: 'tpl_designed', name: 'Designed', createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z',
  format: 'html', subject: 'Hello {First Name | fallback: there}', body: 'plain fallback',
  html: '<h1>Hi {First Name | fallback: there}</h1><p>From {Institution}</p>[[<p>Pleased to see {Latest Research}.</p>]]<p><a href="https://vierapparatus.com">Visit</a></p>',
};

beforeAll(async () => { await S.ensureSeeded(); });
beforeEach(async () => {
  await DB.clear('emailLog'); await DB.kvSet('suppressed', []); clearSenderCache(); sent = [];
  settings = { ...DEFAULT_SETTINGS, sendingEnabled: true, minSendGapSec: 0, emailSignature: '', replyTo: '' };
});

describe('HTML → text, entities, signature', () => {
  it('keeps the words, line breaks, bullets and links, and drops style and script', () => {
    const t = htmlToText('<style>p{color:red}</style><p>Hi &amp; welcome,</p><p>See <a href="https://x.test/a">our page</a> now.</p><ul><li>one</li><li>two</li></ul><script>alert(1)</script>');
    expect(t).toContain('Hi & welcome,'); expect(t).toContain('See our page (https://x.test/a) now.'); expect(t).toContain('• one'); expect(t).toContain('• two');
    expect(t).not.toContain('alert'); expect(t).not.toContain('color:red'); expect(t).not.toContain('<');
  });
  it('decodes named and numeric entities; unknown ones stay as written', () => {
    expect(decodeEntities('a&nbsp;&amp;&#8211;&#x2013;&lt;b&gt;&copy2')).toBe('a &––<b>&copy2');
  });
  it('a signature may be HTML or plain text; plain text keeps its line breaks', () => {
    expect(signatureHtml('Ada\nVierApparatus')).toBe('<p>Ada<br>VierApparatus</p>');
    expect(signatureText('Ada\nVierApparatus')).toBe('Ada\nVierApparatus');
    expect(signatureHtml('<b>Ada</b><br>VierApparatus')).toBe('<b>Ada</b><br>VierApparatus');
    expect(signatureText('<b>Ada</b><br>VierApparatus')).toBe('Ada\nVierApparatus');
  });
});

describe('HTML e-mail design with merge fields', () => {
  it('renders the design with escaped values, drops an empty optional block, and gives a plain-text version', async () => {
    const r = await rec({ [fid('fullName')]: 'Ada & Co', [fid('email')]: 'ada@example.test', [fid('institution')]: 'R&D <Lab>' });
    const p = renderEmail(HTML_TPL, (await S.listFields(TABLE_ID)), (await S.getRecord(r.id))!, settings);
    expect(p.html).toContain('<h1>Hi there</h1>'); expect(p.html).toContain('<p>From R&amp;D &lt;Lab&gt;</p>');
    expect(p.html).not.toContain('Pleased'); expect(p.html).toContain('<a href="https://vierapparatus.com">Visit</a>');
    expect(p.text).toContain('From R&D <Lab>'); expect(p.text).toContain('Visit (https://vierapparatus.com)'); expect(p.text).not.toContain('<h1>');
    expect(p.subject).toBe('Hello there'); expect(p.problems).toEqual([]);
  });
  it('a value that is a script stays text inside the design', async () => {
    const r = await rec({ [fid('email')]: 'x@example.test', [fid('institution')]: '<img src=x onerror=alert(1)>' });
    const p = renderEmail(HTML_TPL, (await S.listFields(TABLE_ID)), (await S.getRecord(r.id))!, settings);
    expect(p.html).not.toContain('<img'); expect(p.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  it('the signature comes after the message and before the footer, in both versions', async () => {
    settings = { ...settings, emailSignature: 'Muhammad Satrio\nVierApparatus, Business Development' };
    const r = await rec({ [fid('email')]: 'x@example.test', [fid('institution')]: 'Example U' });
    const p = renderEmail(HTML_TPL, (await S.listFields(TABLE_ID)), (await S.getRecord(r.id))!, settings);
    const sigAt = p.text.indexOf('Muhammad Satrio'), footAt = p.text.indexOf('--\nVierApparatus · https://vierapparatus.com');
    expect(sigAt).toBeGreaterThan(p.text.indexOf('Visit')); expect(footAt).toBeGreaterThan(sigAt);
    expect(p.html).toContain('Muhammad Satrio<br>VierApparatus, Business Development');
    expect(p.html.indexOf('Muhammad Satrio')).toBeLessThan(p.html.indexOf('unsubscribe'));
  });
  it('a plain-text template without a signature is unchanged: message, then “--” and the footer', async () => {
    const [intro] = (await getTemplates()).filter(t => t.id === 'tpl_intro');
    const r = await rec({ [fid('fullName')]: 'Ada Lovelace', [fid('firstName')]: 'Ada', [fid('email')]: 'ada@example.test', [fid('institution')]: 'Example U' });
    const p = renderEmail(intro, (await S.listFields(TABLE_ID)), (await S.getRecord(r.id))!, settings);
    expect(p.text.startsWith('Hi Ada,')).toBe(true);
    expect(p.text.endsWith(`\n\n--\n${settings.emailFooter.trim()}`)).toBe(true);
  });
});

describe('sending the HTML design, the signature and the Reply-To address', () => {
  it('sends the HTML with the signature, a text alternative and the Reply-To header (Brevo)', async () => {
    await saveTemplate(HTML_TPL);
    settings = { ...settings, emailSignature: 'Muhammad Satrio', replyTo: 'replies@vierapparatus.com' };
    const r = await rec({ [fid('email')]: 'ada@example.test', [fid('institution')]: 'Example U' });
    const out = await sendRecordEmail({ ...deps(), settings }, { recordId: r.id, templateId: HTML_TPL.id, providerId: 'brevo', senderEmail: 'info@vierapparatus.com' });
    expect(out.status).toBe('sent');
    expect(sent[0]).toMatchObject({ replyTo: { email: 'replies@vierapparatus.com' }, to: [{ email: 'ada@example.test' }] });
    expect(sent[0].htmlContent).toContain('<h1>Hi there</h1>'); expect(sent[0].htmlContent).toContain('Muhammad Satrio');
    expect(sent[0].textContent).toContain('From Example U'); expect(sent[0].textContent).not.toContain('<');
  });
  it('no Reply-To set → no Reply-To in the request', async () => {
    const r = await rec({ [fid('email')]: 'ada@example.test' });
    const out = await sendRecordEmail({ ...deps(), settings }, { recordId: r.id, templateId: 'tpl_intro', providerId: 'brevo', senderEmail: 'info@vierapparatus.com' });
    expect(out.status).toBe('sent'); expect(sent[0].replyTo).toBeUndefined();
  });
  it('an invalid Reply-To address stops the send with a clear message', async () => {
    settings = { ...settings, replyTo: 'not-an-address' };
    const r = await rec({ [fid('email')]: 'ada@example.test' });
    const out = await sendRecordEmail({ ...deps(), settings }, { recordId: r.id, templateId: 'tpl_intro', providerId: 'brevo', senderEmail: 'info@vierapparatus.com' });
    expect(out.status).toBe('skipped'); expect(out.message).toMatch(/Reply-To/); expect(sent).toHaveLength(0);
  });
  it('Gmail messages carry the Reply-To header and both parts', () => {
    const mime = buildMime({ from: { email: 'info@vierapparatus.com', name: 'VierApparatus' }, to: 'ada@example.test', subject: 'Hi', text: 'Hi', html: '<p>Hi</p>', replyTo: 'replies@vierapparatus.com' });
    expect(mime).toContain('Reply-To: replies@vierapparatus.com'); expect(mime).toContain('text/plain'); expect(mime).toContain('text/html');
  });
});

describe('a pasted HTML document is an HTML e-mail; scripts and handlers are removed', () => {
  const PASTED = '<!DOCTYPE html><html><head><title>Application Status</title><style>p{color:#222}</style><script src="https://cdn.tailwindcss.com"></script></head><body><h1>Hi {First Name | fallback: there}</h1><p>Your application for {Institution} is under review.</p><a href="javascript:alert(1)" onclick="copy()">Copy link</a><script>copy()</script></body></html>';
  it('is sent and previewed as HTML: scripts and handlers are gone, the signature sits inside the document', async () => {
    const fields = await S.listFields(TABLE_ID);
    const r = await rec({ [fid('email')]: 'ada@example.test', [fid('institution')]: 'R&D Lab' });
    const tpl: EmailTemplate = { id: 'tpl_paste', name: 'Pasted', createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', subject: 'Application status', body: PASTED };
    settings = { ...settings, emailSignature: 'Recruitment Team' };
    const p = renderEmail(tpl, fields, (await S.getRecord(r.id))!, settings);
    expect(p.html).toContain('<h1>Hi there</h1>'); expect(p.html).toContain('Your application for R&amp;D Lab is under review.');
    expect(p.html).not.toContain('<script'); expect(p.html).not.toContain('onclick'); expect(p.html).not.toContain('javascript:');
    expect(p.html).toContain('<title>Application Status</title>'); expect(p.html).toContain('<style>p{color:#222}</style>');
    expect(p.html.indexOf('Recruitment Team')).toBeLessThan(p.html.indexOf('</body>'));
    expect(p.text).toContain('Your application for R&D Lab is under review.'); expect(p.text).not.toMatch(/<[a-z]/i);
    expect(p.text).toContain('Copy link'); expect(p.text).not.toContain('(#)');
  });
  it('a plain message without HTML tags is still plain text', async () => {
    const fields = await S.listFields(TABLE_ID);
    const r = await rec({ [fid('email')]: 'ada@example.test' });
    const tpl: EmailTemplate = { id: 'tpl_plain', name: 'Plain', createdAt: '', updatedAt: '', subject: 'Hi', body: 'Hello {First Name | fallback: there}' };
    const p = renderEmail(tpl, fields, (await S.getRecord(r.id))!, settings);
    expect(p.text.startsWith('Hello there')).toBe(true); expect(p.html).toContain('<p>Hello there</p>');
  });
});

describe('what mail apps show: icons, scripts and classes', () => {
  it('inline SVG is removed (Gmail and Outlook do not show it); the rest is kept', () => {
    const out = sanitizeEmailHtml('<p>Hi</p><svg width="24"><path d="M0 0"/></svg><p>Bye</p>');
    expect(out).not.toContain('svg'); expect(out).toContain('<p>Hi</p>'); expect(out).toContain('<p>Bye</p>');
  });
  it('the editor warns about Tailwind, SVG, scripts and buttons in a pasted design', () => {
    const w = emailHtmlWarnings('<head><script src="https://cdn.tailwindcss.com"></script></head><body class="p-4"><svg><path/></svg><button>Copy</button></body>');
    expect(w.join(' ')).toMatch(/Tailwind/); expect(w.join(' ')).toMatch(/SVG/); expect(w.join(' ')).toMatch(/<button>/); expect(w.join(' ')).toMatch(/Scripts/);
    expect(emailHtmlWarnings('<p style="color:red">plain</p>')).toEqual([]);
  });
  it('the sample design in samples/ renders as a clean e-mail with the name filled in and no unknown fields', async () => {
    const file = readFileSync(new URL('../../samples/application-update-email.html', import.meta.url), 'utf8');
    const fields = await S.listFields(TABLE_ID);
    const r = await rec({ [fid('email')]: 'ada@example.test', [fid('firstName')]: 'Ada' });
    const tpl: EmailTemplate = { id: 'tpl_sample', name: 'Sample', createdAt: '', updatedAt: '', subject: 'Application update', body: 'x', format: 'html', html: file };
    const p = renderEmail(tpl, fields, (await S.getRecord(r.id))!, settings);
    expect(p.problems).toEqual([]); expect(p.html).toContain('Hi Ada,'); expect(p.html).toContain('Application Update');
    expect(p.html).toContain('Visit www.vierapparatus.com'); expect(p.html).not.toContain('<svg'); expect(p.text).toContain('Sorry, we are unable to proceed further');
  });
});

describe('the “thank you for applying” test e-mail (samples/apply-thanks-test-email.html)', () => {
  it('renders with the name, the logo from the website, the test placeholder and the website button – and needs no warnings', async () => {
    const file = readFileSync(new URL('../../samples/apply-thanks-test-email.html', import.meta.url), 'utf8');
    expect(emailHtmlWarnings(file)).toEqual([]);
    const fields = await S.listFields(TABLE_ID);
    const r = await rec({ [fid('email')]: 'ada@example.test', [fid('firstName')]: 'Ada' });
    const tpl: EmailTemplate = { id: 'tpl_apply', name: 'Apply', createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', subject: 'Thank you for applying to VierApparatus', body: 'x', format: 'html', html: file };
    const p = renderEmail(tpl, fields, (await S.getRecord(r.id))!, settings);
    expect(p.problems).toEqual([]); expect(p.subject).toBe('Thank you for applying to VierApparatus');
    expect(p.html).toContain('Hi Ada,'); expect(p.html).toContain('https://vierapparatus.com/brand/vier-wordmark.png');
    expect(p.html).toContain('[Paste the test link or instructions here]'); expect(p.html).toContain('href="https://vierapparatus.com"');
    expect(p.text).toContain('Thank you for applying to VierApparatus.');
  });
});
