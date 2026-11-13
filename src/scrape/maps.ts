// Google Maps – reading a result list and a place page from the tab the user has open. No API and no key: it reads the very page the
// user is looking at, the way the other scrapers read a directory.
//
// Google's class names are obfuscated and change; what stays put is the structure – a scrolling `role="feed"` whose entries each hold a
// link to /maps/place/…, and on a place page `data-item-id` buttons (address, phone:tel:…, authority = website). The reader leans on those and
// on the text itself, never on a class name, and several signals back each other up (aria-label, visible text, link target).
import type { MapsConfig } from '../core/types';
import { clean, qsa, rand, sleep, waitFor } from './dom';

export const DEFAULT_MAPS: MapsConfig = { details: 'missing', websiteEmails: true, queries: [] };

export interface MapsPlace {
  /** stable identity of the place (Google's feature id when the link has one) */
  key: string;
  /** link to the place on Google Maps, without the search/viewport noise */
  href: string;
  name: string; category: string; address: string; phone: string; website: string;
  rating?: number; reviews?: number;
  hours?: string; plusCode?: string; coordinates?: string;
}

// ------------------------------------------------------------------ addresses of Maps pages
const GOOGLE_HOST = /^(?:www\.|maps\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/i;
/** A Google Maps page: google.<tld>/maps…  (also maps.google.<tld>). */
export function isMapsUrl(url: string): boolean {
  try { const u = new URL(url); return GOOGLE_HOST.test(u.hostname) && /^\/maps(\/|$)/.test(u.pathname); } catch { return false; }
}
/** Address of a Maps search. The origin is the one the user is on (google.co.id, google.de …), so the results keep their language and country. */
export const mapsSearchUrl = (q: string, origin = 'https://www.google.com') => `${origin}/maps/search/${encodeURIComponent(q.trim()).replace(/%20/g, '+')}`;
/** The search words of a Maps address: /maps/search/freight+forwarder/@…  or  ?q=… */
export function searchQueryOf(url: string): string {
  try { const u = new URL(url); const m = u.pathname.match(/^\/maps\/search\/([^/]+)/); if (m) return clean(decodeURIComponent(m[1].replace(/\+/g, ' '))); return clean(u.searchParams.get('q') || ''); } catch { return ''; }
}

/** The place's own identity: Google's feature id (0x…:0x…) or cid, else the name + coordinates in the link. */
export function placeKey(href: string): string {
  const id = href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i)?.[1] || href.match(/[?&]ftid=(0x[0-9a-f]+:0x[0-9a-f]+)/i)?.[1]; if (id) return id.toLowerCase();
  const cid = href.match(/[?&]cid=(\d+)/)?.[1]; if (cid) return `cid:${cid}`;
  const name = href.match(/\/maps\/place\/([^/?#]+)/)?.[1]; if (!name) return '';
  const xy = href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) || href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  return `${decodeSafe(name).toLowerCase()}${xy ? `@${xy[1]},${xy[2]}` : ''}`;
}
const decodeSafe = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
/** Link to the place without ?authuser=…&rclk=1 and without the map position (/@lat,lng,17z), so the same place always gives the same link. */
export function canonicalLink(href: string, base = 'https://www.google.com'): string {
  try { const u = new URL(href, base); u.search = ''; u.hash = ''; u.pathname = u.pathname.replace(/\/@[^/]*/, ''); return u.href; } catch { return href; }
}
const coordsOf = (href: string) => { const m = href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) || href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/); return m ? `${m[1]}, ${m[2]}` : ''; };

/** A business website as Maps links it: unwrap google.com/url?q=…, drop tracking parameters, refuse anything on Google itself. */
export function cleanWebsite(href: string | null | undefined): string {
  if (!href) return '';
  try {
    let u = new URL(href, 'https://www.google.com/');
    if (GOOGLE_HOST.test(u.hostname) && u.pathname === '/url') { const q = u.searchParams.get('q') || u.searchParams.get('url'); if (!q) return ''; u = new URL(q); }
    if (!/^https?:$/.test(u.protocol) || GOOGLE_HOST.test(u.hostname) || /(^|\.)(gstatic|googleusercontent|googleapis|goo\.gl|g\.page|maps\.app\.goo\.gl)\b/i.test(u.hostname)) return '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|ved$|y_source|opi$|cid$)/i.test(k)) u.searchParams.delete(k);
    u.hash = ''; return u.href.replace(/\/(?=$|\?)/, '');
  } catch { return ''; }
}

