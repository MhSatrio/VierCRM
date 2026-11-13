import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
// @ts-expect-error – plain JS fixtures shared with the browser test
import { COMPANIES, companiesList, companyPage } from '../fixtures/site.mjs';
import * as S from '../../src/core/store';
import * as DB from '../../src/core/db';
import { CATALOG, COMPANIES_ID, CONTACTS_ID, fidFor, idOf, keyOf, researchAddOn, RESEARCH_KEYS, TABLE_ID, TEMPLATES } from '../../src/core/defaults';
import { buildDedupeIndex } from '../../src/core/dedupe';
import { validateDependencies, topologicalOrder } from '../../src/core/deps';
import { detectPeople } from '../../src/scrape/detect';
import { extractPerson, labelledPairs, decodeBase64Mail, findEmails } from '../../src/scrape/extract';
import { exampleScrapeConfigs } from '../../src/core/defaults';
import { crawlPage, type PageIO } from '../../src/scrape/pageCrawler';
import { findNextUrl, findNextButton } from '../../src/scrape/paginate';
import { findCandidates, autoResearchTable, autoResearchRecords, RETRY_ERROR_MS, RETRY_NONE_MS } from '../../src/research/auto';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import type { Ctx } from '../../src/research/http';
import type { Field, ScrapedPerson } from '../../src/core/types';

const BASE = 'http://127.0.0.1:9';
const dom = (html: string, url: string) => new JSDOM(html, { url, pretendToBeVisual: true }).window.document;
const person = (values: Record<string, string>, over: Partial<ScrapedPerson> = {}): ScrapedPerson => ({ sourceUrl: `${BASE}/companies`, profileUrl: values.fld_profileUrl || '', values, fieldsFound: Object.keys(values), status: 'ok', ...over });

