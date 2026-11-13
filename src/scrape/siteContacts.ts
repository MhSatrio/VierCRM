// Contact details from a business's OWN website: Google Maps never shows an e-mail address, but the company's site usually does –
// on the home page or on its contact page. Runs in the background service worker (no DOM there), so everything here works on the HTML text:
// mailto: links, Cloudflare-protected addresses, entity-obfuscated and "name [at] domain" addresses, JSON-LD, tel:/WhatsApp links, social links.
//
// Polite by design: the home page, then at most two contact pages, only when no address was found yet; one request at a time; a timeout; no
// sign-in, no form submissions; nothing is guessed – what the page does not say stays empty.
import { decodeCfEmail, deobfuscate } from './extract';

export interface SiteContacts {
  /** every address found, best first */
  emails: string[]; best: string;
  phones: string[]; whatsapp: string[];
  socials: { network: string; url: string }[];
  pagesRead: string[]; error?: string;
}
export interface SiteDeps { fetch(url: string, init?: RequestInit): Promise<Response>; sleep?(ms: number): Promise<void>; timeoutMs?: number }

const EMAIL = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const JUNK_DOMAIN = /(?:^|[.@])(?:example|domain|yourdomain|email|test|sentry|sentry-next|wixpress|wix|godaddy|schema|w3|jquery|bootstrap|cloudflare|googleapis|gstatic|facebook|fb|instagram|twitter|linkedin|youtube|wordpress|gravatar|squarespace|shopify|mailchimp|your-?site)\.[a-z.]+$/i;
const JUNK_LOCAL = /^(?:user|name|your-?name|your-?email|email|test|username|mail|example|someone|nama|namaanda|emailanda)$/i;
const FILE_EXT = /\.(?:png|jpe?g|gif|webp|svg|css|js|woff2?|ttf|ico|avif|bmp|mp4|pdf)$/i;
export const SOCIAL_HOST = /(?:^|\.)(?:facebook|fb|instagram|twitter|x|linkedin|youtube|youtu|tiktok|wa|whatsapp|t|telegram|linktr|lnk|bio|taplink|beacons|wixsite)\.[a-z.]+$/i;

export function decodeEntities(s: string): string {
  return s.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&commat;/gi, '@').replace(/&period;/gi, '.').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
}

export const registrable = (host: string): string => {
  const h = host.toLowerCase().replace(/^www\./, ''); const p = h.split('.');
  if (p.length >= 3 && /^(?:co|com|net|org|or|ac|go|web|sch|biz|my|gov|edu)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
};
const FREE_MAIL = /@(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|icloud|msn|aol|proton(?:mail)?|mail)\./i;
const ROLE = /^(?:info|sales|contact|hello|enquir\w*|inquir\w*|marketing|cs|customer\w*|admin|office|business|booking|reservation\w*|cargo|export|import|operations?|ops|hi|halo|kontak|marketing)$/i;

/** Valid-looking addresses only; the site's own domain first, then role mailboxes (info@, sales@ …), then free-mail, then order of appearance. */
export function rankEmails(found: string[], siteHost: string): string[] {
  const seen = new Set<string>(); const list: string[] = [];
  for (const raw of found) { const e = raw.trim().toLowerCase().replace(/[.,;:)>\]]+$/, ''); const [local, dom] = e.split('@'); if (!dom || !local || seen.has(e) || FILE_EXT.test(e) || JUNK_DOMAIN.test(dom) || JUNK_LOCAL.test(local) || /\.(?:png|jpe?g|gif)$/i.test(dom) || /^\d+x$|^u00/.test(local)) continue; seen.add(e); list.push(e); }
  const own = siteHost ? registrable(siteHost) : '';
  const score = (e: string, i: number) => (own && registrable(e.split('@')[1]) === own ? 8 : 0) + (ROLE.test(e.split('@')[0]) ? 3 : 0) - (FREE_MAIL.test(e) ? 1 : 0) - i * 0.01;
  return list.map((e, i) => [e, score(e, i)] as const).sort((a, b) => b[1] - a[1]).map(x => x[0]);
}

