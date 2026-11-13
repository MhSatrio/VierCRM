// Directory detection: which parts of a page are "one researcher each", and where is each one's profile link?
//
// Same approach as the job-listing scraper (which finds job cards): find links that look like individual entries, group them by URL
// shape, keep a group only if it REPEATS, then climb from each link to the block that holds just that one entry (the card).
// Researcher specifics: an entry's text must look like a person's name, and profile URLs usually sit under /people/, /staff/, /profile/ …
import { absUrl, clean, lines, normUrl, qs, qsa, text } from './dom';

export interface CardFacts { position?: string; department?: string; email?: string; phone?: string; lines: string[] }
export interface PersonCard { url: string; name: string; root: Element; anchor: Element | null; facts: CardFacts }

const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'dos', 'du', 'la', 'le', 'bin', 'binti', 'ibn', 'al', 'el', 'ter', 'ten', 'mac', 'mc', 'st', "o'", 'y']);
const NOT_NAME = /\b(read more|view|profile|contact|e-?mail|home|staff|people|directory|search|login|menu|more|next|previous|back|all|list|show|filter|sort|department|faculty|school|university|institute|laboratory|centre|center|news|events?|about|publications?|research|teaching|courses?|jobs?|careers?|apply|donate|privacy|cookies?|terms|sitemap|click|here|team|group|lab)\b/i;
export const TITLE_RE = /\b(prof(essor)?|lecturer|researcher|scientist|fellow|postdoc(toral)?|doctoral|ph\.?d|candidate|director|head of|chair|dean|reader|associate|assistant|emerit|technician|engineer|manager|coordinator|investigator|scholar|dr\.?|docent|hoogleraar|universitair|privatdozent|professur|maître|chercheur)\b/i;
export const DEPT_RE_EXPORT = /\b(department|dept\.?|faculty|school of|institute|laboratory|lab|centre|center|division|group|section|unit|faculteit|fakultät|vakgroep|instituut)\b/i;
const DEPT_RE = DEPT_RE_EXPORT;
const JOB_WORD = /^(senior|junior|lecturers?|researchers?|scientists?|fellows?|postdoc(toral)?|doctoral|candidate|director|chair|dean|reader|associate|assistant|emeritw*|technician|engineer|manager|coordinator|investigator|scholar|student|staff|member|head|principal|visiting|honorary|adjunct|clinical)$/i;
const HONORIFIC =/^(prof(essor)?\.?|dr\.?|drs?\.?|ir\.?|mr\.?|mrs\.?|ms\.?|mx\.?|assoc(iate)?\.?|asst\.?|assistant|emeritus|dipl\.?|ing\.?|habil\.?|em\.?|apl\.?)$/i;

/** Does this text look like a person's name? ("Prof. Dr. Ada Lovelace", "Lovelace, Ada", "ADA LOVELACE", "Jan van der Berg") */
export function looksLikeName(raw: string): boolean {
  let s = clean(raw).replace(/\([^)]*\)/g, '').replace(/,\s*(ph\.?d\.?|m\.?d\.?|msc|m\.?sc\.?|mba|dr\.?.*)$/i, '').trim();
  if (!s || s.length > 64 || /[0-9@/]/.test(s) || NOT_NAME.test(s)) return false;
  if (/^[^,]+,[^,]+$/.test(s)) { const [a, b] = s.split(','); s = `${b.trim()} ${a.trim()}`; }
  const toks = s.split(/\s+/).filter(t => !HONORIFIC.test(t));
  if (toks.length < 2 || toks.length > 5 || toks.some(t => JOB_WORD.test(t))) return false;      // "Senior Researcher" is a title, not a person
  const ok = (t: string) => PARTICLES.has(t.toLowerCase()) || /^\p{Lu}[\p{L}'’.-]*$/u.test(t) || /^\p{Lu}\.$/u.test(t) || /^\p{L}{1,2}\.?$/u.test(t) && /^\p{Lu}/u.test(t);
  return toks.every(ok) && toks.filter(t => !PARTICLES.has(t.toLowerCase())).length >= 2;
}

const PATH_RE = /\/(companies|company|organi[sz]ations?|vendors?|suppliers?|exhibitors?|partners?|manufacturers?|firms?|clients?|customers?|leads?|people|person|persons|staff|faculty|profiles?|researchers?|team|members?|directory|academics?|employees?|lecturers?|professors?|scientists?|investigators?|fellows?|experts?|personal|medarbejdere|mitarbeiter|personen|medewerkers?|~[^/]+|users?|authors?|bio|biography|who-we-are)\//i;
const SKIP_CONTAINER = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [class*="cookie" i], [class*="breadcrumb" i], [class*="pagination" i]';
/** Is this element inside navigation, a header / footer, a cookie banner or a pager? The page itself never counts: sites put classes such as
 *  "cookie-compliance-active" on <body> (or <html> / <main>), which would otherwise hide every link on the page. */
