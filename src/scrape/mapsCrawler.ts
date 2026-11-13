// Crawling a Google Maps search from the open tab: wait for the result list, scroll it to its end, read every place, open the place's own page
// when the card is missing something, look for an e-mail on the business's website, and hand each place to the database as a record.
//
// A Maps search is ONE long list (it scrolls instead of paging), so one call reads the whole search; the background worker only moves on to
// the next search when the configuration lists more of them.
import type { ScrapedPerson, ScrapeConfig } from '../core/types';
import { rand, sleep, waitFor } from './dom';
import { DEFAULT_MAPS, findFeed, isPlacePage, loadFeed, mapsSearchUrl, placeValues, readCards, readPlace, searchQueryOf, type MapsPlace } from './maps';
import type { PageIO, PageResult, PageState } from './pageCrawler';
import type { SiteContacts } from './siteContacts';
import type { Extracted } from './extract';

export interface MapsIO extends PageIO { /** contacts found on a business's own website (the background worker fetches it) */ site(url: string): Promise<SiteContacts | null> }

/** A place opened in its own tab → what the detail page says, in the same form as any other profile read. */
export function placeAsExtracted(doc: Document, url: string): Extracted | null {
  const p = readPlace(doc, url); if (!p) return null;
  const values = placeValues(p);
  return { values, found: Object.keys(values), publicationLinks: [], identifiers: [], pairs: [] };
}

/** The place, its website's contact details and the search that found it → one record. */
export function buildPerson(card: MapsPlace, detail: Extracted | null, site: SiteContacts | null, source: string, query: string): ScrapedPerson {
  const v: Record<string, string> = { ...placeValues(card) };
  if (detail) for (const [k, val] of Object.entries(detail.values)) if (val) v[k] = val;                // the place's own page is richer than its card
  const social: string[] = [];
  const pairs: [string, string][] = [];
  if (site) {
    if (site.best) v.fld_email = site.best;
    if (!v.fld_phone && (site.phones[0] || site.whatsapp[0])) v.fld_phone = site.phones[0] || site.whatsapp[0];
    for (const w of site.whatsapp) social.push(`WhatsApp: ${w}`);
    for (const s of site.socials) social.push(`${s.network}: ${s.url}`);
    if (social.length) v.fld_socials = social.join('\n');
    if (site.emails.length > 1) pairs.push(['Other e-mails', site.emails.slice(1, 6).join(', ')]);
  }
  if (query) v.fld_searchQuery = query;
  const num = (k: string, label: string) => { if (v[k]) pairs.push([label, v[k]]); };
  num('fld_rating', 'Rating'); num('fld_reviews', 'Reviews'); num('fld_hours', 'Opening hours'); num('fld_plusCode', 'Plus code'); num('fld_socials', 'Social links'); num('fld_profileUrl', 'Google Maps link');
  const status: ScrapedPerson['status'] = !v.fld_fullName ? 'failed' : (v.fld_phone || v.fld_email || v.fld_website) ? 'ok' : 'partial';
  return { sourceUrl: source, profileUrl: card.href, values: v, fieldsFound: Object.keys(v), status, pairs, publicationLinks: [], identifiers: [] };
}

export async function crawlMaps(doc: Document, cfg: ScrapeConfig, state: PageState, io: MapsIO): Promise<PageResult> {
  const nap = io.sleep || sleep; const opts = { ...DEFAULT_MAPS, ...(cfg.maps || {}) }; const pg = cfg.pagination;
  const base = doc.location?.href || ''; const query = searchQueryOf(base); const source = query ? mapsSearchUrl(query, doc.location?.origin && doc.location.origin !== 'null' ? doc.location.origin : undefined) : base;
  const seen = new Set(state.seen); let left = state.recordsLeft;
  const res: PageResult = { found: 0, saved: 0, merged: 0, duplicates: 0, skipped: 0, errors: [], nextUrl: null, finished: true, stopReason: '', seen: [], cardsOnPage: 0, newOnPage: 0 };

  io.progress({ phase: 'waiting for the Google Maps results' });
  await waitFor(() => (findFeed(doc)?.querySelector('a[href*="/maps/place/"]') || isPlacePage(doc)) && true, { timeout: 15000, interval: 400 });
  const feed = findFeed(doc); let places: MapsPlace[] = []; let opened: MapsPlace | null = null;
  if (feed) {
    const r = await loadFeed(doc, { max: Math.max(1, Math.min(left, pg.maxRecords)), rounds: Math.max(1, pg.maxScrollRounds), shouldStop: () => io.shouldStop(), onProgress: n => io.progress({ phase: `scrolling the list – ${n} places so far` }), pace: [Math.min(pg.delayMinMs, 600), Math.min(Math.max(pg.delayMaxMs, 700), 1200)] });
    places = readCards(doc);
    res.stopReason = r.reason === 'stopped' ? 'stopped' : r.reason === 'limit' ? `reached the limit of ${pg.maxRecords} records` : r.reason === 'rounds' ? `scrolled ${pg.maxScrollRounds} times – more places may be below (raise “Max scroll rounds”)` : 'end of the list reached';
    if (r.reason === 'stopped') return finish();
  } else if (isPlacePage(doc)) { opened = readPlace(doc, base); if (opened) places = [opened]; res.stopReason = 'one place'; }
  if (!places.length) {
    res.errors.push('Google Maps shows no result list here. Open a search such as “freight forwarder Surabaya” on Google Maps, wait until the places are listed, and start again. (A consent page, a sign-in or a CAPTCHA also stops the read – VierCRM never tries to get past one.)');
    res.stopReason = 'no Maps results found'; return finish();
  }
  res.cardsOnPage = places.length;
  const fresh = places.filter(p => !seen.has(p.key)); res.newOnPage = fresh.length;

  for (const card of fresh) {
    if (await io.shouldStop()) { res.stopReason = 'stopped'; break; }
    if (left <= 0) { res.stopReason = `reached the limit of ${pg.maxRecords} records`; break; }
    seen.add(card.key); res.found++; left--;
    io.progress({ phase: `reading ${card.name}`, found: res.found });
    try {
      let touched = false;
      const needDetail = !opened && (opts.details === 'always' || (opts.details === 'missing' && (!card.phone || !card.address)));
      let detail: Extracted | null = opened ? placeAsExtracted(doc, base) : null;
      if (needDetail) { io.progress({ phase: `opening ${card.name}` }); detail = await io.renderProfile(card.href); touched = true; }
      const website = detail?.values.fld_website || card.website;
      let site: SiteContacts | null = null;
      if (opts.websiteEmails && website) { io.progress({ phase: `looking for contact details on ${hostOf(website)}` }); site = await io.site(website); touched = true; }
      const person = buildPerson(card, detail, site, source, query);
      const action = await io.emit(person);
      if (action === 'created') res.saved++; else if (action === 'merged') res.merged++; else if (action === 'duplicate') res.duplicates++; else res.skipped++;
      io.progress({ phase: 'saved', found: res.found, saved: res.saved, skipped: res.skipped + res.duplicates });
      await nap(touched ? rand(pg.delayMinMs, pg.delayMaxMs) : rand(40, 160));
    } catch (e: any) { res.errors.push(`${card.name}: ${e?.message || e}`); res.skipped++; io.progress({ phase: 'error', error: String(e?.message || e) }); }
  }
  return finish();

  function finish(): PageResult { res.seen = [...seen]; return res; }
}
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
