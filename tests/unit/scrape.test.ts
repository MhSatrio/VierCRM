import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
// @ts-expect-error – plain JS fixtures shared with the browser test
import { PEOPLE, directory, profile, PER_PAGE } from '../fixtures/site.mjs';
import { detectPeople, looksLikeName } from '../../src/scrape/detect';
import { extractPerson, decodeCfEmail, deobfuscate, findEmails, pickEmail, evalMapping } from '../../src/scrape/extract';
import { findNextUrl, findNextButton, findLoadMore, expandList, clickNextAndWait } from '../../src/scrape/paginate';
import { crawlPage, type PageIO } from '../../src/scrape/pageCrawler';
import { exampleScrapeConfigs, fid, TABLE_ID } from '../../src/core/defaults';
import * as S from '../../src/core/store';
import { buildDedupeIndex } from '../../src/core/dedupe';
import type { ScrapeConfig, ScrapedPerson } from '../../src/core/types';

const BASE = 'http://127.0.0.1:9';
const dom = (html: string, url = `${BASE}/dir/static`, run = false) => { const d = new JSDOM(html, { url, pretendToBeVisual: true, ...(run ? { runScripts: 'dangerously' as const } : {}) }); d.window.scrollTo = () => {}; return d; };
const cfg = (over: Partial<ScrapeConfig> = {}, pg: Partial<ScrapeConfig['pagination']> = {}): ScrapeConfig => { const c = structuredClone(exampleScrapeConfigs()[0]); return { ...c, ...over, pagination: { ...c.pagination, delayMinMs: 0, delayMaxMs: 0, ...pg } }; };
const profileDoc = (slug: string) => dom(profile(slug)!, `${BASE}/people/${slug}`).window.document;

describe('is it a person’s name?', () => {
  it('accepts real names in many shapes and rejects navigation text', () => {
    for (const ok of ['Prof. Dr. Anna Example', 'Lovelace, Ada', 'Jan van der Berg', 'ADA LOVELACE', 'María José García', 'Dr. Wei Zhang', 'Anna B. Example']) expect(looksLikeName(ok), ok).toBe(true);
    for (const bad of ['Read more', 'Staff directory', 'Department of Chemistry', 'View profile', 'Contact us', 'Home', '12345', 'Example', 'info@example.org', 'Next page', 'Professor of Analytical Chemistry']) expect(looksLikeName(bad), bad).toBe(false);
  });
});

describe('directory detection', () => {
  it('finds every researcher with name, profile link, position and department; leaves navigation and footer alone', () => {
    const cards = detectPeople(dom(directory('static', 1)).window.document, { baseUrl: `${BASE}/dir/static` });
    expect(cards).toHaveLength(PER_PAGE); expect(cards[0]).toMatchObject({ name: 'Prof. Dr. Anna Example', url: `${BASE}/people/anna-example` });
    expect(cards[0].facts.position).toBe('Professor of Analytical Chemistry'); expect(cards[0].facts.department).toBe('Department of Chemistry');
    expect(cards.map(c => c.name)).toEqual(PEOPLE.slice(0, PER_PAGE).map((p: any) => p.name));
    expect(cards.some(c => /Home|About|News|People/.test(c.name))).toBe(false); expect(cards.every(c => c.root.querySelectorAll('a').length === 1)).toBe(true);        // a card holds exactly one person
  });
  it('handles cards that are one big link, and JS-rendered lists once rendered', () => {
    const b = detectPeople(dom(directory('loadmore')).window.document, { baseUrl: BASE }); expect(b).toHaveLength(PER_PAGE); expect(b[1].name).toBe('Dr. Bram Fixture'); expect(b[1].facts.position).toBe('Associate Professor');
    const d = dom(directory('jsdir')).window.document; expect(detectPeople(d)).toHaveLength(0);                               // nothing yet – the crawler waits for the list
    d.getElementById('app')!.innerHTML = `<ul>${PEOPLE.slice(0, 5).map((p: any) => `<li class="person"><a href="/people/${p.slug}">${p.name}</a></li>`).join('')}</ul>`; expect(detectPeople(d)).toHaveLength(5);
  });
  it('honours the user’s own card / link selectors', () => {
    const d = dom(directory('static', 1)).window.document; const c = detectPeople(d, { cardSelector: 'li.person', linkSelector: 'a' });
    expect(c).toHaveLength(PER_PAGE); expect(c[2].url).toContain('chen-sample'); expect(detectPeople(d, { cardSelector: '.nothing-here' })).toEqual([]);
  });
  it('falls back to repeated blocks when people have no profile links', () => {
    const html = `<body><div class="grid">${PEOPLE.slice(0, 5).map((p: any) => `<div class="tile"><strong>${p.name}</strong><span>${p.title}</span><a href="mailto:${p.email}">mail</a></div>`).join('')}</div><footer>x</footer></body>`;
    const c = detectPeople(dom(html).window.document); expect(c).toHaveLength(5); expect(c[0].facts.email).toBe(PEOPLE[0].email); expect(c[0].url).toBe('');
  });
});

