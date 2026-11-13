import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { findNext } from '../../src/scrape/paginate';
import { exampleScrapeConfigs } from '../../src/core/defaults';

// Pager styles seen on real websites (all markup here is invented). Each case: [what it is, page address, markup, expected next address or null].
const cfg = exampleScrapeConfigs()[0].pagination;
const run = (url: string, html: string, over: Partial<typeof cfg> = {}, step = 0) => findNext(new JSDOM(`<!doctype html><html><head>${html.startsWith('<link') ? html.slice(0, html.indexOf('>') + 1) : ''}</head><body>${html.startsWith('<link') ? html.slice(html.indexOf('>') + 1) : html}</body></html>`, { url }).window.document, url, { ...cfg, ...over }, 2, step);
const B = 'https://site.example';

const CASES: [string, string, string, string | null][] = [
  ['1  Drupal pager with rel="next" (three pagers on one page)', `${B}/people?page=1`, '<nav class="pager"><ul><li><a href="?page=0" rel="prev">Previous</a></li><li><a href="?page=2" rel="next" title="Go to next page"><span class="visually-hidden">Next page</span><span aria-hidden="true">Next</span></a></li></ul></nav><nav class="pager"><a href="?page=2" rel="next">Next</a></nav>', `${B}/people?page=2`],
  ['2  only a <link rel="next"> in the head', `${B}/list/2`, '<link rel="next" href="/list/3"><p>content</p>', `${B}/list/3`],
  ['3  icon-only button with an aria-label', `${B}/c?page=1`, '<nav aria-label="Pagination"><a href="/c?page=2" aria-label="Next page"><svg width="8"><path d="M0 0"/></svg></a></nav>', `${B}/c?page=2`],
  ['4  just an arrow (›)', `${B}/c?page=1`, '<div class="pagination"><a href="?page=0">‹</a><a href="?page=2">›</a></div>', `${B}/c?page=2`],
  ['5  helper text inside the link ("Next page") and a hidden decoration', `${B}/c`, '<div class="pager"><a href="/c?pg=2"><span class="sr-only">Next page</span><span aria-hidden="true">&raquo;</span></a></div>', `${B}/c?pg=2`],
  ['6  the word “next” only in a class name, link has just an icon', `${B}/s?p=2`, '<ul class="pagination"><li class="pagination-next"><a href="?p=3"><i class="icon"></i></a></li></ul>', `${B}/s?p=3`],
  ['7  numbers only; the current page is a plain number, not a link', `${B}/a/2`, '<ul class="pages"><li><a href="/a/1">1</a></li><li>2</li><li><a href="/a/3">3</a></li><li><a href="/a/4">4</a></li></ul>', `${B}/a/3`],
  ['8  numbers, first page without a parameter, links are 0-based', `${B}/staff`, '<ul class="pager"><li>1</li><li><a href="?page=1">2</a></li><li><a href="?page=2">3</a></li></ul>', `${B}/staff?page=1`],
  ['9  numbers, no marker at all, address says ?page=2 (0-based links)', `${B}/staff?page=2`, '<ul class="pager"><li><a href="?page=0">1</a></li><li><a href="?page=1">2</a></li><li><a href="?page=2">3</a></li><li><a href="?page=3">4</a></li></ul>', `${B}/staff?page=3`],
  ['10 a window of numbers (1 … 9) plus “Next”', `${B}/people?page=6`, '<nav class="pager"><a href="?page=0">1</a><a href="?page=5">6</a><span>7</span><a href="?page=8">9</a><a href="?page=7" rel="next">Next</a></nav>', `${B}/people?page=7`],
  ['11 “Next” switched off on the last page (class disabled)', `${B}/p/9`, '<nav class="pager"><a href="/p/8">Previous</a><a class="next disabled" href="/p/10">Next</a></nav>', null],
  ['12 aria-disabled “Next” on the last page', `${B}/p/9`, '<nav class="pager"><a href="/p/8">Prev</a><a href="/p/10" aria-disabled="true" rel="next">Next</a></nav>', null],
  ['13 the highest page number is the current one, no Next at all', `${B}/p/3`, '<ul class="pager"><li><a href="/p/1">1</a></li><li><a href="/p/2">2</a></li><li>3</li></ul>', null],
  ['14 no pager drawn, address has ?page=4 (JavaScript pager) → guess 5', `${B}/news?page=4`, '<p>10 results</p>', `${B}/news?page=5`],
  ['15 no pager drawn, address ends in /page/2/ → guess /page/3/', `${B}/news/page/2/`, '<p>articles</p>', `${B}/news/page/3/`],
  ['16 no pager drawn, offset in the address (start=20, 10 entries per page)', `${B}/list?start=20`, '<p>results</p>', `${B}/list?start=30`],
  ['17 nothing at all: single page, no number in the address', `${B}/people`, '<ul><li>One</li></ul>', null],
  ['18 “Next steps” call-to-action elsewhere on the page is not a pager', `${B}/people`, '<a href="/apply">Next steps for applicants</a>', null],
  ['19 another language, text only: “Volgende”', `${B}/mensen?pagina=1`, '<div class="paginering"><a href="?pagina=2">Volgende</a></div>', `${B}/mensen?pagina=2`],
  ['20 Spanish with an arrow: “Siguiente »” in a pager', `${B}/g?p=1`, '<div class="pagination"><a href="?p=2">Siguiente &raquo;</a></div>', `${B}/g?p=2`],
  ['21 “Next” is a script button (href="#") – no address to follow', `${B}/app`, '<nav class="pager"><a href="#" class="next">Next</a></nav>', null],
];

