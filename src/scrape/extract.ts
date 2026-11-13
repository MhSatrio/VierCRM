// Reading ONE researcher out of a card or a profile page. Structured data first (JSON-LD, microdata-style labels), then headings and
// labelled rows, then plain patterns (e-mail, phone). Whatever is not on the page stays empty – nothing is guessed.
//
// Explicit field mappings (CSS selector or "xpath:…") from the scraping configuration are applied FIRST and always win.
import type { FieldMapping, ScrapeConfig } from '../core/types';
import { fid } from '../core/defaults';
import { absUrl, clean, lines, qs, qsa, text } from './dom';
import { DEPT_RE_EXPORT, looksLikeName, TITLE_RE } from './detect';

export interface Extracted { values: Record<string, string>; found: string[]; publicationLinks: string[]; identifiers: string[]; /** every "Label: value" pair on the page */ pairs: [string, string][] }
export interface ExtractCtx { url: string; scope: 'card' | 'profile'; nameHint?: string; kind?: 'people' | 'items' }

// ------------------------------------------------------------------ e-mail / phone
const GENERIC_MAIL = /(^|[._-])(info|contact|admin|office|webmaster|support|noreply|no-reply|secretar[a-z]*|sekretariat|helpdesk|enquir[a-z]*|reception|hr|jobs|press|media|mail|hello|postmaster|library|registrar|admissions?|communications?|general|dean|department|faculty|school|group|team)([._-]|@)/i;
const MAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

/** Cloudflare "email protection": <a data-cfemail="hex"> where the first byte is the XOR key. */
export function decodeCfEmail(hex: string): string { const k = parseInt(hex.slice(0, 2), 16); let s = ''; for (let i = 2; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k); return s; }

export function deobfuscate(t: string): string {
  return t.replace(/\s*[\[({]\s*(at|ät)\s*[\])}]\s*|\s+(at|AT)\s+(?=[\w-]+(\s*[\[({]?\s*(dot|DOT)\s*[\])}]?|\.)\s*[\w-]+)/g, '@')
    .replace(/\s*[\[({]\s*(dot|punkt)\s*[\])}]\s*|\s+(dot|DOT)\s+/gi, '.');
}

/** Links like <a href="#" data-md5="bWFpbHRvOmEuYkBjLmVk…"> carry the address base64-encoded ("mailto:a.b@c.edu"); a script fills in the visible text later. */
export function decodeBase64Mail(value: string): string {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(value)) return '';
  try { const t = typeof atob === 'function' ? atob(value) : Buffer.from(value, 'base64').toString('binary'); return /^mailto:/i.test(t) ? t.replace(/^mailto:/i, '').split('?')[0].trim() : ''; } catch { return ''; }
}

export function findEmails(root: Element | Document): string[] {
  const out: string[] = []; const add = (s: string) => { const e = s.trim().toLowerCase().replace(/[.,;:)>\]]+$/, ''); if (/^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) && !out.includes(e)) out.push(e); };
  const scope = (root as Document).body || (root as Element);
  for (const a of qsa(scope, 'a[href^="mailto:" i]')) add(decodeURIComponent((a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0]));
  for (const el of qsa(scope, '[data-cfemail]')) add(decodeCfEmail(el.getAttribute('data-cfemail') || ''));
  for (const el of qsa(scope, '[data-email]')) add(el.getAttribute('data-email') || '');
  for (const a of qsa(scope, 'a:not([href^="mailto:" i])')) for (const at of Array.from(a.attributes)) if (at.name.startsWith('data-')) { const m = decodeBase64Mail(at.value); if (m) add(m); }
  const t = text(scope);
  for (const m of deobfuscate(t).matchAll(MAIL_RE)) add(m[0]);
  return out;
}