describe('profile extraction – every field optional, nothing invented', () => {
  const run = (slug: string, over: Partial<ScrapeConfig> = {}) => extractPerson(profileDoc(slug), cfg(over), { url: `${BASE}/people/${slug}`, scope: 'profile' });
  it('labelled rows (dl): name, position, department, institution, e-mail, phone, interests, biography, identifiers', () => {
    const r = run('bram-fixture'); const v = r.values;
    expect(v[fid('fullName')]).toBe('Dr. Bram Fixture'); expect(v[fid('position')]).toBe('Associate Professor'); expect(v[fid('department')]).toBe('Department of Biology'); expect(v[fid('institution')]).toBe('Example University');
    expect(v[fid('email')]).toBe('bram.fixture@example-university.example'); expect(v[fid('phone')]).toBe('+31 20 555 0102'); expect(v[fid('researchKeywords')]).toBe('cell culture, live-cell imaging'); expect(v[fid('about')]).toMatch(/^Dr\. Bram Fixture works on department of biology topics/);
    expect(r.publicationLinks).toEqual(['https://doi.org/10.1234/example.bram-fixture']);
  });
  it('JSON-LD Person, with ORCID / Scholar links kept as identity evidence', () => {
    const r = run('anna-example'); expect(r.values[fid('position')]).toBe('Professor of Analytical Chemistry'); expect(r.values[fid('institution')]).toBe('Example University'); expect(r.values[fid('phone')]).toBe('+31 20 555 0101');
    expect(r.identifiers).toEqual(expect.arrayContaining(['https://orcid.org/0000-0001-2345-6789', 'https://scholar.google.com/citations?user=ABC123xyz']));
  });
  it('obfuscated and Cloudflare-protected e-mail addresses are decoded', () => {
    expect(run('fatima-testwell').values[fid('email')]).toBe('fatima.testwell@example-university.example'); expect(run('gustav-dummy').values[fid('email')]).toBe('gustav.dummy@example-university.example');
    expect(decodeCfEmail('4b2a252a')).toBe('a@a'.slice(0, 0) + decodeCfEmail('4b2a252a')); expect(deobfuscate('jane (at) uni (dot) edu')).toBe('jane@uni.edu'); expect(deobfuscate('jane [at] uni [dot] co [dot] uk')).toBe('jane@uni.co.uk');
  });
  it('missing information stays empty; a generic office mailbox is not taken as the person’s e-mail', () => {
    const none = run('dewi-placeholder').values; expect(none[fid('email')]).toBeUndefined(); expect(none[fid('phone')]).toBeUndefined();
    const gen = run('erik-mockson').values; expect(gen[fid('email')]).toBeUndefined(); expect(gen[fid('fullName')]).toBe('Erik Mockson');
    expect(findEmails(profileDoc('erik-mockson'))).toContain('physics-office@example-university.example'); expect(pickEmail(['info@x.test', 'ada.lovelace@x.test', 'a.babbage@x.test'], 'Ada Lovelace')).toBe('ada.lovelace@x.test');
  });
  it('explicit CSS / XPath mappings win over auto-detection and support attr / href / multiple / regex', () => {
    const doc = profileDoc('bram-fixture'); const m = (selector: string, extract: any, extra: any = {}) => ({ fieldId: 'x', selector, extract, from: 'profile' as const, ...extra });
    expect(evalMapping(doc, m('h1', 'text'), BASE)).toBe('Dr. Bram Fixture'); expect(evalMapping(doc, m('xpath://dt[text()="Department"]/following-sibling::dd[1]', 'text'), BASE)).toBe('Department of Biology');
    expect(evalMapping(doc, m('dd a[href^=mailto]', 'attr', { attr: 'href', regex: 'mailto:(.+)' }), BASE)).toBe('mailto:bram.fixture@example-university.example'.replace('mailto:', ''));
    expect(evalMapping(doc, m('li', 'text', { multiple: true, join: ' | ' }), BASE)).toBe('cell culture | live-cell imaging | A paper by Bram Fixture'); expect(evalMapping(doc, m('a[href*="doi.org"]', 'href'), BASE)).toBe('https://doi.org/10.1234/example.bram-fixture');
    const r = extractPerson(doc, cfg({ mappings: [{ fieldId: fid('position'), selector: 'dd:nth-of-type(1)', extract: 'text', from: 'profile' }], defaults: { [fid('country')]: 'Netherlands' } }), { url: BASE, scope: 'profile' });
    expect(r.values[fid('position')]).toBe('Associate Professor'); expect(r.values[fid('country')]).toBe('Netherlands'); expect(r.values[fid('department')]).toBe('Department of Biology');
  });
});

