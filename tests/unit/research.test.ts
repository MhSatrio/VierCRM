import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as S from '../../src/core/store';
import * as DB from '../../src/core/db';
import { fid, TABLE_ID } from '../../src/core/defaults';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings';
import { nameScore, institutionScore, scoreAuthor, decide, searchName } from '../../src/research/matching';
import { runLookups, searchPublication, getFile } from '../../src/research/lookup';
import { downloadPdf, findFullText, pdfFileName } from '../../src/research/fulltext';
import { deriveKeywords } from '../../src/research/keywords';
import type { Ctx } from '../../src/research/http';
import type { AttachmentValue, MatchCandidate } from '../../src/core/types';

// ---- a scripted network: [url regex, handler]
type Handler = (u: URL, init?: RequestInit) => Response | Promise<Response>;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, ...Array(200).fill(65)]).buffer;
const pdfRes = () => new Response(PDF.slice(0), { headers: { 'content-type': 'application/pdf' } });
const html = (s: string, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html' } });

function makeCtx(routes: [RegExp, Handler][], over: Partial<Settings> = {}): Ctx & { calls: string[] } {
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => { calls.push(url); const u = new URL(url); for (const [re, h] of routes) if (re.test(url)) return h(u, init); return new Response('not found', { status: 404 }); };
  return { fetch, calls, settings: { ...DEFAULT_SETTINGS, unpaywallEmail: 'tester@test.invalid', lookupDelayMs: 0, ...over }, secrets: {}, sleep: async () => {}, now: () => new Date('2026-11-04') };
}

const oaAuthor = (id: string, name: string, inst: string, extra: any = {}) => ({ id: `https://openalex.org/${id}`, display_name: name, works_count: 40, last_known_institutions: [{ display_name: inst }], topics: [{ display_name: 'Analytical chemistry' }], ...extra });
const oaWork = (title: string, date: string, extra: any = {}) => ({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1234/latest', display_name: title, publication_year: Number(date.slice(0, 4)), publication_date: date, type: 'article', primary_location: { landing_page_url: 'https://journal.test/article/1', source: { display_name: 'Journal of Examples' } }, authorships: [{ author: { display_name: 'Ada Lovelace' } }], abstract_inverted_index: { Mass: [0], spectrometry: [1], of: [2], samples: [3], 'improves.': [4] }, open_access: { oa_status: 'gold', oa_url: 'https://journal.test/article/1' }, best_oa_location: { pdf_url: null, landing_page_url: 'https://journal.test/article/1' }, ...extra });

describe('author matching – a name alone is never proof', () => {
  it('searches with the name an index knows – no honorifics or degrees', () => {
    expect(searchName('Prof. Dr. Anna Example')).toBe('Anna Example'); expect(searchName('Dr. Bram Fixture, PhD')).toBe('Bram Fixture'); expect(searchName('Erik Mockson')).toBe('Erik Mockson'); expect(searchName('Assoc. Prof. Chen Sample (visiting)')).toBe('Chen Sample'); expect(searchName('Dr.')).toBe('Dr.');
  });
  it('scores names, initials, order and surnames', () => {
    expect(nameScore('Ada Lovelace', 'Ada Lovelace')).toBe(0.5); expect(nameScore('Lovelace, Ada', 'Ada Lovelace')).toBe(0.5); expect(nameScore('Prof. Dr. Ada Lovelace', 'ada lovelace')).toBe(0.5);
    expect(nameScore('Ada Lovelace', 'A. Lovelace')).toBe(0.35); expect(nameScore('Ada Lovelace', 'Alan Lovelace')).toBe(0); expect(nameScore('José García', 'Jose Garcia')).toBe(0.5); expect(nameScore('Ada Lovelace', 'Ada King')).toBe(0);
  });
  it('compares institutions ignoring "University of" noise', () => {
    expect(institutionScore('Example University', ['University of Example'])).toBe(0.3); expect(institutionScore('Example University', ['Other College'])).toBe(0);
  });
  it('chooses automatically only with a clear, confident winner', () => {
    const mk = (id: string, c: number): MatchCandidate => ({ id, name: id, confidence: c, reasons: [], source: 'openalex' });
    expect(decide([mk('a', 0.8), mk('b', 0.4)]).status).toBe('found'); expect(decide([mk('a', 0.8), mk('b', 0.7)]).status).toBe('ambiguous'); expect(decide([mk('a', 0.5)]).status).toBe('ambiguous'); expect(decide([mk('a', 0.1)]).status).toBe('none');
    expect(scoreAuthor({ name: 'Ada Lovelace' }, { names: ['Ada Lovelace'], institutions: ['X'] }).confidence).toBe(0.5);                 // name only → below the 0.75 bar
    expect(scoreAuthor({ name: 'Ada Lovelace', profileUrl: 'https://orcid.org/0000-0001-2345-6789' }, { names: ['Ada Lovelace'], institutions: [], ids: ['https://orcid.org/0000-0001-2345-6789'] }).confidence).toBeGreaterThanOrEqual(1);
  });
});

describe('full-text retrieval is lawful and validated', () => {
  it('accepts only real PDFs; rejects login pages and restricted files with a reason', async () => {
    const ctx = makeCtx([[/ok\.pdf/, pdfRes], [/landing/, () => html('<html>Please log in</html>')], [/paywall/, () => new Response('no', { status: 403 })]]);
    expect('bytes' in await downloadPdf(ctx, 'https://x.test/ok.pdf')).toBe(true);
    expect(await downloadPdf(ctx, 'https://x.test/landing')).toEqual({ reason: 'not a PDF (a login or landing page)' });
    expect((await downloadPdf(ctx, 'https://x.test/paywall') as any).reason).toMatch(/403 – access restricted/);
    const big = makeCtx([[/big/, () => new Response(PDF.slice(0), { headers: { 'content-length': String(500 * 1024 * 1024) } })]]); expect((await downloadPdf(big, 'https://x.test/big') as any).reason).toMatch(/larger than/);
  });
  it('tries Unpaywall, then OpenAlex locations; never touches Sci-Hub; names files predictably', async () => {
    const ctx = makeCtx([
      [/api\.unpaywall\.org/, () => json({ is_oa: true, oa_status: 'green', best_oa_location: { url_for_pdf: 'https://repo.test/bad.pdf', host_type: 'repository' }, oa_locations: [{ url_for_pdf: 'https://repo.test/good.pdf', host_type: 'repository' }] })],
      [/bad\.pdf/, () => html('<html>login</html>')], [/good\.pdf/, pdfRes], [/openalex/, () => json({})],
    ]);
    const r = await findFullText(ctx, { title: 'Mass spectrometry of samples', year: 2026, doi: '10.1234/x', authors: ['Ada Lovelace'], source: 'openalex' });
    expect(r.file?.sourceUrl).toBe('https://repo.test/good.pdf'); expect(r.file?.name).toBe('lovelace_2026_mass-spectrometry-of-samples.pdf'); expect(r.log.join(' ')).toMatch(/Unpaywall: open access \(green\)/);
    expect(ctx.calls.some(u => /sci-hub|scihub|libgen|sci\.hub/i.test(u))).toBe(false);
    expect(pdfFileName({ title: 'T', year: undefined, authors: [] })).toBe('paper_n-d_t.pdf');
  });
  it('reports "unavailable" honestly when only a paywalled landing page exists, and uses your browser session only when enabled', async () => {
    const seen: (RequestCredentials | undefined)[] = [];
    const routes: [RegExp, Handler][] = [[/api\.unpaywall\.org/, () => json({ is_oa: false })], [/openalex|europepmc/, () => json({})], [/journal\.test\/article/, (_u, init) => { seen.push(init?.credentials); return html('<meta name="citation_pdf_url" content="https://journal.test/files/a.pdf">'); }], [/a\.pdf/, (_u, init) => { seen.push(init?.credentials); return new Response('login', { status: 403 }); }]];
    const pub = { title: 'T', year: 2026, doi: '10.1/x', url: 'https://journal.test/article/1', authors: ['A B'], source: 'crossref' as const };
    const off = await findFullText(makeCtx(routes), { ...pub }); expect(off.file).toBeUndefined(); expect(off.log.join('\n')).toMatch(/403 – access restricted/); expect(seen.every(c => c === 'omit')).toBe(true);
    seen.length = 0; await findFullText(makeCtx(routes, { institutionalAccess: true }), { ...pub }); expect(seen.every(c => c === 'include')).toBe(true);
  });
  it('asks for an Unpaywall e-mail instead of sending an empty one', async () => {
    const ctx = makeCtx([[/openalex|europepmc/, () => json({})]], { unpaywallEmail: '' }); const r = await findFullText(ctx, { title: 'T', doi: '10.1/x', authors: [], source: 'openalex' });
    expect(r.log.join(' ')).toMatch(/Unpaywall skipped/); expect(ctx.calls.some(u => u.includes('unpaywall'))).toBe(false);
  });
});

describe('keywords come from the paper itself', () => {
  it('uses source keywords first, otherwise frequent phrases – and never invents', () => {
    expect(deriveKeywords({ title: 'x', keywords: ['Mass spectrometry', 'Proteomics', 'Chromatography'] })).toEqual(['mass spectrometry', 'proteomics', 'chromatography']);
    const k = deriveKeywords({ title: 'Mass spectrometry of plant proteins', abstract: 'We apply mass spectrometry to plant proteins and compare protein extraction methods.' });
    expect(k).toContain('mass spectrometry'); expect(k.every(x => !/^(we|the|and)$/.test(x))).toBe(true); expect(deriveKeywords({ title: 'a', abstract: '' })).toEqual([]);
  });
});

describe('publication research workflow on a record', () => {
  beforeAll(async () => { await S.ensureSeeded(); });
  const mkRecord = (cells: Record<string, string>) => S.createRecord(TABLE_ID, cells);
  const ada = { [fid('fullName')]: 'Ada Lovelace', [fid('institution')]: 'Example University' };
  const happyRoutes = (): [RegExp, Handler][] => [
    [/openalex\.org\/authors/, () => json({ results: [oaAuthor('A1', 'Ada Lovelace', 'University of Example'), oaAuthor('A2', 'Ada Lovelace', 'Other College', { topics: [] })] })],
    [/openalex\.org\/works\/https/, () => json(oaWork('Mass spectrometry of samples', '2026-03-10'))],
    [/openalex\.org\/works\?/, () => json({ results: [oaWork('Older paper', '2020-01-01'), oaWork('Mass spectrometry of samples', '2026-03-10'), oaWork('Erratum', '2026-05-01', { type: 'erratum' })] })],
    [/api\.unpaywall\.org/, () => json({ is_oa: true, oa_status: 'gold', best_oa_location: { url_for_pdf: 'https://journal.test/files/paper.pdf', host_type: 'publisher' } })],
    [/paper\.pdf/, pdfRes], [/europepmc/, () => json({ resultList: { result: [] } })],
  ];

  it('Full Name → Latest Publication → DOI/URL/Date → PDF attachment, in dependency order', async () => {
    const rec = await mkRecord(ada); const ctx = makeCtx(happyRoutes());
    const run = await runLookups(rec.id, ctx);
    const c = run.record.cells; expect(run.found).toBe(true);
    expect(c[fid('latestPublication')]).toBe('Mass spectrometry of samples'); expect(c[fid('publicationDoi')]).toBe('10.1234/latest'); expect(c[fid('publicationDate')]).toBe('2026-03-10'); expect(c[fid('publicationUrl')]).toBe('https://journal.test/article/1');
    expect(c[fid('publicationAccess')]).toBe('Open access (gold)'); expect(c[fid('latestResearch')]).toBe('Mass spectrometry of samples'); expect(String(c[fid('researchKeywords')])).toContain('mass spectrometry');
    const att = c[fid('publicationFile')] as AttachmentValue; expect(att.files).toHaveLength(1); expect(att.files[0]).toMatchObject({ name: 'lovelace_2026_mass-spectrometry-of-samples.pdf', mime: 'application/pdf', doi: '10.1234/latest', year: 2026, venue: 'Journal of Examples', access: 'Open access (gold)' });
    expect((await getFile(att.files[0].id))!.data.byteLength).toBe(PDF.byteLength); expect(c[fid('publicationStatus')]).toBe('PDF attached');
    expect(run.record.meta!.publications![fid('latestPublication')].authorMatch!.reasons).toContain('same institution');
    const order = run.reports.map(r => r.fieldId); expect(order.indexOf(fid('latestPublication'))).toBeLessThan(order.indexOf(fid('publicationDoi'))); expect(order.indexOf(fid('publicationDoi'))).toBeLessThan(order.indexOf(fid('publicationFile')));
    expect(ctx.calls.filter(u => /openalex\.org\/authors/.test(u))).toHaveLength(1);
  });

  it('never overwrites what is already there, unless forced', async () => {
    const rec = await mkRecord({ ...ada, [fid('latestPublication')]: 'My own entry', [fid('researchKeywords')]: 'scraped interests' });
    const run = await runLookups(rec.id, makeCtx(happyRoutes()));
    expect(run.record.cells[fid('latestPublication')]).toBe('My own entry'); expect(run.record.cells[fid('researchKeywords')]).toBe('scraped interests');
    expect(run.reports.find(r => r.fieldId === fid('latestPublication'))!.message).toBe('already has a value');
    expect(run.reports.find(r => r.fieldId === fid('publicationDoi'))!.message).toMatch(/“Latest Publication” is empty/);   // no stored result → downstream does not run
  });

  it('two researchers with the same name and no institution → the user chooses; the choice continues the chain', async () => {
    const routes = happyRoutes(); routes[0] = [/openalex\.org\/authors/, () => json({ results: [oaAuthor('A1', 'John Smith', 'University of Alpha'), oaAuthor('A2', 'John Smith', 'Beta Institute')] })];
    const rec = await mkRecord({ [fid('fullName')]: 'John Smith' }); const ctx = makeCtx(routes);
    const first = await runLookups(rec.id, ctx);
    const pend = first.record.meta!.pending![fid('latestPublication')]; expect(pend.candidates.map(c => c.institution)).toEqual(expect.arrayContaining(['University of Alpha', 'Beta Institute']));
    expect(first.record.cells[fid('latestPublication')]).toBeUndefined(); expect(first.record.cells[fid('publicationStatus')]).toBe('Needs match'); expect(first.reports.find(r => r.fieldId === fid('publicationDoi'))!.message).toMatch(/skipped/);
    expect(ctx.calls.some(u => /openalex\.org\/works\?/.test(u))).toBe(false);          // no works were fetched for an uncertain match
    const second = await runLookups(rec.id, ctx, { choice: { fieldId: fid('latestPublication'), candidate: pend.candidates.find(c => c.institution === 'Beta Institute')! } });
    expect(second.record.cells[fid('latestPublication')]).toBe('Mass spectrometry of samples'); expect(second.record.meta!.pending![fid('latestPublication')]).toBeUndefined();
    expect(second.record.meta!.publications![fid('latestPublication')].authorMatch).toMatchObject({ confidence: 1, reasons: ['chosen by you'] });
  });

  it('a name match at a DIFFERENT institution is not auto-accepted', async () => {
    const routes = happyRoutes(); routes[0] = [/openalex\.org\/authors/, () => json({ results: [oaAuthor('A9', 'Ada Lovelace', 'Totally Different Institute')] })];
    const rec = await mkRecord(ada); const run = await runLookups(rec.id, makeCtx([...routes, [/crossref/, () => json({ message: { items: [] } })]]));
    expect(run.record.meta!.pending?.[fid('latestPublication')]).toBeTruthy(); expect(run.record.cells[fid('latestPublication')]).toBeUndefined();
  });

  it('no publication PDF: metadata is kept and the field says "Full text unavailable"', async () => {
    const routes = happyRoutes().filter(r => !/unpaywall|paper\\.pdf/.test(r[0].source)); routes.push([/api\.unpaywall\.org/, () => json({ is_oa: false })], [/journal\.test\/article/, () => html('<html>abstract only</html>')]);
    const rec = await mkRecord(ada); const run = await runLookups(rec.id, makeCtx(routes));
    const att = run.record.cells[fid('publicationFile')] as AttachmentValue; expect(att.files).toHaveLength(0); expect(att.unavailable).toBe('Full text unavailable');
    expect(run.record.cells[fid('latestPublication')]).toBe('Mass spectrometry of samples'); expect(run.record.cells[fid('publicationDoi')]).toBe('10.1234/latest'); expect(run.record.cells[fid('publicationStatus')]).toBe('Full text unavailable');
    expect(run.reports.find(r => r.fieldId === fid('publicationFile'))!.log!.join(' ')).toMatch(/No legally accessible PDF/);
  });

  it('empty upstream field → nothing downstream runs, with messages naming the missing field', async () => {
    const rec = await mkRecord({ [fid('position')]: 'Professor' }); const ctx = makeCtx(happyRoutes());
    const run = await runLookups(rec.id, ctx); expect(run.found).toBe(false);
    expect(run.reports.find(r => r.fieldId === fid('latestPublication'))!.message).toMatch(/“Full Name” is empty/);
    expect(run.reports.filter(r => r.status === 'skipped').length).toBe(run.reports.length); expect(ctx.calls).toHaveLength(0);
  });

  it('falls back to Crossref (author list is checked, affiliation counts) and reports source errors', async () => {
    const routes: [RegExp, Handler][] = [
      [/openalex\.org\/authors/, () => new Response('down', { status: 500 })],
      [/api\.crossref\.org\/works\?/, () => json({ message: { items: [
        { DOI: '10.5555/new', title: ['Crossref paper'], issued: { 'date-parts': [[2026, 2, 1]] }, 'container-title': ['Journal X'], URL: 'https://doi.org/10.5555/new', author: [{ given: 'Ada', family: 'Lovelace', affiliation: [{ name: 'Example University' }] }] },
        { DOI: '10.5555/other', title: ['Someone else'], issued: { 'date-parts': [[2026, 6, 1]] }, author: [{ given: 'Bob', family: 'Other' }] }] } })],
    ];
    const ctx = makeCtx(routes); const out = await searchPublication(ctx, { name: 'Ada Lovelace', institution: 'Example University' }, ['openalex', 'crossref'], {});
    expect(out.status).toBe('found'); if (out.status === 'found') { expect(out.pub.title).toBe('Crossref paper'); expect(out.pub.date).toBe('2026-02-01'); expect(out.pub.authorMatch!.reasons).toContain('same institution'); }
    const none = await searchPublication(makeCtx([[/openalex/, () => new Response('x', { status: 500 })]]), { name: 'Ada Lovelace' }, ['openalex'], {}); expect(none.status).toBe('none'); if (none.status === 'none') expect(none.errors[0]).toMatch(/OpenAlex/);
  });

  it('Google Scholar is read through your own tab and STOPS at a human check', async () => {
    const ctx = makeCtx([]); ctx.renderPage = async () => ({ blocked: 'unusual-traffic check', hits: [] });
    const out = await searchPublication(ctx, { name: 'Ada Lovelace' }, ['googlescholar'], {}); expect(out.status).toBe('none'); if (out.status === 'none') expect(out.errors[0]).toMatch(/never bypasses/);
    ctx.renderPage = async () => ({ hits: [{ title: 'Scholar paper', authors: 'A Lovelace, B Babbage', year: 2025, venue: 'Journal Y', url: 'https://s.test/1' }] });
    const ok = await searchPublication(ctx, { name: 'Ada Lovelace' }, ['googlescholar'], {}); expect(ok.status).toBe('ambiguous');       // name only → asks the user
  });

  it('year range and keyword filters apply', async () => {
    const rec = await mkRecord(ada); const routes = happyRoutes();
    const ctx = makeCtx(routes); const out = await searchPublication(ctx, { name: 'Ada Lovelace', institution: 'Example University' }, ['openalex'], { yearTo: 2021 });
    expect(out.status).toBe('found'); if (out.status === 'found') expect(out.pub.title).toBe('Older paper'); void rec;
    const none = await searchPublication(makeCtx(routes), { name: 'Ada Lovelace', institution: 'Example University' }, ['openalex'], { mustContain: 'quantum' }); expect(none.status).toBe('none');
  });
});

beforeEach(() => {});
void DB;