/** Choose the person's own address: not a generic role mailbox, and – when several – the one that resembles the name. */
export function pickEmail(emails: string[], name: string): string {
  const personal = emails.filter(e => !GENERIC_MAIL.test(e)); if (!personal.length) return '';
  const toks = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(prof|dr|drs|ir|ph\.?d)\b\.?/g, ' ').split(/[^a-z]+/).filter(t => t.length > 1);
  const score = (e: string) => { const l = e.split('@')[0].normalize('NFKD').replace(/[^a-z]/gi, '').toLowerCase(); return toks.filter(t => l.includes(t)).length * 2 + (toks.some(t => l.startsWith(t[0]) && l.includes(toks[toks.length - 1] || '')) ? 1 : 0); };
  return [...personal].sort((a, b) => score(b) - score(a))[0];
}

const PHONE_RE = /(?:\+|00)?\d[\d\s().\-–]{5,18}\d/g;
export function findPhone(root: Element | Document): string {
  const scope = (root as Document).body || (root as Element);
  for (const a of qsa(scope, 'a[href^="tel:" i]')) { const n = clean(decodeURIComponent((a.getAttribute('href') || '').replace(/^tel:/i, ''))); if (digits(n) >= 7) return n; }
  const ls = lines(scope); const LABEL = /\b(tel|phone|telephone|telefon|téléphone|t:|ph\.?|mobile|mob\.?|office|bureau|直通)\b/i;
  const number = (s: string) => { const m = s.match(PHONE_RE); const n = m && clean(m[0]); return n && digits(n) >= 7 && digits(n) <= 15 && !/^\d{4}[-–]\d{4}$/.test(n) ? n : ''; };
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i]; if (!LABEL.test(line) || /\bfax\b/i.test(line)) continue;
    const same = number(line.replace(LABEL, ' ')); if (same) return same;
    if (line.length <= 24 && ls[i + 1] && !/\bfax\b/i.test(ls[i + 1]) && ls[i + 1].length < 40) { const next = number(ls[i + 1]); if (next) return next; }   // "Phone" / "+31 20 …" as dt / dd
  }
  return '';
}
const digits = (s: string) => s.replace(/\D/g, '').length;

// ------------------------------------------------------------------ structured data
function jsonLdEntity(doc: Document, types: string[]): any | null {
  for (const s of qsa(doc, 'script[type="application/ld+json"]')) {
    try {
      const walk = (n: any): any | null => {
        if (!n || typeof n !== 'object') return null;
        if (Array.isArray(n)) { for (const x of n) { const r = walk(x); if (r) return r; } return null; }
        const t = ([] as string[]).concat(n['@type'] || []);
        if (types.some(x => t.includes(x))) return n;
        return walk(n['@graph']) || walk(n.mainEntity) || walk(n.author) || null;
      };
      const p = walk(JSON.parse(s.textContent || 'null')); if (p) return p;
    } catch { /* malformed JSON-LD is common – ignore */ }
  }
  return null;
}
const jsonLdPerson = (doc: Document) => jsonLdEntity(doc, ['Person']);
const nm = (v: any): string => (typeof v === 'string' ? v : v && (v.name || v['@id']) || '');

// ------------------------------------------------------------------ headings and sections
const HEADING = 'h1,h2,h3,h4,h5,h6,summary,dt,[role="heading"]';
function sectionAfter(root: Element | Document, re: RegExp): Element[] {
  const scope = (root as Document).body || (root as Element);
  const heads = qsa(scope, `${HEADING}, strong, b, .heading, [class*="heading" i], [class*="section-title" i]`).filter(h => { const t = clean(text(h)); return t.length > 2 && t.length < 60 && re.test(t); });
  for (const h of heads) {
    const out: Element[] = []; const level = /^H[1-6]$/.test(h.tagName) ? Number(h.tagName[1]) : 9;
    let n: Element | null = h;
    // headings are often wrapped: <div class="section"><h3>Biography</h3></div><div>…text…</div> → continue from the wrapper's siblings
    if (!n.nextElementSibling && n.parentElement && n.parentElement !== scope) n = n.parentElement;
    if (h.tagName === 'DT') { const dd = h.nextElementSibling; if (dd && dd.tagName === 'DD') return [dd]; }
    for (let s = n.nextElementSibling; s && out.length < 12; s = s.nextElementSibling) {
      if (new RegExp(`^H[1-${Math.min(6, level)}]$`).test(s.tagName) || (s.matches?.(HEADING) && level <= 6)) break;
      if (/^(strong|b)$/i.test(h.tagName) && s.matches?.('strong,b')) break;
      out.push(s);
    }
    if (out.length) return out;
  }
  return [];
}

