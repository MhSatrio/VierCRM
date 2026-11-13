// Crawling ONE directory page: reveal the list, find the researchers, open each profile, extract, hand each person to the caller.
// Navigation to the NEXT page is done by the background worker (a page turn destroys this script) – exactly how the job scraper works:
// the worker injects the script, asks it to read the current page, then navigates and repeats.
//
// Profiles are read WITHOUT leaving the directory: fetched in the background (same site) or rendered in a hidden tab when the page
// only exists after JavaScript has run – so "return to the directory" is satisfied by construction and the list never loses its place.
import type { ScrapeConfig, ScrapedPerson } from '../core/types';
import { fid } from '../core/defaults';
import { normUrl, rand, sleep, text } from './dom';
import { detectPeople, type PersonCard } from './detect';
import { extractPerson, type Extracted } from './extract';
import { clickNextAndWait, expandList, findNext, findNextButton, findNextUrl, resolveMode } from './paginate';
import { waitFor } from './dom';

export interface PageIO {
  /** same-origin HTML → Document (null when unreachable) */
  fetchDoc(url: string): Promise<Document | null>;
  /** profile that only exists after JavaScript ran (hidden tab) → extracted values, or null */
  renderProfile(url: string): Promise<Extracted | null>;
  /** save one person; returns what the database did with it */
  emit(p: ScrapedPerson): Promise<'created' | 'merged' | 'duplicate' | 'skipped'>;
  /** true when the user pressed Stop; pauses internally while paused */
  shouldStop(): Promise<boolean>;
  progress(p: { phase: string; found?: number; saved?: number; skipped?: number; error?: string; url?: string }): void;
  sleep?: (ms: number) => Promise<void>;
}

export interface PageState { seen: string[]; pageIndex: number; recordsLeft: number; pagesLeft: number }
export interface PageResult { found: number; saved: number; merged: number; duplicates: number; skipped: number; errors: string[]; nextUrl: string | null; finished: boolean; stopReason: string; seen: string[]; cardsOnPage: number; newOnPage: number; /** how the next page was found (or why not) */ nextHow?: string }

const sameOrigin = (a: string, b: string) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
/** A fetched page that has (almost) no text yet is a JavaScript shell – unless it already shows real content (a heading, a definition list, a table, a mailto link), as short static pages do. */
const emptyShell = (d: Document) => { const n = text(d.body).length; return n < 60 || (n < 250 && !d.querySelector('h1, h2, dl, table, a[href^="mailto:" i], a[href^="tel:" i]')); };

export async function crawlPage(doc: Document, cfg: ScrapeConfig, state: PageState, io: PageIO): Promise<PageResult> {
  const nap = io.sleep || sleep;
  const base = doc.location?.href || 'https://example.invalid/';
  const seen = new Set(state.seen);
  const res: PageResult = { found: 0, saved: 0, merged: 0, duplicates: 0, skipped: 0, errors: [], nextUrl: null, finished: false, stopReason: '', seen: [], cardsOnPage: 0, newOnPage: 0 };
  const detect = { cardSelector: cfg.list.auto ? undefined : cfg.list.cardSelector, linkSelector: cfg.list.auto ? undefined : cfg.list.linkSelector, listContext: state.pageIndex > 1, baseUrl: base, kind: cfg.list.kind };
  const pg = cfg.pagination; let left = state.recordsLeft; let pagesLeft = state.pagesLeft;

  const process = async (): Promise<boolean> => {
    io.progress({ phase: 'finding people' });
    await waitFor(() => detectPeople(doc, detect).length > 0, { timeout: 6000, interval: 300 });          // lists drawn by JavaScript appear a moment after the page loads
    const exp = await expandList(doc, { ...pg, mode: resolveMode(doc, base, pg, state.pageIndex) }, detect, { control: () => io.shouldStop() }); void exp;
    const cards = detectPeople(doc, detect); res.cardsOnPage += cards.length;
    const fresh = cards.filter(c => !seen.has(c.url ? normUrl(c.url) : `${c.name}|${c.facts.email || ''}`));
    res.newOnPage += fresh.length;
    for (const card of fresh) {
      if (await io.shouldStop()) { res.stopReason = 'stopped'; return false; }
      if (left <= 0) { res.stopReason = `reached the limit of ${pg.maxRecords} records`; return false; }
      const key = card.url ? normUrl(card.url) : `${card.name}|${card.facts.email || ''}`; seen.add(key); res.found++; left--;
      io.progress({ phase: `reading ${card.name || card.url}`, found: res.found, url: card.url });
      try {
        const person = await readCard(card, cfg, base, io);
        const action = await io.emit(person);
        if (action === 'created') res.saved++; else if (action === 'merged') res.merged++; else if (action === 'duplicate') res.duplicates++; else res.skipped++;
        io.progress({ phase: 'saved', found: res.found, saved: res.saved, skipped: res.skipped + res.duplicates });
      } catch (e: any) { res.errors.push(`${card.name || card.url}: ${e?.message || e}`); res.skipped++; io.progress({ phase: 'error', error: String(e?.message || e) }); }
      await nap(rand(pg.delayMinMs, pg.delayMaxMs));
    }
    return true;
  };

  let more = await process();
  // single-page apps: "Next" is a button, the document stays – keep turning pages in place
  while (more && (pg.mode === 'auto' || pg.mode === 'next' || pg.mode === 'numbered') && pagesLeft > 1 && !findNextUrl(doc, base, pg, state.pageIndex) && findNextButton(doc, pg)) {
    if (!(await clickNextAndWait(doc, pg, detect))) break;
    pagesLeft--; state.pageIndex++; res.stopReason = '';
    const before = res.newOnPage; more = await process();
    if (res.newOnPage === before && !more) break; if (res.newOnPage === before) break;
  }
  res.seen = [...seen];
  if (!res.stopReason && more) {
    if (pg.mode === 'infinite' || pg.mode === 'loadMore' || pg.mode === 'none') { res.nextUrl = null; res.finished = true; res.stopReason = pg.mode === 'none' ? 'single page (as configured)' : 'end of the list reached'; }
    else {
      const nx = findNext(doc, base, pg, state.pageIndex, res.cardsOnPage); res.nextHow = nx.how;
      res.nextUrl = nx.url && normUrl(nx.url) !== normUrl(base) ? nx.url : null;
      // say WHY there is no next page: the real last page, or a pager VierCRM could not follow (so the user knows to configure it)
      if (!res.nextUrl) { res.finished = true; res.stopReason = /^last page/.test(nx.how) ? 'last page reached' : nx.pagerSeen ? `a pager is on the page but no next page could be followed (${nx.evidence.join('; ')}) – set “How does the list continue?” in Pagination` : `no pager found on this page (${nx.evidence.join('; ')}) – last page, or set the pagination by hand`; }
    }
  } else res.finished = true;
  return res;
}