describe('bases and templates', () => {
  beforeAll(async () => { await S.ensureSeeded(); });

  it('a fresh install has Researchers, Contacts and Companies – nothing is called “Research Contacts” any more', async () => {
    const tables = await S.listTables();
    expect(tables.map(t => t.name)).toEqual(['Researchers', 'Contacts', 'Companies']);
    expect(tables.map(t => t.template)).toEqual(['researchers', 'contacts', 'companies']);
    expect(tables.find(t => t.id === TABLE_ID)!.autoResearch).toBe(true);
    expect((await S.listDatabases()).map(d => d.name)).not.toContain('Research Contacts');
  });

  it('every field has a semantic key; ids never collide between bases; the Researchers base keeps its original ids', async () => {
    const ids = new Set<string>(); let n = 0;
    for (const t of await S.listTables()) for (const f of await S.listFields(t.id)) { n++; ids.add(f.id); expect(f.key, `${t.name}/${f.name}`).toBeTruthy(); expect(keyOf(f)).toBe(f.key); }
    expect(ids.size).toBe(n);
    const researchers = await S.listFields(TABLE_ID); expect(researchers.find(f => f.key === 'latestPublication')!.id).toBe('fld_latestPublication');
    expect(idOf(await S.listFields(CONTACTS_ID), 'email')).toBe(`${CONTACTS_ID}__email`);
  });

  it('templates differ in what they offer: Contacts have e-mail and position, Companies have website and industry, neither has research fields', async () => {
    const c = await S.listFields(CONTACTS_ID), co = await S.listFields(COMPANIES_ID);
    for (const k of ['fullName', 'position', 'email', 'phone', 'outreachStatus']) expect(idOf(c, k), k).toBeTruthy();
    for (const k of ['website', 'industry', 'size', 'location', 'email']) expect(idOf(co, k), k).toBeTruthy();
    expect(c.some(f => f.lookup) || co.some(f => f.lookup)).toBe(false);
    expect(c.find(f => f.key === 'institution')!.name).toBe('Company');                   // a company field in the people template
    expect(co.find(f => f.primary)!.name).toBe('Company');
  });

  it('createBase(): a new base from any template, with its own views and duplicate rules', async () => {
    const t = await S.createBase('Suppliers', 'companies'); expect(t.name).toBe('Suppliers'); expect(t.template).toBe('companies');
    const f = await S.listFields(t.id); expect(f.every(x => x.tableId === t.id && x.id.startsWith(`${t.id}__`))).toBe(true);
    expect((await S.listViews(t.id)).map(v => v.name)).toEqual(expect.arrayContaining(['All records', 'Missing Email', 'Recently Scraped']));
    const rules = await S.getDedupeRules(t.id); expect(rules.some(r => r.fieldIds[0] === fidFor(t.id, 'website'))).toBe(true);
    const blank = await S.createBase('Anything', 'blank'); expect((await S.listFields(blank.id)).map(x => x.name)).toEqual(['Name', 'Notes', 'Website', 'Source URL', 'Scraping Date', 'Scraping Status']);
    const emptyName = await S.createBase('  ', 'contacts'); expect(emptyName.name).toBe('Contacts');
    await S.deleteTable(emptyName.id); await S.deleteTable(blank.id); await S.deleteTable(t.id);
    expect((await S.listFields(t.id)).length).toBe(0); expect((await S.listTables()).length).toBe(3);
  });

  it('research fields can be added to ANY base, wired to that base’s own fields, once', async () => {
    const t = await S.createBase('Leads', 'contacts');
    const added = await S.addResearchFields(t.id); expect(added.map(f => f.key).sort()).toEqual([...RESEARCH_KEYS].sort());
    const fields = await S.listFields(t.id); const search = fields.find(f => f.key === 'latestPublication')!;
    expect(search.lookup!.kind).toBe('search'); expect(search.lookup!.nameFieldId).toBe(idOf(fields, 'fullName')); expect(search.lookup!.institutionFieldId).toBe(idOf(fields, 'institution')); expect(search.lookup!.profileUrlFieldId).toBe(idOf(fields, 'profileUrl'));
    expect(fields.find(f => f.key === 'publicationDoi')!.lookup).toMatchObject({ kind: 'derive', fromFieldId: search.id, output: 'doi' });
    expect(fields.find(f => f.key === 'publicationFile')!.lookup).toMatchObject({ kind: 'pdf', fromFieldId: search.id });
    expect(validateDependencies(fields)).toEqual([]); expect(() => topologicalOrder(fields, f => !!f.lookup)).not.toThrow();
    expect((await S.getTable(t.id))!.autoResearch).toBe(true);
    expect((await S.listViews(t.id)).map(v => v.name)).toEqual(expect.arrayContaining(['Missing Publication', 'Publication Found', 'PDF Available']));
    expect(await S.addResearchFields(t.id)).toEqual([]);                                                  // idempotent
    expect((await S.listFields(t.id)).length).toBe(fields.length);
    await S.deleteTable(t.id);
  });

  it('a field the user already made is not duplicated by the add-on (matched by name)', () => {
    const mine: Field[] = [{ id: 'x1', tableId: 't', name: 'Latest Publication', type: 'text', order: 0 }, { id: 'x2', tableId: 't', name: 'Full Name', type: 'text', order: 1, primary: true, key: 'fullName' }];
    expect(researchAddOn('t', mine).map(f => f.name)).not.toContain('Latest Publication');
    expect(Object.keys(CATALOG)).toEqual(expect.arrayContaining(RESEARCH_KEYS));
    expect(TEMPLATES.map(t => t.id)).toEqual(['contacts', 'companies', 'places', 'researchers', 'blank']);
  });
});