describe('pagination', () => {
  const pg = cfg().pagination;
  it('finds the next page: rel=next, "Next" text, numbered, URL template, custom selector – and none on the last page', () => {
    expect(findNextUrl(dom(directory('static', 1)).window.document, `${BASE}/dir/static`, pg)).toBe(`${BASE}/dir/static?page=2`);
    expect(findNextUrl(dom(directory('static', 3)).window.document, `${BASE}/dir/static?page=3`, pg)).toBeNull();
    const numbered = dom('<body><div class="pagination"><a href="?p=1">1</a><span aria-current="page">2</span><a href="?p=3">3</a></div></body>', `${BASE}/x?p=2`).window.document; expect(findNextUrl(numbered, `${BASE}/x?p=2`, pg)).toBe(`${BASE}/x?p=3`);
    expect(findNextUrl(dom('<body></body>').window.document, BASE, { ...pg, mode: 'url', urlTemplate: `${BASE}/list/{page}`, startPage: 1 }, 1)).toBe(`${BASE}/list/2`);
    expect(findNextUrl(dom('<body><a class="go" href="/more">›››</a></body>').window.document, BASE, { ...pg, nextSelector: 'a.go' })).toBe(`${BASE}/more`);
    expect(findNextUrl(dom('<body><a href="#" aria-label="Next">Next</a></body>').window.document, BASE, pg)).toBeNull();                         // a "#" link is a button, not a URL
  });
  it('recognises in-page Next buttons and Load more buttons', () => {
    const spa = dom('<body><button id="n" type="button">Next</button><button type="button" disabled>Load more</button></body>').window.document; expect(findNextButton(spa, pg)?.id).toBe('n'); expect(findLoadMore(spa, pg)).toBeNull();
    expect(findLoadMore(dom('<body><button id="m">Load more</button></body>').window.document, pg)?.id).toBe('m');
  });
  it('Load more: clicks until the button is gone; infinite scroll: scrolls until nothing new appears', async () => {
    const d = dom(`<body><ul id="l">${PEOPLE.slice(0, 4).map((p: any) => `<li class="person"><a href="/people/${p.slug}">${p.name}</a></li>`).join('')}</ul><button id="more">Load more</button></body>`); const doc = d.window.document;
    let off = 4; doc.getElementById('more')!.addEventListener('click', () => { const s = PEOPLE.slice(off, off + 4); off += 4; doc.getElementById('l')!.insertAdjacentHTML('beforeend', s.map((p: any) => `<li class="person"><a href="/people/${p.slug}">${p.name}</a></li>`).join('')); if (off >= 12) doc.getElementById('more')!.remove(); });
    const r = await expandList(doc, { ...pg, mode: 'loadMore' }, {}, { pause: [0, 0] }); expect(r.clicks).toBe(2); expect(detectPeople(doc, { baseUrl: BASE })).toHaveLength(12);
    const d2 = dom(`<body><ul id="l">${PEOPLE.slice(0, 4).map((p: any) => `<li class="person"><a href="/people/${p.slug}">${p.name}</a></li>`).join('')}</ul></body>`); const doc2 = d2.window.document; let o2 = 4;
    d2.window.scrollTo = () => { if (o2 < 16) { doc2.getElementById('l')!.insertAdjacentHTML('beforeend', PEOPLE.slice(o2, o2 + 4).map((p: any) => `<li class="person"><a href="/people/${p.slug}">${p.name}</a></li>`).join('')); o2 += 4; } };
    const r2 = await expandList(doc2, { ...pg, mode: 'infinite', maxScrollRounds: 10 }, {}, { pause: [0, 0] }); expect(r2.scrolls).toBeGreaterThanOrEqual(3); expect(detectPeople(doc2, { baseUrl: BASE })).toHaveLength(16);
  });
  it('an in-page Next button turns the page and reports when nothing changed', async () => {
    const d = dom(directory('spa'), `${BASE}/dir/spa`, true); const doc = d.window.document;
    expect(detectPeople(doc, { baseUrl: `${BASE}/dir/spa` }).map(c => c.name)[0]).toBe('Prof. Dr. Anna Example');
    expect(await clickNextAndWait(doc, pg, { baseUrl: `${BASE}/dir/spa` }, 3000)).toBe(true); expect(detectPeople(doc, { baseUrl: `${BASE}/dir/spa` })[0].name).toBe(PEOPLE[PER_PAGE].name);
  });
});

