// CSS selector generation for the "select an element and map it to a field" picker.
import { clean, text } from './dom';

const stable = (c: string) => c && !/^(js-|is-|has-|active|selected|hover|focus|open|show|hidden|visible|odd|even|first|last|current)/i.test(c) && !/\d{3,}|^[a-z]{1,2}-[a-z0-9]{5,}$|^_|^css-|^sc-|^jsx-/i.test(c) && c.length < 40;

export function cssEscape(s: string): string { return s.replace(/([^a-zA-Z0-9_-])/g, '\\$1').replace(/^(\d)/, '\\3$1 '); }

const part = (el: Element, withNth: boolean): string => {
  const tag = el.tagName.toLowerCase(); if (el.id && !/\d{4,}/.test(el.id)) return `${tag}#${cssEscape(el.id)}`;
  const classes = Array.from(el.classList).filter(stable).slice(0, 2).map(c => `.${cssEscape(c)}`).join('');
  let s = `${tag}${classes}`;
  if (withNth && !classes) { const sibs = el.parentElement ? Array.from(el.parentElement.children).filter(x => x.tagName === el.tagName) : []; if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(el) + 1})`; }
  return s;
};

/** The shortest selector that matches exactly this element (up to 5 levels). */
export function uniqueSelector(el: Element): string {
  const doc = el.ownerDocument; const chain: string[] = []; let cur: Element | null = el;
  for (let depth = 0; cur && cur !== doc.documentElement && depth < 5; depth++, cur = cur.parentElement) {
    chain.unshift(part(cur, true)); const sel = chain.join(' > ');
    try { const m = doc.querySelectorAll(sel); if (m.length === 1 && m[0] === el) return sel; } catch { /* keep climbing */ }
  }
  return chain.join(' > ');
}

/** A selector that matches this element AND its look-alikes (the other cards / rows), by dropping positional parts. */
export function genericSelector(el: Element): string {
  const doc = el.ownerDocument; const parts: string[] = []; let cur: Element | null = el;
  for (let depth = 0; cur && cur !== doc.body && depth < 3; depth++, cur = cur.parentElement) {
    parts.unshift(part(cur, false)); const sel = parts.join(' ');
    try { const n = doc.querySelectorAll(sel).length; if (n >= 1 && (depth >= 1 || /[.#]/.test(parts[0]))) return sel; } catch { /* next */ }
  }
  return parts.join(' ');
}

export interface PickResult { selector: string; generic: string; matches: number; genericMatches: number; sample: string; tag: string; href?: string }
export function describePick(el: Element): PickResult {
  const doc = el.ownerDocument; const selector = uniqueSelector(el); const generic = genericSelector(el);
  const count = (s: string) => { try { return doc.querySelectorAll(s).length; } catch { return 0; } };
  return { selector, generic, matches: count(selector), genericMatches: count(generic), sample: clean(text(el)).slice(0, 160), tag: el.tagName.toLowerCase(), href: el.getAttribute('href') || undefined };
}
