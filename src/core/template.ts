// E-mail / text templates.
//
//   Hi {First Name | fallback: Researcher},
//   [[I noticed your work on {Latest Research}.]]       ← an optional block: dropped entirely if any field inside is empty
//
// {Field}                     value of the field (empty when the record has none – never invented)
// {Field | fallback: text}    text is used when the field is empty
// [[ … ]]                     optional sentence(s)

export interface RenderResult { text: string; missing: string[]; unknown: string[]; usedFallback: string[] }

const TOKEN = /\{([^{}|]+?)(?:\|\s*fallback\s*:\s*([^{}]*))?\}/g;

/**
 * `lookup(name)` returns the value for a field name, or undefined when the table has no such field.
 * Empty / missing values with no fallback render as '' and are listed in `missing` so the preview can warn.
 */
export function renderTemplate(tpl: string, lookup: (name: string) => string | undefined): RenderResult {
  const missing = new Set<string>(); const unknown = new Set<string>(); const usedFallback = new Set<string>();
  const sub = (s: string, optional: boolean): { out: string; empty: boolean } => {
    let empty = false;
    const out = s.replace(TOKEN, (_m, rawName: string, fb?: string) => {
      const name = rawName.trim(); const v = lookup(name);
      if (v === undefined) { unknown.add(name); empty = true; return ''; }
      if (String(v).trim() !== '') return String(v);
      if (fb !== undefined) { if (!optional) usedFallback.add(name); return fb.trim(); }
      empty = true; if (!optional) missing.add(name); return '';
    });
    return { out, empty };
  };
  // optional blocks first
  // a dropped block takes its own line break with it, so no empty line is left behind
  const withBlocks = tpl.replace(/\[\[([\s\S]*?)\]\](\n?)/g, (_m, inner: string, nl: string) => { const r = sub(inner, true); return r.empty ? '' : r.out + nl; });
  const final = sub(withBlocks, false).out
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').replace(/ ([,.;:!?])/g, '$1').trim();
  return { text: final, missing: [...missing], unknown: [...unknown], usedFallback: [...usedFallback] };
}

/** Names used by a template (for validation against the table's fields). */
export function templateFields(tpl: string): string[] {
  const names = new Set<string>(); let m: RegExpExecArray | null; const re = new RegExp(TOKEN.source, 'g');
  while ((m = re.exec(tpl))) names.add(m[1].trim());
  return [...names];
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Plain-text template → simple HTML (paragraphs and line breaks, links made clickable). */
export function textToHtml(text: string): string {
  const linked = escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return linked.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** &amp; &#39; &#x2013; … → characters (the entities an e-mail body uses; unknown ones stay as they are). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m; }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/**
 * The plain-text version of an HTML e-mail (sent next to the HTML, and used by clients that show no HTML): line breaks at the ends of
 * blocks, list items with a bullet, a link as “text (address)”, tags and <style>/<script> removed, entities decoded.
 * Done with patterns rather than a DOM parser, so it also runs in the extension's service worker.
 */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, label: string) => {
      const t = decodeEntities(label.replace(/<[^>]+>/g, '')).trim();
      if (!t) return href;
      return /^mailto:/i.test(href) || href === '#' || t === href ? t : `${t} (${href})`;
    })
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A signature may be written as HTML or as plain text (its line breaks are kept). */
export const looksLikeHtml = (s: string) => /<\/?[a-z][^>]*>/i.test(s);
export const signatureHtml = (sig: string) => (looksLikeHtml(sig) ? sig : textToHtml(sig));
export const signatureText = (sig: string) => (looksLikeHtml(sig) ? htmlToText(sig) : sig.trim());

/** A whole HTML document (what a designer or an AI tool produces), not a plain message. */
export const isHtmlDocument = (s: string) => /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(s);

/** Removes what mail clients never run (scripts, frames, plug-ins, stylesheet links) and event-handler attributes; the rest is kept as written. */
export function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<(script|iframe|object|frameset|frame)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|frame)\b[^>]*>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/<link\b[^>]*rel\s*=\s*["']?stylesheet[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, '$1="#"');
}

/** What mail apps will not do with this HTML, so the designer can fix it before sending (the preview shows what is left after removal). */
export function emailHtmlWarnings(html: string): string[] {
  const w: string[] = [];
  if (/tailwind/i.test(html)) w.push('Tailwind is a script that mail apps never run, so its classes do nothing in an e-mail. Give the layout inline style="…" attributes.');
  else if (/\sclass\s*=/i.test(html)) w.push('class="…" only works with a stylesheet that the mail app loads, and most do not. Give the layout inline style="…" attributes.');
  if (/<svg\b/i.test(html)) w.push('Inline SVG icons are removed: Gmail and Outlook do not show them.');
  if (/<script\b/i.test(html)) w.push('Scripts are removed: mail apps do not run JavaScript (for example a copy-link button).');
  if (/<button\b/i.test(html)) w.push('A <button> does nothing in an e-mail. Use a link styled as a button: <a href="…" style="…">.');
  if (/<link\b[^>]*stylesheet/i.test(html)) w.push('External stylesheets are removed.');
  return w;
}