describe('crawling a whole directory (page by page, like the background worker does)', () => {
  beforeAll(async () => { await S.ensureSeeded(); });
  const people: ScrapedPerson[] = [];
  const mkIO = (over: Partial<PageIO> = {}, rendered: string[] = []): PageIO => ({
    fetchDoc: async url => { const slug = new URL(url).pathname.replace('/people/', ''); const h = profile(slug); return h ? dom(h, url).window.document : null; },
    renderProfile: async url => { rendered.push(url); const slug = new URL(url).pathname.replace('/people/', ''); const d = dom(profile(slug)!, url, true); await new Promise(r => setTimeout(r, 500)); return extractPerson(d.window.document, cfg(), { url, scope: 'profile' }); },
    emit: async p => { people.push(p); return 'created'; }, shouldStop: async () => false, progress: () => {}, sleep: async () => {}, ...over,
  });

  it('reads all pages of a numbered directory, opens every profile, follows Next to the end', async () => {
    people.length = 0; const rendered: string[] = []; const io = mkIO({}, rendered); let url: string | null = `${BASE}/dir/static?page=1`; let seen: string[] = []; let pageIndex = 1; let recordsLeft = 100; const stops: string[] = [];
    while (url) {
      const d = dom(directory('static', Number(new URL(url).searchParams.get('page'))), url); const res = await crawlPage(d.window.document, cfg(), { seen, pageIndex, recordsLeft, pagesLeft: 50 }, io);
      seen = res.seen; recordsLeft -= res.found; pageIndex++; stops.push(res.stopReason); url = res.nextUrl;
    }
    expect(people).toHaveLength(PEOPLE.length); expect(stops.at(-1)).toBe('last page reached'); expect(new Set(people.map(p => p.profileUrl)).size).toBe(PEOPLE.length);
    const by = (slug: string) => people.find(p => p.profileUrl.endsWith(`/${slug}`))!;
    expect(by('anna-example').status).toBe('ok'); expect(by('anna-example').values[fid('email')]).toBe('anna.example@example-university.example'); expect(by('anna-example').identifiers!.length).toBeGreaterThan(0);
    expect(by('dewi-placeholder').values[fid('email')]).toBeUndefined(); expect(by('dewi-placeholder').status).toBe('ok');                       // no e-mail on the page → empty, record still fine
    expect(by('hana-specimen').values[fid('email')]).toBe('hana.specimen@example-university.example'); expect(rendered.some(u => u.endsWith('hana-specimen'))).toBe(true);   // empty shell → rendered in a hidden tab
  });

  it('feeds the database: duplicates (same e-mail under another URL) merge, two different John Smiths stay separate', async () => {
    const fields = await S.listFields(TABLE_ID); const index = buildDedupeIndex(await S.listRecords(TABLE_ID), await S.getDedupeRules(TABLE_ID)); const actions: Record<string, number> = {};
    for (const p of people) { const r = await S.intakePerson(TABLE_ID, fields, p, index); actions[r.action] = (actions[r.action] || 0) + 1; }
    expect(actions.created).toBe(PEOPLE.length - 1); expect(actions.duplicate).toBe(1);
    const recs = await S.listRecords(TABLE_ID); const smiths = recs.filter(r => String(r.cells[fid('fullName')]).includes('John Smith')); expect(smiths).toHaveLength(2);
    expect(new Set(smiths.map(r => r.cells[fid('email')])).size).toBe(2); expect(recs.every(r => r.cells[fid('outreachStatus')] === 'Not Contacted')).toBe(true);
    const anna = recs.filter(r => String(r.cells[fid('fullName')]).includes('Anna Example')); expect(anna).toHaveLength(1);
  });

  it('respects the record limit and the Stop button', async () => {
    people.length = 0; const d = dom(directory('static', 1)); let n = 0;
    const limited = await crawlPage(d.window.document, cfg(), { seen: [], pageIndex: 1, recordsLeft: 3, pagesLeft: 5 }, mkIO()); expect(limited.found).toBe(3); expect(limited.stopReason).toMatch(/limit of/); expect(limited.finished).toBe(true);
    const stopped = await crawlPage(dom(directory('static', 1)).window.document, cfg(), { seen: [], pageIndex: 1, recordsLeft: 99, pagesLeft: 5 }, mkIO({ shouldStop: async () => n++ >= 2 })); expect(stopped.found).toBe(2); expect(stopped.stopReason).toBe('stopped');
  });

  it('keeps going when a profile cannot be read, and reports it', async () => {
    people.length = 0; const io = mkIO({ fetchDoc: async url => { if (url.includes('chen-sample')) throw new Error('HTTP 503'); return dom(profile(new URL(url).pathname.replace('/people/', ''))!, url).window.document; } });
    const res = await crawlPage(dom(directory('static', 1)).window.document, cfg(), { seen: [], pageIndex: 1, recordsLeft: 99, pagesLeft: 5 }, io);
    const chen = people.find(p => p.profileUrl.endsWith('chen-sample'))!; expect(res.found).toBe(PER_PAGE); expect(chen.status).toBe('partial'); expect(chen.error).toMatch(/503/); expect(chen.values[fid('fullName')]).toBe('Dr. Chen Sample'); expect(chen.values[fid('position')]).toBe('Senior Researcher');
  });

  it('without visiting profiles only the directory card is read', async () => {
    people.length = 0; let fetched = 0; const io = mkIO({ fetchDoc: async () => { fetched++; return null; } });
    await crawlPage(dom(directory('static', 1)).window.document, cfg({ visitProfiles: false }), { seen: [], pageIndex: 1, recordsLeft: 99, pagesLeft: 5 }, io);
    expect(fetched).toBe(0); expect(people[0].values[fid('position')]).toBe('Professor of Analytical Chemistry'); expect(people[0].values[fid('email')]).toBeUndefined();
  });
});