function inSkip(el: Element): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const tag = e.tagName; if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN' || e.getAttribute('role') === 'main') return false;
    if (e.matches(SKIP_CONTAINER)) return true;
  }
  return false;
}

/** link texts that are navigation, never an entry of a list (used when the list is "anything", not people) */
const GENERIC_TEXT = /^(read more|learn more|more( info(rmation)?)?|view( all| more| profile| details)?|details|next|previous|prev|back|home|log ?in|sign ?(in|up)|register|contact( us)?|menu|search|about( us)?|privacy( policy)?|terms|cookies?|page \d+|\d+|[»«›‹…>←→]+|first|last|top|skip to .*|website|visit( website)?)$/i;
const itemName = (raw: string) => { const t = clean(raw).split('\n')[0].trim(); return t.length >= 2 && t.length <= 90 && t.split(/\s+/).length <= 12 && !GENERIC_TEXT.test(t) && /\p{L}/u.test(t) ? t : ''; };

interface Cand { a: Element; url: string; key: string; shape: string; name: string; pathy: boolean }

function nameOfAnchor(a: Element, items = false): string {
  const ls = lines(a);
  if (items) { const h = qs(a, 'h1,h2,h3,h4,h5,h6,strong,b,[class*="name" i],[class*="title" i]'); return itemName(h ? text(h) : '') || ls.map(itemName).find(Boolean) || itemName(qs(a, 'img')?.getAttribute('alt') || ''); }
  const h = qs(a, 'h1,h2,h3,h4,h5,h6,strong,b,[class*="name" i]'); const hn = h ? clean(text(h)) : '';
  if (hn && looksLikeName(hn)) return hn;
  const first = ls.find(looksLikeName); if (first) return first;
  const t = clean(text(a)); if (looksLikeName(t)) return t;
  const img = qs(a, 'img'); const alt = clean(img?.getAttribute('alt')); if (alt && looksLikeName(alt)) return alt;
  return '';
}

/** Climb from a link to the smallest block that contains no OTHER candidate's link. */
function cardRoot(a: Element, key: string, keyOf: (e: Element) => string | null, body: Element): Element {
  let el = a;
  for (let i = 0; i < 9 && el.parentElement && el.parentElement !== body; i++) {
    const p = el.parentElement;
    if (qsa(p, 'a[href]').some(x => { const k = keyOf(x); return k && k !== key; })) break;
    el = p;
  }
  return el;
}

export function cardFacts(root: Element, name: string): CardFacts {
  const ls = lines(root).filter(l => l !== name);
  const clamp = (s?: string) => (s ? s.slice(0, 160) : undefined);
  const position = ls.find(l => TITLE_RE.test(l) && l.length < 120 && !/@/.test(l));
  const department = ls.find(l => l !== position && DEPT_RE.test(l) && l.length < 140 && !/@/.test(l));
  const mail = qsa(root, 'a[href^="mailto:" i]').map(a => a.getAttribute('href')!.replace(/^mailto:/i, '').split('?')[0].trim()).find(Boolean);
  const tel = qsa(root, 'a[href^="tel:" i]').map(a => a.getAttribute('href')!.replace(/^tel:/i, '').trim()).find(Boolean);
  return { position: clamp(position), department: clamp(department), email: mail, phone: tel, lines: lines(root).slice(0, 12) };
}

export interface DetectOpts { cardSelector?: string; linkSelector?: string; listContext?: boolean; baseUrl?: string; /** 'items': companies, products, leads … – any repeated entry, not only people's names */ kind?: 'people' | 'items' }