// ------------------------------------------------------------------ numbers
function parseCount(s: string): number | undefined {
  const m = s.trim().match(/^(\d+(?:[.,]\d+)*)\s*([kKmM])?$/); if (!m) return undefined;
  if (m[2]) { const n = parseFloat(m[1].replace(',', '.')); return Math.round(n * (/k/i.test(m[2]) ? 1e3 : 1e6)); }
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(m[1])) return parseInt(m[1].replace(/[.,]/g, ''), 10);
  return parseInt(m[1], 10);
}
/** "4.6 stars 102 Reviews" · "4,6 bintang 102 Ulasan" · "Rated 4.6 out of 5, 1,234 reviews" · "4.6(1.2K)" */
export function parseRating(label: string): { rating?: number; reviews?: number } {
  const s = label.replace(/\b(?:out of|dari|sur|von|de|di|van|of)\s*5\b|\/\s*5\b/gi, ' ');
  const nums = s.match(/\d+(?:[.,]\d+)*(?:\s?[kKmM]\b)?/g) || []; if (!nums.length) return {};
  const first = (nums[0] ?? '').replace(/\s/g, ''); const r = parseFloat(first.replace(',', '.'));
  if (!(r >= 1 && r <= 5) || /[kKmM]$/.test(first)) return {};
  const rest = nums[1]?.replace(/\s/g, ''); const reviews = rest ? parseCount(rest) : undefined;
  return { rating: r, reviews };
}
/** the text form shown in a card: "4.6(102)" */
const RATING_TEXT = /^(?:\(?\d(?:[.,]\d)?\)?\s*\(\s*\d+(?:[.,]\d+)*\s?[kKmM]?\s*\)|\d[.,]\d)$/;       // "4.6(102)" · "4(10)" · "5.0(1.2K)" · "4.6"

// ------------------------------------------------------------------ the result list
export function findFeed(doc: Document): Element | null {
  return qsa(doc, '[role="feed"]').find(f => !!f.querySelector('a[href*="/maps/place/"]')) ?? qsa(doc, '[role="feed"]')[0] ?? null;
}
const placeLinks = (feed: Element) => qsa<HTMLAnchorElement>(feed, 'a[href*="/maps/place/"]');
const hrefOf = (a: Element, doc: Document) => { const h = a.getAttribute('href') || ''; try { return new URL(h, doc.location?.href && doc.location.href !== 'about:blank' ? doc.location.href : 'https://www.google.com/').href; } catch { return h; } };

/** The entry that holds this place link: the largest ancestor that contains no OTHER place. */
function cardRoot(a: Element, feed: Element): Element {
  const own = placeKey(a.getAttribute('href') || ''); let el: Element = a;
  while (el.parentElement && el.parentElement !== feed) {
    const p = el.parentElement;
    if (placeLinks(p).some(x => placeKey(x.getAttribute('href') || '') !== own)) break;
    el = p;
  }
  return el;
}

/** Visible lines of an entry. Unlike a plain text read this keeps aria-hidden text (Maps draws the rating digits there) and cuts at block elements. */
function flatLines(el: Element): string[] {
  const out: string[] = []; let cur = '';
  const flush = () => { const t = clean(cur.replace(/[-]/g, '')); if (t) out.push(t); cur = ''; };
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|DD|DIV|DL|DT|FIGURE|FOOTER|H[1-6]|HEADER|LI|MAIN|NAV|OL|P|SECTION|TABLE|TD|TH|TR|UL|BR)$/;
  const walk = (n: Node) => {
    if (n.nodeType === 3) { cur += n.nodeValue; return; }
    if (n.nodeType !== 1) return;
    const e = n as Element; const tag = e.tagName.toUpperCase();
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IMG)$/.test(tag) || e.getAttribute('hidden') !== null) return;
    const block = BLOCK.test(tag); if (block) flush();
    for (const c of Array.from(e.childNodes)) walk(c);
    if (block) flush();
  };
  walk(el); flush(); return out;
}