describe('scraping into any base', () => {
  beforeAll(async () => { await S.ensureSeeded(); });

  it('“any list” detection finds company cards (names are not people’s names); people mode would reject them', () => {
    const d = dom(companiesList(), `${BASE}/companies`);
    const cards = detectPeople(d, { baseUrl: `${BASE}/companies`, kind: 'items' });
    expect(cards.map(c => c.name)).toEqual(COMPANIES.map((c: any) => c.name)); expect(cards[0].url).toBe(`${BASE}/company/northwind-instruments`);
    const odd = dom('<ul><li><a href="/c/1">Bio-Lab 24 GmbH</a></li><li><a href="/c/2">xyz instruments</a></li><li><a href="/c/3">ACME &amp; Sons 2000</a></li><li><a href="/c/4">3D Optics</a></li></ul>', `${BASE}/list`);
    expect(detectPeople(odd, { baseUrl: `${BASE}/list` }).length).toBeLessThan(4); expect(detectPeople(odd, { baseUrl: `${BASE}/list`, kind: 'items' }).map(x => x.name)).toEqual(['Bio-Lab 24 GmbH', 'xyz instruments', 'ACME & Sons 2000', '3D Optics']);
    expect(exampleScrapeConfigs().map(c => [c.id, c.list.kind])).toEqual([['cfg_university_directory', 'people'], ['cfg_company_listing', 'items'], ['cfg_google_maps', 'items']]);
  });

  it('a company page gives website, industry, size, location, a generic mailbox, phone, description and every “Label: value” pair', () => {
    const cfg = exampleScrapeConfigs()[1]; const c = COMPANIES[1];
    const ex = extractPerson(dom(companyPage(c.slug), `${BASE}/company/${c.slug}`), cfg, { url: `${BASE}/company/${c.slug}`, scope: 'profile', nameHint: c.name, kind: 'items' });
    expect(ex.values).toMatchObject({ fld_fullName: c.name, fld_website: c.site, fld_industry: c.industry, fld_size: c.size, fld_location: c.location, fld_email: c.email, fld_phone: c.phone.replace(/ /g, '') });
    expect(ex.values.fld_about).toMatch(/supplies biotechnology/); expect(ex.values.fld_position).toBeUndefined();
    expect(Object.fromEntries(ex.pairs)).toMatchObject({ Industry: c.industry, Revenue: c.revenue, Website: c.site.replace('https://', '') });
    expect(labelledPairs(dom('<p>Hello</p>', BASE))).toEqual([]);
  });

  it('intake maps scraped values to the fields of the CHOSEN base and fills extra fields from labelled pairs; a re-scrape merges, never duplicates', async () => {
    const t = await S.createBase('Suppliers', 'companies'); const rev = await S.addField(t.id, { name: 'Revenue', type: 'text' });
    const fields = await S.listFields(t.id); const index = buildDedupeIndex([], await S.getDedupeRules(t.id)); const c = COMPANIES[0];
    const first = await S.intakePerson(t.id, fields, person({ fld_fullName: c.name, fld_website: c.site, fld_industry: c.industry, fld_email: c.email.toUpperCase() }, { pairs: [['Revenue', c.revenue], ['Size', c.size], ['Unknown label', 'ignored'], ['Web', 'https://other.example']] }), index);
    expect(first.action).toBe('created');
    const cells = first.record!.cells; expect(cells[idOf(fields, 'fullName')!]).toBe(c.name); expect(cells[idOf(fields, 'website')!]).toBe(c.site); expect(cells[idOf(fields, 'email')!]).toBe(c.email);
    expect(cells[rev.id]).toBe(c.revenue); expect(cells[idOf(fields, 'size')!]).toBe(c.size); expect(cells[idOf(fields, 'scrapingStatus')!]).toBe('Scraped'); expect(cells[idOf(fields, 'outreachStatus')!]).toBe('Not Contacted');
    expect(Object.keys(cells).filter(k => k.startsWith('fld_') && k !== rev.id)).toEqual([]);                                // nothing written under another base’s ids
    const again = await S.intakePerson(t.id, fields, person({ fld_fullName: 'Northwind Instruments BV', fld_website: c.site, fld_phone: c.phone }), index);
    expect(again.action).toBe('merged'); expect(again.record!.id).toBe(first.record!.id); expect(again.record!.cells[idOf(fields, 'phone')!]).toBe(c.phone); expect(again.record!.cells[idOf(fields, 'fullName')!]).toBe(c.name);
    expect((await S.listRecords(t.id)).length).toBe(1);
    expect((await S.intakePerson(t.id, fields, person({}), index)).action).toBe('skipped');
    await S.deleteTable(t.id);
  });

  it('crawling a whole company listing page saves every company (list → detail pages → base)', async () => {
    const t = await S.createBase('Crawl test', 'companies'); const fields = await S.listFields(t.id); const index = buildDedupeIndex([], await S.getDedupeRules(t.id)); const actions: string[] = []; const emitted: ScrapedPerson[] = [];
    const io: PageIO = { fetchDoc: async url => { const h = companyPage(new URL(url).pathname.replace('/company/', '')); return h ? dom(h, url) : null; }, renderProfile: async () => null,
      emit: async pp => { emitted.push(pp); const r = await S.intakePerson(t.id, fields, pp, index); actions.push(r.action); return r.action; }, shouldStop: async () => false, progress: () => {}, sleep: async () => {} };
    const c0 = exampleScrapeConfigs()[1]; const cfg = { ...c0, pagination: { ...c0.pagination, delayMinMs: 0, delayMaxMs: 0 } };
    const res = await crawlPage(dom(companiesList(), `${BASE}/companies`), cfg, { seen: [], pageIndex: 1, recordsLeft: 100, pagesLeft: 5 }, io);
    expect(emitted.map(e => e.values.fld_fullName)).toEqual(COMPANIES.map((c: any) => c.name)); expect(res.found).toBe(6); expect(actions.filter(a => a === 'created')).toHaveLength(6);
    expect((await S.listRecords(t.id)).length).toBe(6); expect(emitted.map(e => e.status + ':' + (e.error || ''))).toEqual(emitted.map(() => 'ok:'));
    await S.deleteTable(t.id);
  });

  it('the same scraped person can go to Researchers or to Contacts – each base gets its own copy under its own field ids', async () => {
    const p = person({ fld_fullName: 'Ada Lovelace', fld_email: 'ada@example-university.example', fld_position: 'Professor', fld_institution: 'Example University' });
    for (const id of [TABLE_ID, CONTACTS_ID]) { const fields = await S.listFields(id); const r = await S.intakePerson(id, fields, p, buildDedupeIndex(await S.listRecords(id), await S.getDedupeRules(id))); expect(r.action).toBe('created'); expect(r.record!.cells[idOf(fields, 'institution')!]).toBe('Example University'); expect(r.record!.cells[idOf(fields, 'firstName')!]).toBe('Ada'); }
    const c = (await S.listRecords(CONTACTS_ID))[0]; expect(Object.keys(c.cells).every(k => k.startsWith(`${CONTACTS_ID}__`))).toBe(true);
  });
});

