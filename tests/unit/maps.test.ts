import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
// @ts-expect-error – plain JS fixtures shared with the browser test
import { MAPS_PLACES, feedCard, mapsPlacePage, mapsSearchPage, bizHome, placeHref } from '../fixtures/maps.mjs';
import * as S from '../../src/core/store';
import { buildDedupeIndex } from '../../src/core/dedupe';
import { exampleScrapeConfigs, TEMPLATES, fidFor } from '../../src/core/defaults';
import { canonicalLink, cleanWebsite, isMapsUrl, isMapsPage, isPlacePage, findFeed, mapsSearchUrl, parseRating, placeKey, readCards, readPlace, searchQueryOf } from '../../src/scrape/maps';
import { parseSiteHtml, rankEmails, siteContacts } from '../../src/scrape/siteContacts';
import { buildPerson, crawlMaps, placeAsExtracted, type MapsIO } from '../../src/scrape/mapsCrawler';
import type { ScrapedPerson } from '../../src/core/types';

const O = 'https://www.google.com'; const SITE = 'https://sites.example';
const SEARCH = `${O}/maps/search/freight+forwarder+surabaya/@-7.25,112.75,12z`;
const dom = (html: string, url: string) => new JSDOM(html, { url, pretendToBeVisual: true }).window.document;
const list = () => dom(mapsSearchPage({ origin: O, siteOrigin: SITE, query: 'freight forwarder surabaya', batch: 99, endNow: true }), SEARCH);
const byName = (n: string) => MAPS_PLACES.find((p: any) => p.name === n);

describe('Google Maps addresses', () => {
  it('knows a Maps page from any other Google page, in any country domain', () => {
    for (const u of [SEARCH, `${O}/maps/place/Foo/data=!4m7`, 'https://www.google.co.id/maps/search/kos', 'https://maps.google.com/maps?q=kos', `${O}/maps`]) expect(isMapsUrl(u), u).toBe(true);
    for (const u of [`${O}/search?q=maps`, 'https://www.google.com/', 'https://example.com/maps/search/x', 'https://notgoogle.com/maps', 'not a url']) expect(isMapsUrl(u), u).toBe(false);
  });
  it('reads the search words, and builds a search address', () => {
    expect(searchQueryOf(SEARCH)).toBe('freight forwarder surabaya'); expect(searchQueryOf(`${O}/maps?q=kos%20putri`)).toBe('kos putri'); expect(searchQueryOf(`${O}/maps/place/Foo`)).toBe('');
    expect(mapsSearchUrl(' kos putri malang ')).toBe(`${O}/maps/search/kos+putri+malang`);
  });
  it('the same place gives the same key and link wherever the map was and however the entry was clicked', () => {
    const a = `${O}/maps/place/Foo+Bar/@-7.2,112.7,17z/data=!4m7!3m6!1s0x2dd7f1:0xabc123!8m2!3d-7.2!4d112.7?authuser=0&hl=en&rclk=1`; const b = `${O}/maps/place/Foo+Bar/@-6.9,107.6,15z/data=!4m7!3m6!1s0x2dd7f1:0xabc123!8m2!3d-7.2!4d112.7`;
    expect(placeKey(a)).toBe('0x2dd7f1:0xabc123'); expect(placeKey(a)).toBe(placeKey(b)); expect(canonicalLink(a)).toBe(canonicalLink(b)); expect(canonicalLink(a)).not.toMatch(/[?@]/);
    expect(placeKey(`${O}/maps/place/Foo+Bar/@-7.2,112.7,17z`)).toBe('foo bar@-7.2,112.7'); expect(placeKey(`${O}/maps/place/Foo/data=x?cid=123`)).toBe('cid:123');
  });
  it('a business website: Google’s redirect is unwrapped, tracking removed, Google’s own pages refused', () => {
    expect(cleanWebsite('https://www.google.com/url?q=https%3A%2F%2Facme.example%2F%3Futm_source%3Dgoogle%26x%3D1&opi=89978449')).toBe('https://acme.example?x=1');
    expect(cleanWebsite('https://acme.example/?utm_source=gmb&gclid=1')).toBe('https://acme.example');
    expect(cleanWebsite('https://acme.example/about/')).toBe('https://acme.example/about');
    for (const bad of ['https://www.google.com/maps/dir//x', 'https://maps.app.goo.gl/abc', '', undefined, 'javascript:void(0)', 'https://www.google.com/url?foo=1']) expect(cleanWebsite(bad as any), String(bad)).toBe('');
  });
  it('rating labels in several languages and shapes', () => {
    expect(parseRating('4.6 stars 102 Reviews')).toEqual({ rating: 4.6, reviews: 102 });
    expect(parseRating('4,6 bintang 1.234 Ulasan')).toEqual({ rating: 4.6, reviews: 1234 });
    expect(parseRating('Rated 4.4 out of 5, 2,150 reviews')).toEqual({ rating: 4.4, reviews: 2150 });
    expect(parseRating('4.6 1.2K')).toEqual({ rating: 4.6, reviews: 1200 });
    expect(parseRating('5 stars')).toEqual({ rating: 5, reviews: undefined }); expect(parseRating('102 reviews')).toEqual({}); expect(parseRating('no rating')).toEqual({});
  });
});

