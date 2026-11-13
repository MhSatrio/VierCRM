// Moving through a directory: "Next" links, numbered pages, URL templates, "Load more" buttons, in-page Next buttons (single-page apps)
// and infinite scroll. Logic ported from the job-listing scraper's capture script, parameterised with a Document so it is testable.
import type { PaginationConfig } from '../core/types';
import { absUrl, clean, isVisible, normUrl, qs, qsa, sleep, text, waitFor } from './dom';
import { detectPeople, listSignature, type DetectOpts } from './detect';

export const NEXT_TEXT = /^(next( page)?|›|»|>|→|selanjutnya|berikutnya|lanjut|volgende( pagina)?|weiter|nächste( seite)?|suivant(e)?|page suivante|siguiente|próxima|下一页|次へ|次のページ|次ページ)$/i;
const LOAD_MORE = /^(load more|show more|view more|see more|more results|more people|lihat lebih banyak|muat lebih banyak|tampilkan lebih banyak|meer laden|toon meer|mehr laden|voir plus|afficher plus|charger plus|もっと見る|さらに表示)\b/i;
const enabled = (a: Element) => a.getAttribute('aria-disabled') !== 'true' && !a.hasAttribute('disabled') && !/disabled/i.test(String(a.getAttribute('class') || ''));
const real = (href: string | null | undefined) => !!href && !href.startsWith('#') && !/^javascript:/i.test(href);

const NEXT_LOOSE = /\bnext\b|\bsuivant|\bsiguiente|\bvolgende|\bweiter\b|\bnächste|\bselanjutnya|\bberikutnya|\bpróxima|下一页|次へ|次のページ/i;
const ARROW_ONLY = /^[›»→>⟩⟫▶►]+$/;
const PAGER_BOX = '[class*="pag" i], [id*="pag" i], [aria-label*="pag" i], [role="navigation"], nav, ul.pager, .pager, [class*="paging" i]';
const PAGE_PARAMS = /^(page|p|pg|paged|pagenum|pagenumber|page_no|pageno|pageindex|page_index|pagina|seite|strana|pno|currentpage|pn)$/i;
const OFFSET_PARAMS = /^(start|offset|from|skip|first|begin|startrow|b_start|s)$/i;

/** The page number in `url` according to a pattern with {page} (query value or path part), or null when the address does not match. */
export function pageNumberFromUrl(template: string, url: string): number | null {
  try {
    const esc = (t: string) => t.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
    const t = template.split('#')[0]; const u = url.split('#')[0];
    const re = new RegExp('^' + esc(t).replace('\\{page\\}', '(\\d+)').replace('{page}', '(\\d+)') + '$'); const m = u.match(re);
    if (m) return Number(m[1]);
    // same page parameter, other parameters in another order / an extra tracking parameter
    const tu = new URL(t.replace('{page}', '0'), url), cu = new URL(u, url); if (tu.origin !== cu.origin || tu.pathname !== cu.pathname) return null;
    for (const [k, v] of tu.searchParams) if (v === '0' && t.includes(k + '={page}')) { const val = cu.searchParams.get(k); return val != null && /^\d+$/.test(val) ? Number(val) : null; }
  } catch { /* not an address */ }
  return null;
}

export interface NextResult { url: string | null; how: string; /** what was looked at – shown when nothing was found, so a failure is explainable */ evidence: string[]; /** a pager exists on the page (so "no next" really means the last page, or an unsupported pager) */ pagerSeen: boolean }

/** The visible label of a control: hidden "Next page" helper text, aria-label, title and the text itself. */
const labelOf = (a: Element) => clean(a.getAttribute('aria-label') || a.getAttribute('title') || text(a));
const numOf = (a: Element) => { const m = clean(text(a)).match(/^(?:page\s*)?(\d{1,4})$/i); return m ? Number(m[1]) : null; };
const paramOf = (href: string, base: string): { name: string; value: number } | null => { try { const u = new URL(href, base); for (const [k, v] of u.searchParams) if (PAGE_PARAMS.test(k) && /^\d+$/.test(v)) return { name: k, value: Number(v) }; } catch { /* ignore */ } return null; };

/**
 * Where is the next page? Tries, in order: your own selector · a URL template · rel="next" · a control that says / means "Next" (text, aria-label, title,
 * arrows, class names – also when the text is hidden helper text) · the numbered pager (the current page may be marked, or just not a link; page numbers may
 * be 0-based) · and, only when the page shows no pager at all, a page / offset number inside the current address.
 * A "Next" control that is switched off, or the highest page number being the current one, means "last page" – nothing is guessed then.
 */
