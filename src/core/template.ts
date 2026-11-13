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