describe('reading the result list', () => {
  it('finds the list and every place in it, once each', () => {
    const d = list(); expect(!!findFeed(d)).toBe(true); expect(isMapsPage(d)).toBe(true);
    const cards = readCards(d); expect(cards).toHaveLength(MAPS_PLACES.length); expect(new Set(cards.map(c => c.key)).size).toBe(MAPS_PLACES.length);
  });
  it('name, category, address, phone, website, rating and reviews of an ordinary card', () => {
    const c = readCards(list()).find(x => x.name === 'Samudra Cargo Express')!;
    expect(c).toMatchObject({ category: 'Freight forwarder', address: 'Jl. Perak Timur No.12, Surabaya', phone: '(031) 5551 0101', website: `${SITE}/biz/samudra-cargo`, rating: 4.6, reviews: 102, coordinates: '-7.2575, 112.7521' });
    expect(c.href).toMatch(/^https:\/\/www\.google\.com\/maps\/place\/Samudra\+Cargo\+Express\/data=/); expect(c.href).not.toMatch(/[?@]/);
  });
  it('every card of the fixture list gives exactly its own category and address – including whole-number ratings such as “4(10)”', () => {
    for (const c of readCards(list())) { const p = MAPS_PLACES.find((x: any) => x.name === c.name); expect(c.category, c.name).toBe(p.category); expect(c.address, c.name).toBe(p.address); expect(c.phone, c.name).toBe(p.cardNoPhone ? '' : p.phone); expect(c.rating, c.name).toBe(p.rating); expect(c.reviews, c.name).toBe(p.reviews); }
  });
  it('a rating shown only as digits (“4(10)”, “5.0(1.2K)”, no stars label) is a rating, not an address', () => {
    const card = (digits: string, label = '') => `<div role="feed"><div class="Nv2PK"><a class="hfpxzc" aria-label="Acme" href="${O}/maps/place/Acme/data=!1s0x1:0x2"></a><div class="y7PRA"><div class="fontHeadlineSmall">Acme</div>${label}<div><span aria-hidden="true">${digits}</span></div><div><span>Courier service</span><span> ⋅ <span>Jl. Merdeka 1</span></span></div></div></div></div>`;
    for (const [digits, rating, reviews] of [['4(10)', 4, 10], ['5.0(1.2K)', 5, 1200], ['3,5(1.234)', 3.5, 1234]] as const) { const c = readCards(dom(card(digits), SEARCH))[0]; expect(c, digits).toMatchObject({ category: 'Courier service', address: 'Jl. Merdeka 1', rating, reviews }); }
    expect(readCards(dom(card('4.5(7)', '<span role="img" aria-label="4.5 stars 7 Reviews"><span aria-hidden="true">4.5(7)</span></span>'), SEARCH))[0]).toMatchObject({ category: 'Courier service', address: 'Jl. Merdeka 1', rating: 4.5, reviews: 7 });
  });
  it('opening hours, “Closed”, “Opens 8 am” and prices never leak into category or address', () => {
    for (const c of readCards(list())) { expect(c.category).not.toMatch(/closed|opens|buka|tutup|^\d/i); expect(c.address).not.toMatch(/closed|opens|buka|tutup/i); expect(c.phone).not.toMatch(/am|pm/i); }
  });
  it('a card without a phone number and a card without a website', () => {
    const cs = readCards(list()); expect(cs.find(c => c.name === 'Bahari Express Cargo')).toMatchObject({ phone: '', address: 'Jl. Kenjeran 88, Surabaya' }); expect(cs.find(c => c.name === 'Trans Pasifik Forwarding')!.website).toBe('');
  });
  it('an Indonesian-language card (“bintang … Ulasan”, “Buka ⋅ Tutup pukul 22.00”)', () => {
    expect(readCards(list()).find(c => c.name === 'Kos Melati Putri')).toMatchObject({ category: 'Boarding house', address: 'Jl. Ketintang Baru III No.5, Surabaya', phone: '0857-1111-2222', rating: 4.5, reviews: 33 });
  });
  it('only links to places count: directions, ads and the “Results” heading are not entries', () => {
    const d = dom(`<div role="feed"><div><a href="https://www.google.com/aclk?x=1" aria-label="Ad">Ad</a></div>${feedCard(MAPS_PLACES[0], O, SITE)}<div><a href="https://www.google.com/maps/dir//x">Directions</a></div></div>`, SEARCH);
    expect(readCards(d).map(c => c.name)).toEqual(['Samudra Cargo Express']);
  });
  it('the entry’s own link and “Directions” are never mistaken for a website – also on a mirrored copy of Maps that is not on google.com', () => {
    const d = dom(`<div role="feed">${feedCard(byName('Trans Pasifik Forwarding'), 'http://127.0.0.1:5', SITE)}</div>`, 'http://127.0.0.1:5/maps/search/x');
    expect(readCards(d)).toHaveLength(1); expect(readCards(d)[0].website).toBe('');
  });
  it('a page without a list reads nothing (a consent page, a login)', () => {
    const d = dom('<h1>Before you continue to Google</h1><form><button>Accept all</button></form>', 'https://consent.google.com/m?continue=x'); expect(readCards(d)).toEqual([]); expect(isMapsPage(d)).toBe(false);
  });
});