function labelled(root: Element | Document, re: RegExp): string {
  const scope = (root as Document).body || (root as Element);
  for (const dt of qsa(scope, 'dt, th')) { const k = clean(text(dt)).replace(/:$/, ''); if (re.test(k) && k.length < 40) { const v = dt.nextElementSibling; if (v && /^(DD|TD)$/.test(v.tagName)) { const t = clean(text(v)); if (t) return t; } } }
  for (const l of lines(scope)) { const m = l.match(/^([^:]{3,32}):\s*(.{2,200})$/); if (m && re.test(m[1].trim())) return clean(m[2]); }
  for (const el of qsa(scope, '[class*="label" i], [class*="field-name" i]')) { const k = clean(text(el)).replace(/:$/, ''); if (re.test(k) && k.length < 40) { const v = el.nextElementSibling; const t = clean(text(v)); if (t) return t; } }
  return '';
}

/** Every "Label: value" the page shows (definition lists, table rows, "Label: value" lines) – a field whose NAME equals the label is filled from it. */
export function labelledPairs(root: Element | Document, max = 40): [string, string][] {
  const scope = (root as Document).body || (root as Element); const out: [string, string][] = []; const seen = new Set<string>();
  const add = (k: string, v: string) => { const key = clean(k).replace(/:$/, '').trim(); const val = clean(v); if (key.length < 2 || key.length > 40 || !val || val.length > 400 || seen.has(key.toLowerCase()) || out.length >= max) return; seen.add(key.toLowerCase()); out.push([key, val]); };
  for (const dt of qsa(scope, 'dt')) { const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') add(text(dt), text(dd)); }
  for (const tr of qsa(scope, 'tr')) { const c = [...tr.children]; if (c.length === 2 && c[0].tagName === 'TH' || (c.length === 2 && c[0].tagName === 'TD' && text(c[0]).length < 40)) add(text(c[0]), text(c[1])); }
  for (const l of lines(scope)) { const m = l.match(/^([^:]{2,32}):\s*(.{1,300})$/); if (m && !/^https?$/i.test(m[1])) add(m[1], m[2]); }
  return out;
}
const SOCIAL = /(facebook|twitter|x|linkedin|instagram|youtube|tiktok|pinterest|wa|whatsapp|t)\.(com|me)\/|maps\.google|goo\.gl\/maps|google\.[a-z.]+\/maps|play\.google|apps\.apple/i;
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const withScheme = (u: string) => (/^[a-z]+:\/\//i.test(u) ? u : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(u) ? `https://${u}` : '');

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);

// ------------------------------------------------------------------ mappings
function xpath(root: Node, expr: string, doc: Document): Element[] {
  try { const r = doc.evaluate(expr, root, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null); const out: Element[] = []; for (let i = 0; i < r.snapshotLength; i++) { const n = r.snapshotItem(i); if (n && n.nodeType === 1) out.push(n as Element); else if (n) out.push((n as Attr).ownerElement || (n.parentElement as Element)); } return out; } catch { return []; }
}
export function evalMapping(root: Element | Document, m: FieldMapping, baseUrl: string): string {
  const doc = (root as Document).nodeType === 9 ? (root as Document) : (root as Element).ownerDocument;
  let els = m.selector.startsWith('xpath:') ? xpath(root, m.selector.slice(6), doc) : qsa(root, m.selector);
  if (!m.multiple) els = els.slice(0, 1);
  const vals: string[] = [];
  for (const el of els) {
    let v = '';
    switch (m.extract) {
      case 'attr': v = clean(el.getAttribute(m.attr || 'title')); break;
      case 'href': v = absUrl(el.getAttribute('href') || '', baseUrl) || ''; break;
      case 'email': v = pickEmail(findEmails(el), '') || findEmails(el)[0] || ''; break;
      case 'phone': v = findPhone(el); break;
      case 'html': v = lines(el).join('\n'); break;
      default: v = clean(text(el));
    }
    if (v && m.regex) { try { const r = new RegExp(m.regex, 'i').exec(v); v = r ? clean(r[1] ?? r[0]) : ''; } catch { v = ''; } }
    if (v) vals.push(v);
  }
  return vals.join(m.join ?? ', ');
}

const ID_LINK = /orcid\.org\/\d{4}-|scholar\.google\.[a-z.]+\/citations\?[^"']*user=|researchgate\.net\/profile\/|semanticscholar\.org\/author\/|openalex\.org\/(A\d+|authors)|scopus\.com\/authid|publons\.com\/researcher|webofscience\.com\/wos\/author/i;
const PUB_LINK = /doi\.org\/10\.|pubmed\.ncbi\.nlm\.nih\.gov\/\d|ncbi\.nlm\.nih\.gov\/pubmed|sciencedirect\.com\/science\/article|link\.springer\.com\/(article|chapter)|onlinelibrary\.wiley\.com\/doi|nature\.com\/articles|arxiv\.org\/abs|ieeexplore\.ieee\.org\/document|tandfonline\.com\/doi|researchgate\.net\/publication/i;

// ------------------------------------------------------------------ the extractor
export function extractPerson(root: Element | Document, cfg: Pick<ScrapeConfig, 'mappings' | 'autoDetect' | 'defaults'>, ctx: ExtractCtx): Extracted {
  const values: Record<string, string> = {}; const set = (k: string, v: string | undefined | null) => { const t = clean(v); if (t && !values[k]) values[k] = t; };
  const doc = (root as Document).nodeType === 9 ? (root as Document) : (root as Element).ownerDocument;
  const profile = ctx.scope === 'profile';
  const scope = (root as Document).body || (root as Element);

  // 1) the user's explicit mappings win
  for (const m of cfg.mappings) if (m.from === ctx.scope) { const v = evalMapping(root, m, ctx.url); if (v) values[m.fieldId] = v; }

  const ad = cfg.autoDetect; const items = ctx.kind === 'items';
  const ld = profile ? (items ? jsonLdEntity(doc, ['Organization', 'LocalBusiness', 'Corporation', 'Product', 'Store', 'ProfessionalService']) : jsonLdPerson(doc)) : null;

  // 2) name
  if (ad.name && !values[fid('fullName')]) {
    const cand = [nm(ld?.name) || '', ...(profile ? qsa(scope, 'h1').map(h => clean(text(h))) : []), ctx.nameHint || '', clean(doc.querySelector?.('meta[property="og:title"]')?.getAttribute('content')).split(/\s[|–—-]\s/)[0], clean(doc.title).split(/\s[|–—-]\s/)[0]];
    const n = items ? [nm(ld?.name), ctx.scope === 'card' ? ctx.nameHint || '' : '', ...(profile ? qsa(scope, 'h1').map(h => clean(text(h))) : []), ctx.nameHint || '', cand[cand.length - 2], cand[cand.length - 1]].find(c => c && c.length >= 2 && c.length <= 90) : cand.find(c => c && looksLikeName(c)); if (n) set(fid('fullName'), n);
  }
  const personName = values[fid('fullName')] || ctx.nameHint || '';

  // 3) e-mail and phone
  if (ad.email && !values[fid('email')]) set(fid('email'), (items ? pickEmail(findEmails(root), personName) || findEmails(root)[0] : pickEmail(findEmails(root), personName)) || (ld?.email ? String(ld.email).replace(/^mailto:/i, '') : ''));
  if (ad.phone && !values[fid('phone')]) set(fid('phone'), (ld?.telephone ? clean(ld.telephone) : '') || findPhone(root));

  // 4) position, department, institution (people) – or website, industry, size, location (companies and anything else)
  if (items) {
    const here = hostOf(ctx.url);
    const lbl = labelled(root, /^(website|web ?site|web|homepage|url|site)$/i);
    const ext = qsa(scope, 'a[href^="http" i]').map(a => ({ h: absUrl(a.getAttribute('href') || '', ctx.url) || '', t: clean(text(a)) })).filter(x => x.h && !SOCIAL.test(x.h) && hostOf(x.h) !== here);
    const ldUrl = ld?.url && hostOf(String(ld.url)) !== here ? String(ld.url) : '';
    set(fid('website'), withScheme(lbl) || ldUrl || ext.find(x => /website|web site|homepage|visit|www\./i.test(x.t))?.h || '');
    set(fid('industry'), labelled(root, /^(industry|sector|category|categories|type|specialt(y|ies))$/i));
    set(fid('size'), labelled(root, /^(size|employees|company size|number of employees|headcount|staff)$/i));
    const adr = ld?.address; set(fid('location'), labelled(root, /^(location|address|headquarters|hq|city|based in)$/i) || (adr ? (typeof adr === 'string' ? adr : [adr.streetAddress, adr.addressLocality, adr.addressRegion].filter(Boolean).join(', ')) : ''));
    set(fid('country'), labelled(root, /^(country|nation)$/i) || (adr && typeof adr === 'object' ? nm(adr.addressCountry) : ''));
    if (profile && ad.biography) { const md = clean(doc.querySelector?.('meta[name="description"]')?.getAttribute('content') || doc.querySelector?.('meta[property="og:description"]')?.getAttribute('content')); set(fid('about'), clip(clean(ld?.description) || (md.length >= 30 ? md : '') || sectionAfter(root, /^(about( us)?|overview|profile|description|company profile)$/i).map(e => clean(text(e))).filter(t => t.length > 25).slice(0, 2).join('\n\n'), 1500)); }
  }
  if (!items && ad.position && !values[fid('position')]) {
    let p = clean(ld?.jobTitle) || labelled(root, /^(position|title|job title|role|rank|designation|functie|stelling|funktion|poste)$/i);
    if (!p) { const el = qsa(scope, '[class*="job-title" i],[class*="jobtitle" i],[class*="position" i],[class*="designation" i],[class*="role" i],[class*="title" i]').map(e => clean(text(e))).find(t => t && t.length < 120 && TITLE_RE.test(t) && !looksLikeName(t)); if (el) p = el; }
    if (!p) { const ls = lines(scope); const at = personName ? ls.findIndex(l => l.includes(personName.replace(/^(prof|dr)\.?\s+/i, '').split(' ')[0])) : -1; p = ls.slice(Math.max(0, at), Math.max(0, at) + 8).find(l => TITLE_RE.test(l) && l.length < 100 && !/@/.test(l) && !looksLikeName(l)) || ''; }
    set(fid('position'), p);
  }
  if (!items && ad.institution && !values[fid('department')] && ad.position) {
    const d = labelled(root, /^(department|dept\.?|faculty|school|unit|group|division|section|institute|afdeling|vakgroep|fachbereich|abteilung)$/i)
      || qsa(scope, '[class*="department" i],[class*="faculty" i],[class*="school" i],[class*="unit" i]').map(e => clean(text(e))).find(t => t && t.length < 120 && !/@/.test(t))
      || lines(scope).find(l => DEPT_RE_EXPORT.test(l) && l.length < 100 && !/@/.test(l) && !TITLE_RE.test(l)) || '';
    set(fid('department'), d);
  }
  if (!items && ad.institution && !values[fid('institution')] && profile) {
    const org = nm(ld?.worksFor) || nm(ld?.affiliation);
    const og = clean(doc.querySelector?.('meta[property="og:site_name"]')?.getAttribute('content'));
    const t = clean(doc.title).split(/\s[|–—-]\s/).slice(1).map(clean).find(x => /universit|institut|college|school|hospital|laborator|centre|center|academy|polytechnic|universiteit|université|universität|hochschule/i.test(x));
    set(fid('institution'), labelled(root, /^(institution|university|affiliation|organi[sz]ation|employer)$/i) || org || t || og);
  }

  // 5) biography and research interests (profile pages only)
  if (profile && !items) {
    if (ad.biography && !values[fid('about')]) {
      let bio = ld?.description ? clean(ld.description) : '';
      if (!bio) { const sec = sectionAfter(root, /^(biography|bio|about( me| the researcher)?|profile|overview|background|short bio|personal statement|curriculum vitae|cv|introduction)$/i); bio = sec.map(e => clean(text(e))).filter(t => t.length > 25).slice(0, 3).join('\n\n'); }
      if (!bio) { const md = clean(doc.querySelector?.('meta[name="description"]')?.getAttribute('content') || doc.querySelector?.('meta[property="og:description"]')?.getAttribute('content')); const last = personName.split(' ').pop()?.toLowerCase(); if (md.length >= 80 && last && md.toLowerCase().includes(last)) bio = md; }
      set(fid('about'), clip(bio, 1500));
    }
    if (!values[fid('researchKeywords')]) {
      let kw = labelled(root, /^(research (interests?|areas?|topics?|focus|fields?)|areas? of (research|expertise)|expertise|keywords|specialis[a-z]+|interests?|research)$/i);
      if (!kw) { const sec = sectionAfter(root, /^(research (interests?|areas?|topics?|focus|fields?)|areas? of (research|expertise)|expertise|keywords|specialis[a-z]+|research interests? and expertise)$/i); const items = sec.flatMap(e => (e.tagName === 'UL' || e.tagName === 'OL' ? qsa(e, 'li').map(li => clean(text(li))) : [clean(text(e))])).filter(Boolean); kw = items.join(', '); }
      if (!kw && ld?.knowsAbout) kw = ([] as any[]).concat(ld.knowsAbout).map(nm).filter(Boolean).join(', ');
      set(fid('researchKeywords'), clip(kw.replace(/\s*[;•·|]\s*/g, ', '), 400));
    }
  }

  // defaults the user set for this site (e.g. Institution = "Example University") fill what the page did not say
  for (const [k, v] of Object.entries(cfg.defaults || {})) if (v && !values[k] && ctx.scope === 'profile') values[k] = v;

  // 6) identity evidence + publication links
  const publicationLinks: string[] = []; const identifiers: string[] = [];
  if (profile && !items) {
    for (const a of qsa(scope, 'a[href]')) { const h = absUrl(a.getAttribute('href') || '', ctx.url); if (!h) continue; if (ID_LINK.test(h) && !identifiers.includes(h)) identifiers.push(h); else if (PUB_LINK.test(h) && !publicationLinks.includes(h)) publicationLinks.push(h); }
    const sec = sectionAfter(root, /^(selected |recent |latest |key )?(publications?|papers|articles|selected works)$/i);
    for (const e of sec) for (const a of qsa(e, 'a[href]')) { const h = absUrl(a.getAttribute('href') || '', ctx.url); if (h && !ID_LINK.test(h) && !publicationLinks.includes(h) && !/^mailto:/i.test(h)) publicationLinks.push(h); }
    for (const s of ([] as any[]).concat(ld?.sameAs || [])) if (typeof s === 'string' && ID_LINK.test(s) && !identifiers.includes(s)) identifiers.push(s);
  }
  return { values, found: Object.keys(values), publicationLinks: publicationLinks.slice(0, 8), identifiers: identifiers.slice(0, 6), pairs: labelledPairs(root) };
}