export function findNext(doc: Document, base: string, cfg: Pick<PaginationConfig, 'nextSelector' | 'mode' | 'urlTemplate' | 'startPage'>, pageIndex = 1, step = 0): NextResult {
  const evidence: string[] = []; let pagerSeen = false;
  const hit = (url: string | null, how: string): NextResult => ({ url, how, evidence, pagerSeen });
  if (cfg.mode === 'url' && cfg.urlTemplate) {
    // The number of the page we are ON is read out of the address with the pattern (a site may start at 0 or 1, and the tab may be on any page);
    // only a first page without a number in its address falls back to "first number + pages read".
    const cur = pageNumberFromUrl(cfg.urlTemplate, base);
    const n = cur != null ? cur + 1 : (cfg.startPage ?? 1) + pageIndex;
    if (cur == null) evidence.push('the address does not match your URL pattern – counted from the first page number');
    return hit(cfg.urlTemplate.replace('{page}', String(n)), 'your URL pattern');
  }

  if (cfg.nextSelector) {
    const picked = qs(doc, cfg.nextSelector); const el = picked?.closest('a[href]') ?? picked;           // the picker may have chosen the <span> inside the link
    if (!picked) evidence.push('your “Next” selector matches nothing on this page'); else { const h = el?.getAttribute('href'); if (el && real(h) && enabled(el)) return hit(absUrl(h!, base), 'your selector'); evidence.push('your selector matches an element that is not a usable link'); }
  }

  const rels = qsa(doc, 'a[rel~="next"], link[rel="next"]'); evidence.push(rels.length + ' × rel="next"');
  for (const r of rels) { const h = r.getAttribute('href'); if (real(h)) { if (enabled(r)) return hit(absUrl(h!, base), 'rel="next"'); evidence.push('rel="next" control is disabled'); pagerSeen = true; } }

  // anything that says or means "Next"
  let disabledNext = false; let looseCount = 0;
  for (const a of qsa(doc, 'a[href]')) {
    if (a.closest('[class*="cookie" i]')) continue;
    const label = labelOf(a); const cls = String(a.getAttribute('class') || '') + ' ' + String(a.parentElement?.getAttribute('class') || '');
    const inPager = !!a.closest(PAGER_BOX);
    const says = NEXT_TEXT.test(label) || ARROW_ONLY.test(label) || (inPager && label.length <= 40 && NEXT_LOOSE.test(label)) || (inPager && /(^|[\s_-])next([\s_-]|$)|--next|__next/i.test(cls));
    if (!says) continue; looseCount++; pagerSeen = pagerSeen || inPager;
    const h = a.getAttribute('href');
    if (!real(h)) { evidence.push('a “Next” link has no address (a script button?)'); continue; }
    if (!enabled(a)) { disabledNext = true; continue; }
    if (!inPager && !isVisible(a)) continue;
    return hit(absUrl(h!, base), 'a “Next” control');
  }
  evidence.push(looseCount + ' “Next”-like link(s)');
  if (disabledNext) { evidence.push('the “Next” control is switched off – last page'); return hit(null, 'last page (Next is disabled)'); }

  // numbered pager
  const numeric = qsa(doc, 'a[href]').map(a => ({ a, n: numOf(a) })).filter((x): x is { a: Element; n: number } => x.n != null && real(x.a.getAttribute('href')));
  const groups = new Map<Element, { a: Element; n: number }[]>();
  for (const x of numeric) { const box = x.a.closest('ul, ol, nav, div') || x.a.parentElement!; const g = groups.get(box) || []; g.push(x); groups.set(box, g); }
  const lists = [...groups.entries()].filter(([, g]) => g.length >= 2).sort((x, y) => y[1].length - x[1].length);
  evidence.push(lists.length + ' numbered pager(s)');
  if (lists.length) {
    pagerSeen = true;
    for (const [box, g] of lists) {
      // the current page: marked (aria-current, active, current …) or simply a number that is not a link
      const mark = qsa(box, '[aria-current], .active, .is-active, .current, .selected, .pager__item--active').map(e => clean(text(e)).match(/^(?:page\s*)?(\d{1,4})$/i)).find(m => m);
      const plain = qsa(box, 'li, span, strong, b').filter(e => !e.querySelector('a') && !e.closest('a') && /^(?:page\s*)?\d{1,4}$/i.test(clean(text(e)))).map(e => Number(clean(text(e)).replace(/\D/g, '')));
      let cur = mark ? Number(mark[1]) : plain.length === 1 ? plain[0] : 0;
      if (!cur) { const pm = paramOf(base, base); const link = g.map(x => ({ ...x, v: paramOf(x.a.getAttribute('href')!, base)?.value })).find(x => x.v != null); const zeroBased = !!link && link.v === link.n - 1; cur = pm ? pm.value + (zeroBased ? 1 : 0) : 1; }
      const nxt = g.find(x => x.n === cur + 1);
      if (nxt) return hit(absUrl(nxt.a.getAttribute('href')!, base), 'the next page number');
      if (cur >= Math.max(...g.map(x => x.n))) { evidence.push('the current page is the highest page number – last page'); return hit(null, 'last page (highest number)'); }
      evidence.push('page ' + (cur + 1) + ' is not shown in the pager (a window of numbers?)');
    }
  }

  // no pager of any kind on the page: a page / offset number in the address itself (JavaScript pagers, pagers drawn after load, hidden pagers)
  if (!pagerSeen) {
    try {
      const u = new URL(base);
      for (const [k, v] of u.searchParams) if (PAGE_PARAMS.test(k) && /^\d+$/.test(v)) { u.searchParams.set(k, String(Number(v) + 1)); evidence.push('guessed from ?' + k + '=' + v); return hit(u.href, 'the page number in the address (guess)'); }
      if (step > 0) for (const [k, v] of u.searchParams) if (OFFSET_PARAMS.test(k) && /^\d+$/.test(v)) { u.searchParams.set(k, String(Number(v) + step)); evidence.push('guessed from ?' + k + '=' + v); return hit(u.href, 'the offset in the address (guess)'); }
      const m = u.pathname.match(/^(.*\/(?:page|p|seite|pagina)[/-])(\d+)(\/?)$/i);
      if (m) { u.pathname = m[1] + (Number(m[2]) + 1) + m[3]; evidence.push('guessed from the path'); return hit(u.href, 'the page number in the path (guess)'); }
    } catch { /* ignore */ }
    evidence.push('no page number in the address either');
  }
  return hit(null, pagerSeen ? 'a pager exists but no next page could be found' : 'no pager on the page');
}