describe('reading a place page', () => {
  const p = byName('Bahari Express Cargo'); const url = `${placeHref(O, p)}`;
  const d = () => dom(mapsPlacePage({ origin: O, siteOrigin: SITE, p }), url);
  it('is recognised as a place, not a list', () => { expect(isPlacePage(d())).toBe(true); expect(findFeed(d())).toBeNull(); expect(isPlacePage(list())).toBe(false); });
  it('address, phone (also from the row id), website, category, plus code, rating, reviews, coordinates', () => {
    expect(readPlace(d(), url)).toMatchObject({ name: 'Bahari Express Cargo', category: 'Cargo and freight company', address: 'Jl. Kenjeran 88, Surabaya', phone: '031-5559-0099', website: `${SITE}/biz/bahari-express`, plusCode: 'PRQ2+XJ Surabaya', rating: 4.8, reviews: 310, coordinates: '-7.2575, 112.7521' });
  });
  it('the weekly opening hours become one line per day', () => {
    const h = readPlace(d(), url)!.hours!.split('\n'); expect(h).toHaveLength(7); expect(h[0]).toBe('Monday: 8 am–5 pm'); expect(h[6]).toBe('Sunday: Closed');
  });
  it('as a hidden-tab read it gives the database keys, which the card values yield to', () => {
    const ex = placeAsExtracted(d(), url)!; expect(ex.values).toMatchObject({ fld_fullName: 'Bahari Express Cargo', fld_phone: '031-5559-0099', fld_location: 'Jl. Kenjeran 88, Surabaya', fld_industry: 'Cargo and freight company', fld_rating: '4.8' });
    const card = readCards(list()).find(c => c.name === 'Bahari Express Cargo')!; const person = buildPerson(card, ex, null, SEARCH, 'freight forwarder surabaya');
    expect(person.values.fld_phone).toBe('031-5559-0099'); expect(person.values.fld_searchQuery).toBe('freight forwarder surabaya'); expect(person.status).toBe('ok');
  });
});