/** One card (+ its profile page) → a person ready for the database. */
export async function readCard(card: PersonCard, cfg: ScrapeConfig, base: string, io: PageIO): Promise<ScrapedPerson> {
  const profileUrl = card.url;
  const items = cfg.list.kind === 'items';
  const fromCard = extractPerson(card.root, cfg, { url: base, scope: 'card', nameHint: card.name, kind: cfg.list.kind });
  const v: Record<string, string> = { ...fromCard.values };
  const put = (k: string, val?: string) => { if (val && val.trim() && !v[k]) v[k] = val.trim(); };
  if (cfg.autoDetect.name) put(fid('fullName'), card.name);
  if (cfg.autoDetect.position && !items) put(fid('position'), card.facts.position);
  if (cfg.autoDetect.institution && !items) put(fid('department'), card.facts.department);
  if (cfg.autoDetect.email) put(fid('email'), card.facts.email?.toLowerCase());
  if (cfg.autoDetect.phone) put(fid('phone'), card.facts.phone);
  let pub: string[] = []; let ids: string[] = []; let error: string | undefined; let pairs = fromCard.pairs;

  if (cfg.visitProfiles && profileUrl) {
    let ex: Extracted | null = null;
    try {
      if (sameOrigin(profileUrl, base)) {
        const d = await io.fetchDoc(profileUrl);
        if (d && !emptyShell(d)) ex = extractPerson(d, cfg, { url: profileUrl, scope: 'profile', nameHint: card.name, kind: cfg.list.kind });
        else if (cfg.renderJsProfiles) ex = await io.renderProfile(profileUrl);
      } else if (cfg.renderJsProfiles) ex = await io.renderProfile(profileUrl);
    } catch (e: any) { error = `profile not readable: ${e?.message || e}`; }
    if (ex) {
      // the profile is richer than the card; the card keeps what the profile did not say
      for (const [k, val] of Object.entries(ex.values)) if (val) v[k] = val;
      pub = ex.publicationLinks; ids = ex.identifiers; pairs = [...ex.pairs, ...pairs];
    } else if (!error) error = 'profile page was empty or not reachable – kept what the directory shows';
  }
  if (profileUrl) v[fid('profileUrl')] = v[fid('profileUrl')] || profileUrl;
  const has = (k: string) => !!v[fid(k)];
  const rich = items ? has('email') || has('phone') || has('website') || has('about') || has('industry') : has('email') || has('position') || has('institution') || has('about');
  const status: ScrapedPerson['status'] = !has('fullName') ? 'failed' : (error || !rich) ? 'partial' : 'ok';
  return { sourceUrl: base, profileUrl, values: v, fieldsFound: Object.keys(v), status, error, publicationLinks: pub, identifiers: ids, pairs: pairs.slice(0, 60) };
}
