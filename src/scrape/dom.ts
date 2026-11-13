// Small DOM helpers shared by detection, extraction and pagination. They take a Document / Element argument so the same code runs in a
// real page (content script) and in jsdom (unit tests).

export const clean = (s: string | null | undefined) => String(s ?? '').replace(/[ ​]/g, ' ').replace(/\s+/g, ' ').trim();
const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL', 'BR']);

/** Visible-ish text of an element with line breaks between blocks (innerText does not exist in jsdom, and is slow on big pages). */
export function text(el: Element | null | undefined): string {
  if (!el) return '';
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === 3) { out += n.nodeValue; return; }
    if (n.nodeType !== 1) return;
    const e = n as Element; const tag = e.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG') return;
    if (e.getAttribute('hidden') !== null || e.getAttribute('aria-hidden') === 'true') return;
    const block = BLOCK.has(tag); if (block) out += '\n';
    for (const c of Array.from(e.childNodes)) walk(c);
    if (block) out += '\n';
  };
  walk(el);
  return out.split('\n').map(clean).filter(Boolean).join('\n');
}
export const lines = (el: Element | null | undefined) => text(el).split('\n').map(clean).filter(Boolean);

export function isVisible(el: Element): boolean {
  const win = el.ownerDocument.defaultView; if (!win) return true;
  let e: Element | null = el;
  for (let i = 0; e && i < 6; i++, e = e.parentElement) { const cs = win.getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; }
  return true;
}

export const qsa = <T extends Element = Element>(root: ParentNode, sel: string): T[] => { try { return Array.from(root.querySelectorAll<T>(sel)); } catch { return []; } };
export const qs = <T extends Element = Element>(root: ParentNode, sel: string): T | null => { try { return root.querySelector<T>(sel); } catch { return null; } };

/** URL without fragment, trailing slash, tracking params – for "have we seen this page" checks. */
export function normUrl(u: string): string {
  try { const x = new URL(u); x.hash = ''; for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) x.searchParams.delete(k); return `${x.protocol}//${x.host.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`.toLowerCase(); } catch { return u.toLowerCase(); }
}
export const absUrl = (href: string, base: string): string | null => { try { const u = new URL(href, base); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export const rand = (a: number, b: number) => Math.floor(a + Math.random() * Math.max(0, b - a));

export async function waitFor<T>(fn: () => T | null | undefined | false, { timeout = 8000, interval = 250 } = {}): Promise<T | null> {
  const end = Date.now() + timeout;
  for (;;) { const v = fn(); if (v) return v as T; if (Date.now() > end) return null; await sleep(interval); }
}