describe('regressions found on a real university site (fictional data, same markup)', () => {
  // The page's own scripts put classes like "cookie-compliance-active" on <body>; that used to hide every link ("0 people detected").
  const card = (i: number, name: string) => `<div class="card"><div class="people-card"><a href="https://portal.example/en/persons/p${i}" class="field-group-link" target="_blank"><div class="card-body"><div class="field"><h2>${name} </h2></div><div class="speaker-org">Research Fellow, School of Examples</div></div></a></div></div>`;
  const list = `<body class="page-node-1 cookie-compliance-active path-node"><main><div class="view-content">${['Dr Katherine Fiction', 'AsPr Christopher Imagined', 'Prof Danielle Notreal', 'Dr Stuart Madeup'].map((n, i) => card(i + 1, n)).join('')}</div></main><nav class="pager"><a href="?page=0">1</a><a href="?page=2">3</a></nav></body>`;

  it('a class such as “cookie…” on <body> or <main> does not hide the page; real banners, headers and footers still do', () => {
    const d = dom(list, 'https://school.example/people?page=1'); expect(detectPeople(d, { baseUrl: 'https://school.example/people?page=1' }).map(c => c.name)).toEqual(['Dr Katherine Fiction', 'AsPr Christopher Imagined', 'Prof Danielle Notreal', 'Dr Stuart Madeup']);
    const inBanner = dom(`<body>${list.replace(/<body[^>]*>|<\/body>/g, '')}<div class="cookie-banner"><a href="/x/a">Jane Banner</a><a href="/x/b">John Banner</a><a href="/x/c">Mary Banner</a></div><footer><a href="/y/a">Jane Footer</a><a href="/y/b">John Footer</a><a href="/y/c">Mary Footer</a></footer></body>`, 'https://school.example/people');
    expect(detectPeople(inBanner, { baseUrl: 'https://school.example/people' }).map(c => c.name).filter(n => /Banner|Footer/.test(n))).toEqual([]);
  });

  it('an e-mail hidden as base64 in a data-* attribute of a href="#" link is decoded (the visible text is only “name” + script-made @ and dots)', () => {
    const enc = Buffer.from('mailto:Kate.Fiction@school.example').toString('base64');
    expect(decodeBase64Mail(enc)).toBe('Kate.Fiction@school.example'); expect(decodeBase64Mail('bm90IGEgbWFpbCBhZGRyZXNzIGF0IGFsbA==')).toBe(''); expect(decodeBase64Mail('short')).toBe('');
    const html = `<body><h1>Dr Kate Fiction</h1><ul><li class="emails"><span class="term">Email</span><span class="description"><a data-md5="${enc}" href="#" class="email">Kate.Fiction<span class="email-ta"></span><script>encryptedA();</script>school.example</a></span></li></ul></body>`;
    expect(findEmails(dom(html, 'https://portal.example/p/1').body)).toEqual(['kate.fiction@school.example']);
    const ex = extractPerson(dom(html, 'https://portal.example/p/1'), exampleScrapeConfigs()[0], { url: 'https://portal.example/p/1', scope: 'profile', nameHint: 'Dr Kate Fiction', kind: 'people' });
    expect(ex.values.fld_email).toBe('kate.fiction@school.example');
  });
});