const SEP = /\s*[⋅·•∙‧]\s*/;
const STATUS = /^(?:open|opens|opening|closed|closes|closing|temporarily|permanently|reopens|buka|dibuka|tutup|ditutup|ouvert|ferm[ée]|g[eé]ffnet|geschlossen|abierto|cerrado|aberto|fechado|aperto|chiuso|geopend|gesloten)\b/i;
const TIMEBIT = /^(?:\d{1,2}(?:[:.]\d{2})?\s?(?:am|pm|wib|wita|wit)?|\d{1,2}[:.]\d{2}\s?[–-]\s?\d{1,2}[:.]\d{2})$/i;
const PRICE = /^(?:[$€£¥₹]{1,4}|(?:[$€£¥₹]|rp\.?|idr|usd|eur)\s*[\d.,]+(?:\s*[–-]\s*[\d.,]+)?\s*(?:rb|jt|k|m|ribu|juta)?\+?)$/i;
const SPONSORED = /^(?:sponsored|iklan|ad|ads|anzeige|publicit[ée]|patrocinado|annuncio|advertentie)$/i;
const ADDRESS_HINT = /\d|,|\b(?:jl|jln|jalan|gg|gang|ruko|blok|kav|komplek|kompleks|street|road|avenue|lane|boulevard|plaza|tower|gedung|lantai|floor|building|rue|strasse|stra[ßs]e|calle|via|km)\b\.?/i;
export const isPhoneText = (s: string) => { const d = s.replace(/\D/g, ''); return /^\+?\(?\d[\d\s().-]{5,}\d$/.test(s) && d.length >= 7 && d.length <= 15 && !TIMEBIT.test(s) && !/^\d{4}$/.test(s); };

/** One entry of the list → a place. `a` is its link. */
export function parseCard(card: Element, a: Element, doc: Document): MapsPlace {
  const link = hrefOf(a, doc);
  const lines = flatLines(card);
  const name = clean(a.getAttribute('aria-label')) || clean(card.getAttribute('aria-label')) || clean(card.querySelector('[class*="fontHeadline"]')?.textContent) || lines[0] || '';
  let rating: number | undefined; let reviews: number | undefined;
  const ratingLines = new Set<string>();                                      // the rating element's own text ("4(10)") is never part of the category or address
  for (const img of qsa(card, '[role="img"][aria-label]')) { const r = parseRating(img.getAttribute('aria-label') || ''); if (r.rating) { rating = r.rating; reviews = r.reviews; ratingLines.add(clean(img.textContent)); break; } }
  const info: string[] = []; const headline = clean(card.querySelector('[class*="fontHeadline"]')?.textContent).toLowerCase(); const lname = name.toLowerCase();
  for (const l of lines) {
    if (l.toLowerCase() === lname || l.toLowerCase() === headline) continue;                 // the name again (the link's label and the heading can differ slightly)
    if (ratingLines.has(l)) continue;
    const rm = l.match(RATING_TEXT);
    if (rm) { if (rating === undefined) { const r = parseRating(l.replace(/[()]/g, ' ')); rating = r.rating; reviews = reviews ?? r.reviews; } continue; }
    if (/^["“‘«'].*["”’»']$/.test(l) || SPONSORED.test(l)) continue;                 // a review snippet, an "Ad" label
    info.push(l);
  }
  const parts: string[] = []; for (const l of info) for (const p of l.split(SEP)) { const t = clean(p); if (t) parts.push(t); }
  let phone = clean(card.querySelector('[class*="UsdlK"]')?.textContent); if (phone && !isPhoneText(phone)) phone = '';
  const rest: string[] = [];
  for (const p of parts) {
    if (isPhoneText(p)) { if (!phone) phone = p; continue; }
    if (STATUS.test(p) || TIMEBIT.test(p) || PRICE.test(p) || SPONSORED.test(p)) continue;
    rest.push(p);
  }
  const category = rest[0] && !ADDRESS_HINT.test(rest[0]) ? rest[0] : '';
  const address = rest.slice(category ? 1 : 0).filter(p => ADDRESS_HINT.test(p)).join(', ');
  // the website button: data-value="Website", else an aria-label that says so, else any link that leaves Google
  let website = '';
  const cand = [...qsa<HTMLAnchorElement>(card, 'a[data-value="Website" i], a[aria-label*="website" i], a[aria-label*="situs" i], a[aria-label*="site web" i], a[aria-label*="webseite" i], a[aria-label*="sitio web" i]'), ...qsa<HTMLAnchorElement>(card, 'a[href^="http"]')];
  for (const c of cand) { const h = c.getAttribute('href') || ''; if (c === a || /\/maps\/(?:place|dir|search|preview)\b|[?&]cid=/.test(h)) continue; website = cleanWebsite(h); if (website) break; }          // Maps' own links (the entry itself, Directions) are never a website
  return { key: placeKey(link), href: canonicalLink(link), name, category, address, phone, website, rating, reviews, coordinates: coordsOf(link) || undefined };
}

/** Every place currently loaded in the list, in order. */
export function readCards(doc: Document): MapsPlace[] {
  const feed = findFeed(doc); if (!feed) return [];
  const seen = new Set<string>(); const out: MapsPlace[] = [];
  for (const a of placeLinks(feed)) {
    const key = placeKey(a.getAttribute('href') || ''); if (!key || seen.has(key)) continue; seen.add(key);
    const p = parseCard(cardRoot(a, feed), a, doc); if (p.name) out.push(p);
  }
  return out;
}

const END = /(?:reached the end|end of (?:the )?list|akhir daftar|sampai di akhir|fin de la liste|ende der liste|llegado al final|fim da lista|fine dell.elenco|einde van de lijst)/i;
export const listEnded = (feed: Element) => { const k = feed.children; for (let i = Math.max(0, k.length - 3); i < k.length; i++) if (END.test(k[i].textContent || '')) return true; return false; };

/** The element that really scrolls (the feed itself in practice). */
function scroller(feed: Element): Element {
  const win = feed.ownerDocument.defaultView; let e: Element | null = feed;
  for (let i = 0; e && i < 6; i++, e = e.parentElement) if (e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(win?.getComputedStyle(e).overflowY || '')) return e;
  return feed;
}

/** Scroll the list down until it ends, stops growing, or the limits are reached. Maps loads about 20 more places per scroll. */
export async function loadFeed(doc: Document, o: { max: number; rounds: number; shouldStop(): Promise<boolean>; onProgress(n: number): void; pace?: [number, number] }): Promise<{ count: number; reason: 'end' | 'limit' | 'rounds' | 'no more' | 'stopped' }> {
  const feed = findFeed(doc); if (!feed) return { count: 0, reason: 'no more' };
  let count = readCards(doc).length; let idle = 0; const [lo, hi] = o.pace ?? [500, 1000];
  for (let round = 0; round < o.rounds; round++) {
    if (await o.shouldStop()) return { count, reason: 'stopped' };
    if (count >= o.max) return { count, reason: 'limit' };
    if (listEnded(feed)) return { count, reason: 'end' };
    const sc = scroller(feed); sc.scrollTop = sc.scrollHeight;
    await waitFor(() => placeLinks(feed).length > count || listEnded(feed), { timeout: 5500, interval: 250 });
    const now = readCards(doc).length;
    if (now > count) { count = now; idle = 0; o.onProgress(count); await sleep(rand(lo, hi)); }
    else if (listEnded(feed)) return { count, reason: 'end' };
    else if (++idle >= 2) return { count, reason: 'no more' };
  }
  return { count, reason: 'rounds' };
}

// ------------------------------------------------------------------ a place page
const NOT_A_NAME = /^(?:results?|hasil|resultaten|r[ée]sultats|ergebnisse|resultados|risultati)$/i;
const NOT_A_NAME_PREFIX = /^(?:results?\s+for|hasil\s+untuk|r[ée]sultats?\s+pour|ergebnisse\s+f[üu]r|resultados\s+para)\b/i;
export function placeName(doc: Document): string {
  for (const m of qsa(doc, '[role="main"][aria-label]')) { const t = clean(m.getAttribute('aria-label')); if (t && !NOT_A_NAME.test(t) && !NOT_A_NAME_PREFIX.test(t)) return t; }
  for (const h of qsa(doc, 'h1')) { const t = clean(h.textContent); if (t && !NOT_A_NAME.test(t)) return t; }
  return '';
}
/** An opened place (the panel with address / phone / website rows). */
export const isPlacePage = (doc: Document) => !!doc.querySelector('[data-item-id="address"], [data-item-id^="phone:tel:"], a[data-item-id="authority"], [data-item-id="oloc"]') && !!placeName(doc);
/** Either kind of Maps screen (by its address, or – for translated or mirrored copies – by its structure). */
export const isMapsPage = (doc: Document) => isMapsUrl(doc.location?.href || '') || !!findFeed(doc)?.querySelector('a[href*="/maps/place/"]') || isPlacePage(doc);

const itemText = (el: Element | null): string => {
  if (!el) return '';
  const t = clean((el.textContent || '').replace(/[-]/g, '')); if (t) return t;
  return clean(el.getAttribute('aria-label')).replace(/^[^:：]{1,40}[:：]\s*/, '');
};
const DAY = /^(?:mon|tue|wed|thu|fri|sat|sun|sen|sel|rab|kam|jum|sab|min|lun|mar|mer|jeu|ven|sam|dim|mo|di|mi|do|fr|sa|so)/i;
function hoursOf(doc: Document): string {
  for (const t of qsa(doc, 'table')) {
    const rows = qsa(t, 'tr').map(r => qsa(r, 'td, th').map(c => clean(c.textContent))).filter(c => c.length >= 2 && c[0] && DAY.test(c[0]) && c[0].length <= 14);
    if (rows.length >= 5) return rows.map(c => `${c[0]}: ${c.slice(1).join(' ').replace(/\s+/g, ' ')}`).join('\n');
  }
  return '';
}

/** Read the place that is open on this page; null when none is. */
export function readPlace(doc: Document, url: string): MapsPlace | null {
  const name = placeName(doc); if (!name) return null;
  const main = qsa(doc, '[role="main"]').find(m => (m.getAttribute('aria-label') || '') === name) || doc.body;
  const at = (sel: string) => main.querySelector(sel) || doc.querySelector(sel);
  const addr = itemText(at('[data-item-id="address"]'));
  const phoneEl = at('[data-item-id^="phone:tel:"]'); let phone = itemText(phoneEl); if (!phone || !isPhoneText(phone)) phone = (phoneEl?.getAttribute('data-item-id') || '').replace(/^phone:tel:/, '') || (isPhoneText(phone) ? phone : '');
  const web = at('a[data-item-id="authority"]'); const website = cleanWebsite(web?.getAttribute('href'));
  const category = itemText(at('button[jsaction*="category"], [jsaction*="pane.rating.category"]'));
  let rating: number | undefined; let reviews: number | undefined;
  for (const img of qsa(main, '[role="img"][aria-label]')) { const r = parseRating(img.getAttribute('aria-label') || ''); if (r.rating) { rating = r.rating; reviews = r.reviews; break; } }
  if (reviews === undefined) for (const el of qsa(main, '[aria-label]')) { const c = (el.getAttribute('aria-label') || '').match(/^\(?([\d.,]+\s?[kKmM]?)\)?\s*(?:reviews?|ulasan|avis|bewertungen|rese[ñn]as|recensioni|beoordelingen)\b/i); if (c) { reviews = parseCount(c[1].replace(/\s/g, '')); break; } }
  if (rating === undefined) { for (const l of flatLines(main).slice(0, 40)) { const m = l.match(RATING_TEXT); if (m) { const r = parseRating(l.replace(/[()]/g, ' ')); if (r.rating) { rating = r.rating; reviews = r.reviews; break; } } } }
  const plus = itemText(at('[data-item-id="oloc"]'));
  const link = canonicalLink(url);
  return { key: placeKey(url) || placeKey(link), href: link, name, category, address: addr, phone, website, rating, reviews, hours: hoursOf(doc) || undefined, plusCode: plus || undefined, coordinates: coordsOf(url) || undefined };
}

/** A place in the form the database takes (field keys, see FIELD_KEY in the crawler). */
export function placeValues(p: Partial<MapsPlace>): Record<string, string> {
  const v: Record<string, string> = {}; const put = (k: string, s?: string | number) => { if (s !== undefined && s !== '' && !Number.isNaN(s)) v[`fld_${k}`] = String(s); };
  put('fullName', p.name); put('industry', p.category); put('location', p.address); put('phone', p.phone); put('website', p.website);
  put('rating', p.rating); put('reviews', p.reviews); put('hours', p.hours); put('plusCode', p.plusCode); put('coordinates', p.coordinates); put('profileUrl', p.href);
  return v;
}