/** Researchers on this page, in page order. */
export function detectPeople(doc: Document, opts: DetectOpts = {}): PersonCard[] {
  const base = opts.baseUrl || doc.location?.href || 'https://example.invalid/'; const body = doc.body;
  if (!body) return [];
  // 1) the user told us the card / link selectors
  if (opts.cardSelector) {
    const roots = qsa(doc, opts.cardSelector); const out: PersonCard[] = []; const seen = new Set<string>();
    for (const root of roots) {
      const a = opts.linkSelector ? qs(root, opts.linkSelector) : qs(root, 'a[href]:not([href^="mailto:"]):not([href^="tel:"])');
      const url = a ? absUrl(a.getAttribute('href') || '', base) : null;
      const nameEl = qs(root, 'h1,h2,h3,h4,[class*="name" i]') || a; const name = clean(text(nameEl)).split('\n')[0] || '';
      const key = url ? normUrl(url) : `${name}|${out.length}`; if (seen.has(key)) continue; seen.add(key);
      out.push({ url: url || '', name, root, anchor: a, facts: cardFacts(root, name) });
    }
    return out;
  }
  // 2) link-based detection
  const cands: Cand[] = [];
  for (const a of qsa(body, opts.linkSelector || 'a[href]')) {
    const raw = a.getAttribute('href') || ''; if (/^(mailto:|tel:|javascript:|#)/i.test(raw)) continue;
    if (!opts.linkSelector && inSkip(a)) continue;
    const url = absUrl(raw, base); if (!url) continue; if (normUrl(url) === normUrl(base)) continue;
    const u = new URL(url); const name = nameOfAnchor(a, opts.kind === 'items'); const pathy = PATH_RE.test(u.pathname + '/');
    if (!opts.linkSelector && !name) continue;
    const shape = u.host + u.pathname.replace(/\/[^/]*\/?$/, '');
    cands.push({ a, url, key: normUrl(url), shape, name: name || clean(text(a)), pathy });
  }
  const groups = new Map<string, Map<string, Cand>>();
  for (const c of cands) { const g = groups.get(c.shape) || new Map<string, Cand>(); if (!g.has(c.key)) g.set(c.key, c); groups.set(c.shape, g); }
  const bonus = opts.listContext ? 1 : 0;
  const lists = [...groups.values()].filter(g => { const n = g.size; const pathy = [...g.values()].filter(c => c.pathy).length; return n >= (pathy >= n * 0.6 ? 2 : 3) - bonus; }).sort((a, b) => b.size - a.size);
  if (lists.length) {
    const keyOf = (e: Element) => cands.find(c => c.a === e)?.key ?? null;
    const picked = lists.filter(g => g.size >= Math.max(2, lists[0].size * 0.25));       // the main list, plus its siblings (one list per letter, or several lists on a page – the shorter last page of one must not be dropped)
    const out: PersonCard[] = []; const seen = new Set<string>();
    for (const g of picked) for (const c of g.values()) {
      if (seen.has(c.key)) continue; seen.add(c.key);
      const root = cardRoot(c.a, c.key, keyOf, body);
      out.push({ url: c.url, name: c.name, root, anchor: c.a, facts: cardFacts(root, c.name) });
    }
    return out.sort((x, y) => (x.root.compareDocumentPosition(y.root) & 4 ? -1 : 1));
  }
  // 3) fallback: repeated sibling blocks that each hold a person's name (cards without profile links, or with unusual URLs)
  return repeatedBlocks(doc, base, opts.kind === 'items');
}

function repeatedBlocks(doc: Document, base: string, items = false): PersonCard[] {
  const groups = new Map<Element, Map<string, Element[]>>();
  for (const el of qsa(doc.body, 'li, article, tr, section, div')) {
    const parent = el.parentElement; if (!parent || inSkip(el)) continue;
    const len = text(el).length; if (len < 12 || len > 1500) continue;
    const sig = `${el.tagName}.${String(el.getAttribute('class') || '').split(/\s+/).filter(c => c && !/(active|selected|hover|odd|even|first|last|current)|\d/i.test(c)).sort().join('.')}`;
    const g = groups.get(parent) || new Map(); g.set(sig, [...(g.get(sig) || []), el]); groups.set(parent, g);
  }
  let best: PersonCard[] = []; let bestScore = 0;
  for (const sigs of groups.values()) for (const els of sigs.values()) {
    if (els.length < 3) continue;
    const items: PersonCard[] = [];
    for (const el of els) {
      const head = qs(el, 'h1,h2,h3,h4,h5,h6,strong,[class*="name" i],a');
      const cands = [head ? clean(text(head)) : '', ...lines(el)].filter(Boolean); const name = items ? cands.map(itemName).find(Boolean) : cands.find(looksLikeName); if (!name) continue;
      const a = qs(el, 'a[href]:not([href^="mailto:"]):not([href^="tel:"])'); const url = a ? absUrl(a.getAttribute('href') || '', base) || '' : '';
      items.push({ url, name, root: el, anchor: a, facts: cardFacts(el, name) });
    }
    if (items.length < 3 || items.length < els.length * 0.6) continue;
    const score = items.length * Math.min(400, items.reduce((s, i) => s + text(i.root).length, 0) / items.length);
    if (score > bestScore) { best = items; bestScore = score; }
  }
  return best;
}

/** A signature of the people currently listed – used to notice that a page turn or "load more" really changed the list. */
export const listSignature = (cards: PersonCard[]) => cards.slice(0, 8).map(c => c.url || c.name).join('|');