describe('pagination on a page with several lists (real-site report)', () => {
  const pager = '<nav class="pager"><ul class="pager__items"><li class="pager__item pager__item--next"><a href="?page=2" title="Go to next page"><span>Next</span></a></li></ul></nav>';
  const cfgPg = exampleScrapeConfigs()[0].pagination;
  it('a “Next” selector that the picker pointed at the <span> inside the link still gives the link’s address (and button click target)', () => {
    const d = dom('<body><main><p>x</p></main>' + pager + '</body>', 'https://school.example/people?page=1');
    const sel = 'nav.pager > ul.pager__items > li.pager__item.pager__item--next > a > span';
    expect(findNextUrl(d, 'https://school.example/people?page=1', { ...cfgPg, mode: 'next', nextSelector: sel }, 2)).toBe('https://school.example/people?page=2');
    expect(findNextButton(d, { nextSelector: sel })?.tagName).toBe('A');
  });
  it('three lists on one page (long, long, short) are all read – the short last page of a list is not dropped', () => {
    const li = (prefix: string, names: string[]) => '<ul>' + names.map((n, i) => '<li><a href="/' + prefix + '/' + n.toLowerCase().replace(/ /g, '-') + i + '">' + n + '</a></li>').join('') + '</ul>';
    const A = ['Alice Alpha', 'Bob Bravo', 'Carol Charlie', 'Dan Delta', 'Eve Echo', 'Frank Foxtrot', 'Grace Golf', 'Hank Hotel', 'Iris India', 'Jack Juliet'], B = ['Kate Kilo', 'Liam Lima', 'Mona Mike', 'Nick November', 'Olga Oscar', 'Paul Papa', 'Quinn Quebec', 'Rita Romeo', 'Sam Sierra', 'Tina Tango'], C = ['Uma Uniform', 'Vic Victor', 'Walt Whiskey'];
    const d = dom('<body><main><h2>Academics</h2>' + li('academics', A) + '<h2>Students</h2>' + li('students', B) + '<h2>Visitors</h2>' + li('visitors', C) + '</main></body>', 'https://school.example/people?page=4');
    expect(detectPeople(d, { baseUrl: 'https://school.example/people?page=4', listContext: true }).length).toBe(23);
  });
});