describe('contact details from the business’s own website', () => {
  it('mailto links (with ?subject), plain text, role mailboxes ranked first, junk removed', () => {
    const r = parseSiteHtml(bizHome(byName('Samudra Cargo Express'), SITE), `${SITE}/biz/samudra-cargo`);
    expect(r.emails).toEqual(expect.arrayContaining(['info@samudra-cargo.example', 'sales@samudra-cargo.example'])); expect(rankEmails(r.emails, 'samudra-cargo.example').join()).not.toMatch(/wixpress|png/);
    expect(rankEmails([...r.emails, 'webmaster@gmail.com', 'logo@2x.png', 'user@example.com'], 'samudra-cargo.example')[0]).toMatch(/^(info|sales)@samudra-cargo\.example$/);
    expect(rankEmails(['logo@2x.png', 'x@sentry.io', 'name@domain.com'], 'a.example')).toEqual([]);
  });
  it('Cloudflare-protected and “name [at] domain [dot] com” addresses', () => {
    expect(parseSiteHtml(bizHome(byName('Citra Kargo Jakarta'), SITE), `${SITE}/biz/citra-kargo`).emails).toContain('office@citra-kargo.example');
    expect(parseSiteHtml(bizHome(byName('Nusantara Logistik'), SITE, 'kontak'), `${SITE}/biz/nusantara-logistik/kontak`).emails).toContain('sales@nusantara-logistik.example');
    expect(parseSiteHtml('<p>write to info&#64;acme&#46;example or sales&commat;acme.example</p>', 'https://acme.example').emails).toEqual(['info@acme.example', 'sales@acme.example']);
  });
  it('WhatsApp, phone and social links; share buttons are not company pages', () => {
    const r = parseSiteHtml(bizHome(byName('Mitra Lintas Samudra'), SITE), `${SITE}/biz/mitra-lintas`);
    expect(r.whatsapp).toEqual(['+6281234560000']); expect(r.emails).toEqual([]); expect(r.socials.map(s => s.network).sort()).toEqual(['Facebook', 'Instagram']);
    const sh = parseSiteHtml('<a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a><a href="https://twitter.com/intent/tweet?x">t</a><a href="tel:+62 31 555 0101">call</a><script type="application/ld+json">{"@type":"LocalBusiness","email":"hi@acme.example","telephone":"+62 31 555 0101","sameAs":["https://www.linkedin.com/company/acme"]}</script>', 'https://acme.example');
    expect(sh.socials).toEqual([{ network: 'LinkedIn', url: 'https://linkedin.com/company/acme' }]); expect(sh.emails).toEqual(['hi@acme.example']); expect(sh.phones[0]).toMatch(/555 0101/);
  });
  const pages: Record<string, string> = {};
  for (const p of MAPS_PLACES) if (p.site) { pages[`${SITE}/biz/${p.site}`] = bizHome(p, SITE); pages[`${SITE}/biz/${p.site}/kontak`] = bizHome(p, SITE, 'kontak'); }
  const calls: string[] = [];
  const fakeFetch = async (u: string) => { calls.push(u); const h = pages[u.replace(/\/$/, '')]; return h ? new Response(h, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('nope', { status: 404 }); };
  it('looks at the contact page only when the home page gives no address, and reads at most home + 2', async () => {
    calls.length = 0; const a = await siteContacts(`${SITE}/biz/samudra-cargo`, { fetch: fakeFetch as any, sleep: async () => {} }); expect(a.best).toMatch(/@samudra-cargo\.example$/); expect(calls).toHaveLength(1);
    calls.length = 0; const b = await siteContacts(`${SITE}/biz/nusantara-logistik`, { fetch: fakeFetch as any, sleep: async () => {} }); expect(b.best).toBe('sales@nusantara-logistik.example'); expect(calls).toEqual([`${SITE}/biz/nusantara-logistik`, `${SITE}/biz/nusantara-logistik/kontak`]);
    calls.length = 0; const c = await siteContacts(`${SITE}/biz/mitra-lintas`, { fetch: fakeFetch as any, sleep: async () => {} }); expect(c.best).toBe(''); expect(c.whatsapp).toEqual(['+6281234560000']); expect(calls.length).toBeLessThanOrEqual(3);
  });
  it('a dead website, a non-address and a Facebook page never throw – they just give nothing (and Facebook is not crawled)', async () => {
    calls.length = 0;
    expect((await siteContacts(`${SITE}/biz/gone`, { fetch: fakeFetch as any, sleep: async () => {} })).error).toBeTruthy();
    expect((await siteContacts('ftp://x', { fetch: fakeFetch as any })).error).toBeTruthy();
    expect((await siteContacts('https://web.facebook.com/acme.official', { fetch: (async () => { throw new Error('must not be called'); }) as any })).socials[0].network).toBe('Facebook');
    expect((await siteContacts('https://acme.example', { fetch: (async () => { throw new TypeError('network down'); }) as any, sleep: async () => {} })).emails).toEqual([]);
  });
});

describe('a whole search, from the list to the database', () => {
  beforeAll(async () => { await S.ensureSeeded(); });
  it('the Places template: contact fields first, branches of a chain are NOT merged, the same place is', async () => {
    expect(TEMPLATES.map(t => t.id)).toContain('places');
    const t = await S.createBase('Freight e2e', 'places'); const fields = await S.listFields(t.id); const names = fields.map(f => f.name);
    expect(names.slice(0, 7)).toEqual(['Name', 'Category', 'Address', 'Phone', 'Website', 'Email', 'Social Links']); expect(names).toEqual(expect.arrayContaining(['Rating', 'Reviews', 'Opening Hours', 'Google Maps link']));
    expect(fields.find(f => f.name === 'Phone')!.hidden).toBeFalsy(); expect(fields.find(f => f.key === 'rating')!.type).toBe('number');
    const rules = await S.getDedupeRules(t.id); expect(rules.filter(r => r.enabled).map(r => r.id)).toEqual(['dd-profile', 'dd-name-phone', 'dd-name-address']);

    const cfg = structuredClone(exampleScrapeConfigs().find(c => c.id === 'cfg_google_maps')!); cfg.pagination.delayMinMs = 0; cfg.pagination.delayMaxMs = 0;
    expect(cfg.maps).toEqual({ details: 'missing', websiteEmails: true, queries: [] });
    const index = buildDedupeIndex([], rules); const opened: string[] = []; const sitesAsked: string[] = []; const emitted: ScrapedPerson[] = []; const actions: string[] = [];
    const pages: Record<string, string> = {}; for (const p of MAPS_PLACES) if (p.site) { pages[`${SITE}/biz/${p.site}`] = bizHome(p, SITE); pages[`${SITE}/biz/${p.site}/kontak`] = bizHome(p, SITE, 'kontak'); }
    const fetchSite = async (u: string) => { const h = pages[u.replace(/\/$/, '')]; return h ? new Response(h, { headers: { 'content-type': 'text/html' } }) : new Response('', { status: 404 }); };
    const io: MapsIO = {
      fetchDoc: async () => null,
      renderProfile: async url => { opened.push(url); const p = MAPS_PLACES.find((x: any) => decodeURIComponent(url).replace(/\+/g, ' ').includes(x.name)); return p ? placeAsExtracted(dom(mapsPlacePage({ origin: O, siteOrigin: SITE, p }), url), url) : null; },
      site: async url => { sitesAsked.push(url); return siteContacts(url, { fetch: fetchSite as any, sleep: async () => {} }); },
      emit: async pp => { emitted.push(pp); const r = await S.intakePerson(t.id, fields, pp, index); actions.push(r.action); return r.action; },
      shouldStop: async () => false, progress: () => {}, sleep: async () => {},
    };
    const res = await crawlMaps(list(), cfg, { seen: [], pageIndex: 1, recordsLeft: 1000, pagesLeft: 1 }, io);
    expect(res.found).toBe(MAPS_PLACES.length); expect(res.saved).toBe(MAPS_PLACES.length); expect(res.errors).toEqual([]); expect(res.stopReason).toBe('end of the list reached'); expect(res.finished).toBe(true);
    expect(opened).toHaveLength(1); expect(opened[0]).toMatch(/Bahari/);                                   // only the card that lacked a phone number was opened
    expect(sitesAsked.every(u => u.startsWith(`${SITE}/biz/`))).toBe(true);

    const recs = await S.listRecords(t.id); const F = (k: string) => fields.find(f => f.key === k)!.id; const row = (n: string) => recs.find(r => r.cells[F('fullName')] === n)!.cells;
    expect(recs).toHaveLength(MAPS_PLACES.length);
    expect(row('Samudra Cargo Express')).toMatchObject({ [F('industry')]: 'Freight forwarder', [F('location')]: 'Jl. Perak Timur No.12, Surabaya', [F('phone')]: '(031) 5551 0101', [F('rating')]: '4.6', [F('searchQuery')]: 'freight forwarder surabaya', [F('scrapingStatus')]: 'Scraped', [F('outreachStatus')]: 'Not Contacted' });
    expect(String(row('Samudra Cargo Express')[F('email')])).toMatch(/^(info|sales)@samudra-cargo\.example$/); expect(String(row('Samudra Cargo Express')[F('socials')])).toMatch(/Instagram: https:\/\/instagram\.com\/samudra-cargo/);
    expect(row('Bahari Express Cargo')[F('phone')]).toBe('031-5559-0099'); expect(row('Bahari Express Cargo')[F('hours')]).toMatch(/^Monday: 8 am–5 pm/); expect(row('Bahari Express Cargo')[F('plusCode')]).toBe('PRQ2+XJ Surabaya');
    expect(row('Nusantara Logistik')[F('email')]).toBe('sales@nusantara-logistik.example'); expect(row('Citra Kargo Jakarta')[F('email')]).toBe('office@citra-kargo.example'); expect(row('Citra Kargo Surabaya')[F('email')]).toBe('office@citra-kargo.example');
    expect(row('Trans Pasifik Forwarding')[F('website')]).toBeFalsy(); expect(row('Mitra Lintas Samudra')[F('email')]).toBeFalsy(); expect(String(row('Mitra Lintas Samudra')[F('socials')])).toContain('WhatsApp: +6281234560000');
    expect(row('Kos Melati Putri')[F('industry')]).toBe('Boarding house');

    // the same search again: nothing new (same Maps link) – even though the tab is at another place on the map now
    const again = await crawlMaps(dom(mapsSearchPage({ origin: O, siteOrigin: SITE, query: 'freight forwarder surabaya', batch: 99, endNow: true }), `${O}/maps/search/freight+forwarder+surabaya/@-6.9,107.6,11z`), cfg, { seen: [], pageIndex: 1, recordsLeft: 1000, pagesLeft: 1 }, io);
    expect(again.saved).toBe(0); expect(again.duplicates).toBe(MAPS_PLACES.length); expect((await S.listRecords(t.id)).length).toBe(MAPS_PLACES.length);
    expect(fidFor(t.id, 'rating')).toBe(F('rating')); await S.deleteTable(t.id);
  });

  it('the limit of records, a stop request, and a page with no list say so instead of failing silently', async () => {
    const cfg = structuredClone(exampleScrapeConfigs().find(c => c.id === 'cfg_google_maps')!); cfg.pagination.delayMinMs = 0; cfg.pagination.delayMaxMs = 0; cfg.maps = { details: 'never', websiteEmails: false };
    const base: MapsIO = { fetchDoc: async () => null, renderProfile: async () => { throw new Error('must not open places'); }, site: async () => { throw new Error('must not visit websites'); }, emit: async () => 'created', shouldStop: async () => false, progress: () => {}, sleep: async () => {} };
    const limited = await crawlMaps(list(), cfg, { seen: [], pageIndex: 1, recordsLeft: 3, pagesLeft: 1 }, base); expect(limited.found).toBe(3); expect(limited.stopReason).toMatch(/limit/);
    let n = 0; const stopped = await crawlMaps(list(), cfg, { seen: [], pageIndex: 1, recordsLeft: 99, pagesLeft: 1 }, { ...base, shouldStop: async () => ++n > 4 }); expect(stopped.stopReason).toBe('stopped'); expect(stopped.found).toBeLessThan(MAPS_PLACES.length);
    const none = await crawlMaps(dom('<h1>Before you continue</h1>', 'https://consent.google.com/'), { ...cfg }, { seen: [], pageIndex: 1, recordsLeft: 99, pagesLeft: 1 }, base);
    expect(none.found).toBe(0); expect(none.errors[0]).toMatch(/no result list/i); expect(none.stopReason).toBe('no Maps results found');
    const seenOnes = await crawlMaps(list(), cfg, { seen: readCards(list()).map(c => c.key), pageIndex: 2, recordsLeft: 99, pagesLeft: 1 }, base); expect(seenOnes.found).toBe(0);
  });

  it('a single opened place (no list) is read as one record', async () => {
    const p = byName('Bahari Express Cargo'); const url = placeHref(O, p); const out: ScrapedPerson[] = [];
    const cfg = structuredClone(exampleScrapeConfigs().find(c => c.id === 'cfg_google_maps')!); cfg.pagination.delayMinMs = 0; cfg.pagination.delayMaxMs = 0; cfg.maps = { details: 'missing', websiteEmails: false };
    const r = await crawlMaps(dom(mapsPlacePage({ origin: O, siteOrigin: SITE, p }), url), cfg, { seen: [], pageIndex: 1, recordsLeft: 9, pagesLeft: 1 }, { fetchDoc: async () => null, renderProfile: async () => { throw new Error('already open'); }, site: async () => null, emit: async x => { out.push(x); return 'created'; }, shouldStop: async () => false, progress: () => {}, sleep: async () => {} });
    expect(r.found).toBe(1); expect(out[0].values).toMatchObject({ fld_fullName: 'Bahari Express Cargo', fld_phone: '031-5559-0099', fld_website: `${SITE}/biz/bahari-express` });
  });
});