/**
 * The address of the FIRST page of this list when the tab is on a later one, else null (we are on the first page, or cannot tell).
 * Evidence: rel="first", a "First page" / « / < control, the link to page number 1, or – when a Previous control exists – the page
 * parameter set to its lowest value seen in the pager.
 */
export function findFirst(doc: Document, base: string): string | null {
  const prev = qsa(doc, 'a[rel~="prev"], a[rel~="previous"], link[rel="prev"]').filter(a => real(a.getAttribute('href')) && enabled(a));
  const labelled = qsa(doc, 'a[href]').filter(a => { const l = labelOf(a); return !a.closest('[class*="cookie" i]') && real(a.getAttribute('href')) && enabled(a) && (/^(first( page)?|go to first page|erste( seite)?|première( page)?|primera|eerste|最初|最初へ)$/i.test(l) || /^(«|‹‹|<<|⇤|⏮)$/.test(l) || (/^</.test(l) && l.length <= 14 && /first/i.test(l)) || (/^<$/.test(l) && !!a.closest(PAGER_BOX))); });
  const rel = qs(doc, 'a[rel~="first"], link[rel="first"]');
  const numbered = qsa(doc, 'a[href]').find(a => numOf(a) === 1 && !!a.closest(PAGER_BOX) && real(a.getAttribute('href')));
  const hasPrev = prev.length > 0 || qsa(doc, 'a[href]').some(a => /^(prev(ious)?( page)?|vorige|précédent(e)?|anterior|sebelumnya)$/i.test(labelOf(a)) && enabled(a) && !!a.closest(PAGER_BOX));
  if (!hasPrev && !labelled.length && !rel) return null;                    // nothing says there is a page before this one
  const pick = (rel ?? labelled[0] ?? numbered) as Element | undefined; const h = pick?.getAttribute('href');
  if (pick && real(h)) { const url = absUrl(h!, base); return url && normUrl(url) !== normUrl(base) ? url : null; }
  return null;
}

/** The URL of the next page of results, or null (see findNext for how and why). */
export function findNextUrl(doc: Document, base: string, cfg: Pick<PaginationConfig, 'nextSelector' | 'mode' | 'urlTemplate' | 'startPage'>, pageIndex = 1, step = 0): string | null {
  return findNext(doc, base, cfg, pageIndex, step).url;
}