describe('upgrading an existing installation', () => {
  it('“Research Contacts” becomes “Researchers” with every record, id and view intact, plus Contacts and Companies', async () => {
    // simulate the previous version: one table named Research Contacts, fields without keys, no schemaVersion
    await DB.wipeAll();
    const { buildFields, buildViews, DB_ID, WORKSPACE_ID } = await import('../../src/core/defaults');
    await DB.put('workspaces', { id: WORKSPACE_ID, name: 'VierApparatus' }); await DB.put('databases', { id: DB_ID, workspaceId: WORKSPACE_ID, name: 'Research Contacts', order: 0 });
    await DB.put('tables', { id: TABLE_ID, databaseId: DB_ID, name: 'Research Contacts', order: 0 });
    await DB.putMany('fields', buildFields(TABLE_ID, 'researchers').map(({ key, ...f }) => { void key; return f; })); await DB.putMany('views', buildViews(TABLE_ID, 'researchers'));
    const rec = await S.createRecord(TABLE_ID, { fld_fullName: 'Old Record', fld_email: 'old@example.test' }, { silent: true });
    const custom = await S.addField(TABLE_ID, { name: 'My field', type: 'text' });
    await S.ensureSeeded();
    expect((await S.listTables()).map(t => t.name)).toEqual(['Researchers', 'Contacts', 'Companies']);
    expect((await S.getRecord(rec.id))!.cells.fld_email).toBe('old@example.test'); expect((await S.listViews(TABLE_ID)).length).toBe(11);
    const fields = await S.listFields(TABLE_ID); expect(fields.find(f => f.id === 'fld_email')!.key).toBe('email'); expect(fields.find(f => f.id === custom.id)!.key).toBeUndefined();
    expect((await S.getTable(TABLE_ID))!.autoResearch).toBe(true); expect((await S.listDatabases())[0].name).toBe('VierApparatus');
    expect((await DB.all('templates')).length).toBe(2); expect((await DB.all<{ id: string }>('configs')).map(c => c.id).sort()).toEqual(['cfg_company_listing', 'cfg_google_maps', 'cfg_university_directory']);
    await S.ensureSeeded(); expect((await S.listTables()).length).toBe(3);                                  // running it again changes nothing
  });
});