const NETWORKS: [string, RegExp][] = [
  ['Facebook', /^(?:[\w-]+\.)?facebook\.com\/(?!sharer|share|plugins|dialog|tr[/?]|login|policy|help|events\/|groups\/|v\d|hashtag)([^?#\s]+)/i],
  ['Instagram', /^(?:www\.)?instagram\.com\/(?!p\/|explore|accounts|reel|share|tv\/)([\w.]+)/i],
  ['LinkedIn', /^(?:[\w-]+\.)?linkedin\.com\/(?:company|in|school)\/([^/?#\s]+)/i],
  ['X', /^(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home|search|i\/|hashtag)(\w+)/i],
  ['YouTube', /^(?:www\.)?youtube\.com\/(?:@|channel\/|c\/|user\/)([^/?#\s]+)/i],
  ['TikTok', /^(?:www\.)?tiktok\.com\/@([\w.]+)/i],
];

export interface ParsedSite { emails: string[]; phones: string[]; whatsapp: string[]; socials: { network: string; url: string }[]; contactLinks: string[] }

/** Everything useful in one HTML page. `baseUrl` resolves relative links (the page's final address). */
export function parseSiteHtml(htmlIn: string, baseUrl: string): ParsedSite {
  const out: ParsedSite = { emails: [], phones: [], whatsapp: [], socials: [], contactLinks: [] };
  const html = decodeEntities(htmlIn.length > 1_500_000 ? htmlIn.slice(0, 1_500_000) : htmlIn);
  const addMail = (s: string) => { const m = s.match(new RegExp(EMAIL.source, 'i')); if (m && !out.emails.includes(m[0].toLowerCase())) out.emails.push(m[0].toLowerCase()); };
  const addPhone = (s: string) => { const n = s.replace(/%20/g, ' ').replace(/[^\d+()\s.-]/g, '').trim(); const d = n.replace(/\D/g, ''); if (d.length >= 7 && d.length <= 15 && !out.phones.includes(n)) out.phones.push(n); };
  const addWa = (digits: string) => { const d = digits.replace(/\D/g, ''); if (d.length >= 8 && d.length <= 15 && !out.whatsapp.includes(`+${d}`)) out.whatsapp.push(`+${d}`); };

  // structured data first
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (typeof n.email === 'string') addMail(n.email.replace(/^mailto:/i, '')); if (typeof n.telephone === 'string') addPhone(n.telephone); for (const k of ['sameAs']) for (const u of ([] as string[]).concat(n[k] || [])) if (typeof u === 'string') addSocial(u); Object.values(n).forEach(walk); };
      walk(JSON.parse(m[1]));
    } catch { /* not valid JSON */ }
  }
  function addSocial(href: string) {
    let u: URL; try { u = new URL(href, baseUrl); } catch { return; } if (!/^https?:$/.test(u.protocol)) return;
    const wa = u.hostname.replace(/^www\./, '') === 'wa.me' ? u.pathname.slice(1) : /whatsapp\.com$/.test(u.hostname) ? (u.searchParams.get('phone') || '') : '';
    if (wa) { addWa(wa); return; }
    const hp = `${u.hostname.replace(/^www\./, '')}${u.pathname}`;
    for (const [network, re] of NETWORKS) if (re.test(hp) &&!out.socials.some(s => s.network === network)) { out.socials.push({ network, url: `https://${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}` }); break; }
  }

  // links
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim(); const label = decodeEntities(m[4].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (/^mailto:/i.test(href)) { try { addMail(decodeURIComponent(href.slice(7).split('?')[0])); } catch { addMail(href.slice(7)); } continue; }
    if (/^tel:/i.test(href)) { addPhone(decodeURIComponent(href.slice(4))); continue; }
    if (/^whatsapp:/i.test(href)) { addWa(href.split('phone=')[1] || ''); continue; }
    if (/cdn-cgi\/l\/email-protection#/i.test(href)) { try { addMail(decodeCfEmail(href.split('#')[1])); } catch { /* ignore */ } continue; }
    if (/^https?:|^\/\//i.test(href)) addSocial(href);
    if (/contact|kontak|hubungi|get-in-touch|enquir|connect-with|contacto|contactez|kontakt/i.test(`${href} ${label}`) && !/^(?:#|javascript:|mailto:|tel:)/i.test(href)) {
      try { const u = new URL(href, baseUrl); if (registrable(u.hostname) === registrable(new URL(baseUrl).hostname) && !FILE_EXT.test(u.pathname)) { u.hash = ''; const s = u.href; if (!out.contactLinks.includes(s)) out.contactLinks.push(s); } } catch { /* ignore */ }
    }
  }
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) { try { addMail(decodeCfEmail(m[1])); } catch { /* ignore */ } }
  for (const m of html.matchAll(/data-(?:email|mail)=["']([^"']+)["']/gi)) addMail(deobfuscate(m[1]));

  // visible text (scripts and styles removed): plain and "name [at] domain [dot] com" addresses, and wa.me numbers written out
  const textOnly = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ').replace(/<[^>]+>/g, ' ');
  for (const m of deobfuscate(textOnly).matchAll(EMAIL)) addMail(m[0]);
  for (const m of html.matchAll(/(?:wa\.me\/|api\.whatsapp\.com\/send\?[^"'\s]*phone=|wa\.me\/message\/)(\+?\d{8,15})/gi)) addWa(m[1]);
  return out;
}

async function getHtml(url: string, deps: SiteDeps): Promise<{ html: string; finalUrl: string } | null> {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 9000);
  try {
    const res = await deps.fetch(url, { signal: ctl.signal, credentials: 'omit', redirect: 'follow', headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' } });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || ''; if (ct && !/html|xml|text\/plain/i.test(ct)) return null;
    const buf = (await res.arrayBuffer()).slice(0, 1_500_000);
    let charset = ct.match(/charset=([\w-]+)/i)?.[1]; if (!charset) charset = new TextDecoder('ascii').decode(buf.slice(0, 2048)).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || 'utf-8';
    let html: string; try { html = new TextDecoder(charset).decode(buf); } catch { html = new TextDecoder('utf-8').decode(buf); }
    return { html, finalUrl: res.url || url };
  } catch { return null; } finally { clearTimeout(timer); }
}

/** Find e-mail, phone, WhatsApp and social links of a business from its website. Never throws. */
export async function siteContacts(url: string, deps: SiteDeps): Promise<SiteContacts> {
  const nap = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const res: SiteContacts = { emails: [], best: '', phones: [], whatsapp: [], socials: [], pagesRead: [] };
  let host = ''; try { const u = new URL(url); host = u.hostname; if (!/^https?:$/.test(u.protocol)) return { ...res, error: 'not a web address' }; } catch { return { ...res, error: 'not a web address' }; }
  const merge = (p: ParsedSite) => {
    for (const e of p.emails) if (!res.emails.includes(e)) res.emails.push(e);
    for (const x of p.phones) if (!res.phones.includes(x)) res.phones.push(x);
    for (const x of p.whatsapp) if (!res.whatsapp.includes(x)) res.whatsapp.push(x);
    for (const s of p.socials) if (!res.socials.some(y => y.network === s.network)) res.socials.push(s);
  };
  // a Facebook / Instagram / link-in-bio page is not a company site: keep it as a social link, do not crawl it
  if (SOCIAL_HOST.test(host)) { const p = parseSiteHtml(`<a href="${url}">x</a>`, url); res.socials = p.socials.length ? p.socials : [{ network: host.replace(/^www\./, ''), url }]; res.error = 'the listed website is a social page'; return res; }

  const home = await getHtml(url, deps);
  if (!home) { res.error = 'the website did not answer'; return res; }
  res.pagesRead.push(home.finalUrl); const parsed = parseSiteHtml(home.html, home.finalUrl); merge(parsed);
  if (!rankEmails(res.emails, host).length) {
    const origin = (() => { try { return new URL(home.finalUrl).origin; } catch { return ''; } })();
    const tries = (parsed.contactLinks.length ? parsed.contactLinks : ['/contact', '/contact-us', '/kontak'].map(p => origin + p)).slice(0, 2);
    for (const t of tries) {
      if (res.pagesRead.includes(t)) continue; await nap(600);
      const page = await getHtml(t, deps); if (!page) continue; res.pagesRead.push(page.finalUrl); merge(parseSiteHtml(page.html, page.finalUrl));
      if (rankEmails(res.emails, host).length) break;
    }
  }
  res.emails = rankEmails(res.emails, host); res.best = res.emails[0] || '';
  return res;
}