/** A Next control that is a button (single-page apps) rather than a link. */
export function findNextButton(doc: Document, cfg: Pick<PaginationConfig, 'nextSelector'>): HTMLElement | null {
  if (cfg.nextSelector) { const hit = qs<HTMLElement>(doc, cfg.nextSelector); const el = hit?.closest<HTMLElement>('a, button, [role="button"]') ?? hit; if (el && enabled(el) && isVisible(el)) return el; }
  return qsa<HTMLElement>(doc, 'button, [role="button"], li.next > *, .pagination-next, a[href="#"]').filter(isVisible).find(b => {
    const label = clean(`${b.getAttribute('aria-label') || ''} ${text(b)}`);
    return (NEXT_TEXT.test(clean(text(b))) || /^(next|next page|volgende|suivant|weiter|selanjutnya)\b/i.test(label) || /\bnext\b/i.test(b.getAttribute('aria-label') || '')) && enabled(b);
  }) ?? null;
}

export function findLoadMore(doc: Document, cfg: Pick<PaginationConfig, 'loadMoreSelector'>): HTMLElement | null {
  if (cfg.loadMoreSelector) { const el = qs<HTMLElement>(doc, cfg.loadMoreSelector); return el && enabled(el) && isVisible(el) ? el : null; }
  return qsa<HTMLElement>(doc, 'button, a[role="button"], a, [role="button"]').filter(isVisible).find(b => LOAD_MORE.test(clean(text(b))) && enabled(b)) ?? null;
}

/** "auto" → the concrete behaviour for THIS page: a Next link / button wins, then Load more, otherwise try infinite scroll once. */
export function resolveMode(doc: Document, base: string, cfg: PaginationConfig, pageIndex = 1): PaginationConfig['mode'] {
  if (cfg.mode !== 'auto') return cfg.mode;
  if (findNextUrl(doc, base, cfg, pageIndex) || findNextButton(doc, cfg)) return 'next';
  if (findLoadMore(doc, cfg)) return 'loadMore';
  return 'infinite';
}

export interface ExpandResult { clicks: number; scrolls: number; reason: string }

/**
 * Reveal the rest of a single-page list: click "Load more" until it disappears or stops adding people, then scroll (infinite lists),
 * like a person would. Bounded by maxScrollRounds; stops as soon as a round adds nobody.
 */
export async function expandList(doc: Document, cfg: PaginationConfig, detect: DetectOpts, { pause = [600, 1100] as [number, number], control }: { pause?: [number, number]; control?: () => Promise<boolean> } = {}): Promise<ExpandResult> {
  const win = doc.defaultView!; const count = () => detectPeople(doc, detect).length;
  const res: ExpandResult = { clicks: 0, scrolls: 0, reason: '' };
  const wantMore = cfg.mode === 'loadMore' || cfg.mode === 'auto';
  const wantScroll = cfg.mode === 'infinite' || cfg.mode === 'auto';
  if (wantMore) for (let i = 0; i < cfg.maxScrollRounds; i++) {
    if (control && (await control())) { res.reason = 'stopped'; return res; }
    const btn = findLoadMore(doc, cfg); if (!btn) break;
    const before = count(); btn.scrollIntoView?.({ block: 'center' }); btn.click(); res.clicks++;
    const grew = await waitFor(() => count() > before, { timeout: 6000, interval: 300 });
    if (!grew) { res.reason = 'Load more added nobody'; break; }
    await sleep(pause[0] + Math.random() * (pause[1] - pause[0]));
  }
  if (wantScroll) {
    let last = count();
    for (let i = 0; i < cfg.maxScrollRounds; i++) {
      if (control && (await control())) { res.reason = 'stopped'; return res; }
      win.scrollTo(0, doc.body.scrollHeight); res.scrolls++;
      await sleep(pause[0] + Math.random() * (pause[1] - pause[0]));
      const grew = await waitFor(() => count() > last, { timeout: 2500, interval: 250 });
      if (!grew) break; last = count();
    }
    win.scrollTo(0, 0);
  }
  return res;
}

/** Click an in-page Next button and wait until the list really changes. Returns false when it did not (the last page). */
export async function clickNextAndWait(doc: Document, cfg: PaginationConfig, detect: DetectOpts, timeout = 9000): Promise<boolean> {
  const btn = findNextButton(doc, cfg); if (!btn) return false;
  const before = listSignature(detectPeople(doc, detect));
  btn.scrollIntoView?.({ block: 'center' }); btn.click();
  const changed = await waitFor(() => { const now = listSignature(detectPeople(doc, detect)); return now && now !== before; }, { timeout, interval: 300 });
  return !!changed;
}

export { normUrl };