describe('finding the next page on many kinds of pagers', () => {
  for (const [name, url, html, expected] of CASES) it(name, () => {
    const r = run(url, html, {}, 10);
    expect(r.url).toBe(expected);
    if (expected === null) expect(r.evidence.length).toBeGreaterThan(0);                // a failure always says what was looked at
  });

  it('a “last page” is never guessed past (disabled Next or highest number), while a missing pager is guessed only from the address', () => {
    expect(run(`${B}/p/9?page=9`, '<nav class="pager"><a class="next disabled" href="?page=10">Next</a></nav>').how).toMatch(/last page/);
    expect(run(`${B}/p?page=3`, '<ul class="pager"><li><a href="?page=1">1</a></li><li><a href="?page=2">2</a></li><li>3</li></ul>').how).toMatch(/last page/);
    expect(run(`${B}/p?page=3`, '<p>no pager here</p>').how).toMatch(/guess/);
  });

  it('the user’s own selector wins – also when it points at the <span> inside the link, and when it matches nothing the fallbacks still work', () => {
    const html = '<nav class="pager"><a href="?page=2" rel="next"><span>Next</span></a></nav>';
    expect(run(`${B}/x?page=1`, html, { nextSelector: 'nav.pager > a > span' }).url).toBe(`${B}/x?page=2`);
    const r = run(`${B}/x?page=1`, html, { nextSelector: '.does-not-exist' }); expect(r.url).toBe(`${B}/x?page=2`); expect(r.evidence.join(' ')).toMatch(/matches nothing/);
  });

  it('URL pattern mode ignores the page', () => { expect(run(`${B}/x`, '<p></p>', { mode: 'url', urlTemplate: `${B}/x?page={page}`, startPage: 1 }).url).toBe(`${B}/x?page=3`); });
});

import { findFirst, pageNumberFromUrl } from '../../src/scrape/paginate';

describe('URL pattern mode reads the page you are ON (sites that count from 0, tabs started mid-list)', () => {
  const tpl = `${B}/chl-people?page={page}`;
  it('parses the number out of the address, in any parameter order and in paths', () => {
    expect(pageNumberFromUrl(tpl, `${B}/chl-people?page=4`)).toBe(4);
    expect(pageNumberFromUrl(tpl, `${B}/chl-people?utm_source=x&page=7`)).toBe(7);
    expect(pageNumberFromUrl(tpl, `${B}/chl-people`)).toBeNull();
    expect(pageNumberFromUrl(`${B}/news/page/{page}/`, `${B}/news/page/12/`)).toBe(12);
    expect(pageNumberFromUrl(tpl, `${B}/other?page=4`)).toBeNull();
  });
  it('0-based site, tab on ?page=1, “first page number” 0: next is ?page=2 (it used to compute ?page=1 again and stop)', () => {
    const r = run(`${B}/chl-people?page=1`, '<p></p>', { mode: 'url', urlTemplate: tpl, startPage: 0 }); expect(r.url).toBe(`${B}/chl-people?page=2`);
  });
  it('a first page without a number falls back to “first number + pages read”', () => {
    expect(run(`${B}/chl-people`, '<p></p>', { mode: 'url', urlTemplate: tpl, startPage: 0 }).url).toBe(`${B}/chl-people?page=2`);   // pageIndex 2 in these tests
    expect(run(`${B}/chl-people`, '<p></p>', { mode: 'url', urlTemplate: tpl, startPage: 1 }).evidence.join(' ')).toMatch(/does not match/);
  });
});

describe('opening the first page when the tab is on a later one', () => {
  const doc = (url: string, html: string) => new JSDOM(`<!doctype html><body>${html}</body>`, { url }).window.document;
  it('Drupal pager: “First page” / rel=prev links → the first page', () => {
    const d = doc(`${B}/chl-people?page=1`, '<nav class="pager"><a href="?page=0" title="Go to first page">First page <span>&lt;</span></a><a href="?page=0" rel="prev">Previous</a><a href="?page=0">1</a><span>2</span><a href="?page=2">3</a><a href="?page=2" rel="next">Next</a></nav>');
    expect(findFirst(d, `${B}/chl-people?page=1`)).toBe(`${B}/chl-people?page=0`);
  });
  it('the link to page number 1 is enough when a Previous control shows we are not on it', () => {
    const d = doc(`${B}/a/3`, '<ul class="pagination"><li><a href="/a/2" rel="prev">Prev</a></li><li><a href="/a/1">1</a></li><li><a href="/a/2">2</a></li><li>3</li></ul>');
    expect(findFirst(d, `${B}/a/3`)).toBe(`${B}/a/1`);
  });
  it('on the first page – Previous missing or disabled – nothing is opened', () => {
    expect(findFirst(doc(`${B}/chl-people`, '<nav class="pager"><span>1</span><a href="?page=1">2</a><a href="?page=1" rel="next">Next</a></nav>'), `${B}/chl-people`)).toBeNull();
    expect(findFirst(doc(`${B}/a/1`, '<ul class="pagination"><li><a class="disabled" href="/a/0">Previous</a></li><li>1</li><li><a href="/a/2">2</a></li></ul>'), `${B}/a/1`)).toBeNull();
    expect(findFirst(doc(`${B}/x`, '<p>no pager</p>'), `${B}/x`)).toBeNull();
  });
});