describe('automatic research', () => {
  const rec = (cells: Record<string, string>, meta: any = {}) => ({ id: `r${Math.random()}`, tableId: TABLE_ID, cells, createdAt: new Date().toISOString(), updatedAt: '', meta }) as any;
  let fields: Field[];
  beforeAll(async () => { await DB.wipeAll(); await S.ensureSeeded(); fields = await S.listFields(TABLE_ID); });
  const name = 'fld_fullName', pub = 'fld_latestPublication', NOW = Date.parse('2026-11-04T10:00:00Z');

  it('picks exactly the records that have a name and no latest publication', () => {
    const yes = rec({ [name]: 'Anna Example' }), noName = rec({ [pub]: '' }), has = rec({ [name]: 'Bram Fixture', [pub]: 'A paper' }), pending = rec({ [name]: 'Wei Zhang' }, { pending: { [pub]: { candidates: [], at: '' } } }), short = rec({ [name]: 'Al' });
    expect(findCandidates(fields, [yes, noName, has, pending, short], NOW)).toEqual([yes]);
    expect(findCandidates(fields.filter(f => f.lookup?.kind !== 'search'), [yes], NOW)).toEqual([]);          // a base without research fields: nothing to do
  });

  it('does not hammer: not found → 7 days, request error → 1 hour, ambiguous → until the user chooses; newest first; at most 5', () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    const a = rec({ [name]: 'A Person' }, { autoTried: { at: at(RETRY_NONE_MS - 1000), outcome: 'none' } }), b = rec({ [name]: 'B Person' }, { autoTried: { at: at(RETRY_NONE_MS + 1000), outcome: 'none' } });
    const c = rec({ [name]: 'C Person' }, { autoTried: { at: at(RETRY_ERROR_MS - 1000), outcome: 'error' } }), d = rec({ [name]: 'D Person' }, { autoTried: { at: at(RETRY_ERROR_MS + 1000), outcome: 'error' } });
    const e = rec({ [name]: 'E Person' }, { autoTried: { at: at(99 * RETRY_NONE_MS), outcome: 'needsMatch' } });
    expect(findCandidates(fields, [a, b, c, d, e], NOW)).toEqual([b, d].sort((x, y) => y.createdAt.localeCompare(x.createdAt)));
    const many = Array.from({ length: 12 }, (_, i) => ({ ...rec({ [name]: `Person Number${i}` }), createdAt: new Date(NOW + i * 1000).toISOString() }));
    const got = findCandidates(fields, many, NOW); expect(got).toHaveLength(5); expect(got[0].cells[name]).toBe('Person Number11');
  });

  // a scripted OpenAlex: Ada Lovelace is known, anybody else is not
  const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  const work = (title: string) => ({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1234/latest', display_name: title, publication_year: 2026, publication_date: '2026-03-10', type: 'article', primary_location: { landing_page_url: 'https://journal.test/a', source: { display_name: 'Journal' } }, authorships: [{ author: { display_name: 'Ada Lovelace' } }], open_access: { is_oa: false } });
  const ctx = (calls: string[]): Ctx => ({ fetch: async (url: string) => { calls.push(url); if (/openalex\.org\/authors/.test(url)) return json({ results: /Ada/.test(decodeURIComponent(url)) ? [{ id: 'https://openalex.org/A1', display_name: 'Ada Lovelace', works_count: 30, last_known_institutions: [{ display_name: 'Example University' }], topics: [] }] : [] }); if (/openalex\.org\/works/.test(url)) return json({ results: [work('Notes on engines')] }); if (/crossref/.test(url)) return json({ message: { items: [] } }); if (/semanticscholar/.test(url)) return json({ data: [] }); if (/eutils|pubmed/.test(url)) return json({ esearchresult: { idlist: [] } }); return new Response('{}', { status: 404 }); }, settings: { ...DEFAULT_SETTINGS, lookupDelayMs: 0, unpaywallEmail: 'a@b.test' }, secrets: {}, sleep: async () => {}, now: () => new Date(NOW) });

  it('researches a base without any click: found → fields filled and no PDF downloaded; unknown → marked, not retried; records with a publication untouched', async () => {
    const ada = await S.createRecord(TABLE_ID, { [name]: 'Ada Lovelace', fld_institution: 'Example University' }, { silent: true });
    const nobody = await S.createRecord(TABLE_ID, { [name]: 'Nobody Known' }, { silent: true });
    const done = await S.createRecord(TABLE_ID, { [name]: 'Has Paper', [pub]: 'Already here' }, { silent: true });
    const calls: string[] = []; const table = (await S.getTable(TABLE_ID))!;
    const r = await autoResearchTable(table, ctx(calls), 5, NOW); expect(r.done.map(x => x.outcome).sort()).toEqual(['found', 'none']); expect(r.more).toBe(false);
    const a = (await S.getRecord(ada.id))!; expect(a.cells[pub]).toBe('Notes on engines'); expect(a.cells.fld_publicationDoi).toBe('10.1234/latest'); expect(a.meta!.autoTried!.outcome).toBe('found');
    expect(a.cells.fld_publicationFile).toBeUndefined(); expect(calls.some(u => /unpaywall|\.pdf/.test(u))).toBe(false);
    const n = (await S.getRecord(nobody.id))!; expect(n.cells[pub]).toBeUndefined(); expect(n.meta!.autoTried!.outcome).toBe('none');
    expect((await S.getRecord(done.id))!.cells[pub]).toBe('Already here');
    const calls2: string[] = []; const r2 = await autoResearchTable(table, ctx(calls2), 5, NOW + 3600000); expect(r2.done).toEqual([]); expect(calls2).toEqual([]);   // nobody is retried within 7 days
    expect((await autoResearchTable(table, ctx([]), 5, NOW + RETRY_NONE_MS + 1000)).done.map(x => x.outcome)).toEqual(['none']);
  });

  it('records the user is looking at are researched first, and only when the base has automatic research switched on', async () => {
    const t = await S.createBase('Leads', 'contacts'); await S.addResearchFields(t.id);
    const f = await S.listFields(t.id); const nm = idOf(f, 'fullName')!; const ada = await S.createRecord(t.id, { [nm]: 'Ada Lovelace', [idOf(f, 'institution')!]: 'Example University' }, { silent: true });
    await S.setAutoResearch(t.id, false); expect(await autoResearchRecords((await S.getTable(t.id))!, ctx([]), [ada.id])).toEqual([]);
    await S.setAutoResearch(t.id, true); const out = await autoResearchRecords((await S.getTable(t.id))!, ctx([]), [ada.id, 'does-not-exist']);
    expect(out.map(x => x.outcome)).toEqual(['found']); expect((await S.getRecord(ada.id))!.cells[idOf(f, 'latestPublication')!]).toBe('Notes on engines');
    await S.deleteTable(t.id);
  });
});
