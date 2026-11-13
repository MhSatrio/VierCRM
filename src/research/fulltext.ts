// Finding a LEGAL full text. Order: links the source already gave → Unpaywall → OpenAlex locations → Europe PMC → arXiv → the
// publisher / repository landing page (citation_pdf_url, optionally with YOUR browser session when you enabled institutional access).
//
// What this never does: use Sci-Hub or any shadow library, or get past a paywall / login. A candidate is accepted ONLY if the server
// really returns a PDF (the bytes start with "%PDF"); a login page or an HTML landing page is rejected. When nothing works the
// publication keeps its metadata and links and the field says "Full text unavailable".
import type { Publication } from '../core/types';
import { apiBase, cleanDoi, enc, getJson, getText, type Ctx } from './http';
import { openAlexByDoi } from './sources';

export interface FoundPdf { bytes: ArrayBuffer; name: string; size: number; sourceUrl: string; access: string }
export interface FullTextResult { file?: FoundPdf; log: string[]; landingUrl?: string; access?: string }

const isPdf = (b: ArrayBuffer) => { const h = new Uint8Array(b.slice(0, 1024)); for (let i = 0; i + 4 < h.length; i++) if (h[i] === 0x25 && h[i + 1] === 0x50 && h[i + 2] === 0x44 && h[i + 3] === 0x46 && h[i + 4] === 0x2d) return true; return false; };
const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56);

export function pdfFileName(pub: Pick<Publication, 'title' | 'year' | 'authors'>): string {
  const last = (pub.authors[0] || 'paper').split(/\s+/).pop() || 'paper';
  return `${slug(last)}_${pub.year || 'n-d'}_${slug(pub.title) || 'publication'}.pdf`;
}

export async function downloadPdf(ctx: Ctx, url: string, { credentials = false }: { credentials?: boolean } = {}): Promise<{ bytes: ArrayBuffer } | { reason: string }> {
  let res: Response;
  try { res = await ctx.fetch(url, { redirect: 'follow', credentials: credentials ? 'include' : 'omit', headers: { accept: 'application/pdf,*/*;q=0.5' } }); }
  catch (e: any) { return { reason: `could not be reached (${e?.message || 'network error'})` }; }
  if (!res.ok) return { reason: `HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' – access restricted' : ''}` };
  const max = ctx.settings.maxPdfMb * 1024 * 1024;
  const len = Number(res.headers.get('content-length')); if (len && len > max) return { reason: `larger than ${ctx.settings.maxPdfMb} MB` };
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > max) return { reason: `larger than ${ctx.settings.maxPdfMb} MB` };
  if (!isPdf(bytes)) return { reason: 'not a PDF (a login or landing page)' };
  return { bytes };
}

const metaPdf = (html: string) => {
  const m = html.match(/<meta[^>]+name=["']citation_pdf_url["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']citation_pdf_url["']/i);
  return m ? m[1].replace(/&amp;/g, '&') : undefined;
};
const abs = (u: string, base: string) => { try { return new URL(u, base).href; } catch { return u; } };

export async function findFullText(ctx: Ctx, pub: Publication): Promise<FullTextResult> {
  const log: string[] = []; const doi = cleanDoi(pub.doi);
  const tried = new Set<string>();
  const candidates: { url: string; access: string; via: string; credentials?: boolean }[] = [];
  const add = (url: string | undefined, access: string, via: string, credentials = false) => { if (url && !tried.has(url)) { tried.add(url); candidates.push({ url, access, via, credentials }); } };

  add(pub.pdfUrl, pub.access || 'Open access', `link from ${pub.source}`);

  if (doi) {
    // Unpaywall
    if (ctx.settings.unpaywallEmail) {
      try {
        const base = apiBase(ctx, 'unpaywall', 'https://api.unpaywall.org');
        const r = await getJson(ctx, `${base}/v2/${enc(doi)}?email=${enc(ctx.settings.unpaywallEmail)}`);
        const locs = [r.best_oa_location, ...(r.oa_locations || [])].filter(Boolean);
        for (const l of locs) add(l.url_for_pdf, `Open access (${l.host_type === 'repository' ? 'repository' : r.oa_status || 'publisher'})`, 'Unpaywall');
        log.push(`Unpaywall: ${r.is_oa ? `open access (${r.oa_status})` : 'no open-access copy known'}`);
        if (!pub.fullTextUrl && r.best_oa_location?.url) pub.fullTextUrl = r.best_oa_location.url;
      } catch (e: any) { log.push(`Unpaywall: ${e.message}`); }
    } else log.push('Unpaywall skipped – add your e-mail in Settings (Unpaywall requires one).');

    // OpenAlex locations
    try {
      const w = await openAlexByDoi(ctx, doi);
      for (const l of w?.raw?.locations || []) add(l.pdf_url, `Open access (${l.is_oa ? 'repository' : 'publisher'})`, 'OpenAlex');
      if (w?.raw?.open_access?.oa_url && /\.pdf($|\?)/i.test(w.raw.open_access.oa_url)) add(w.raw.open_access.oa_url, 'Open access', 'OpenAlex');
      if (!pub.fullTextUrl && w?.raw?.open_access?.oa_url) pub.fullTextUrl = w.raw.open_access.oa_url;
    } catch (e: any) { log.push(`OpenAlex: ${e.message}`); }

    // Europe PMC
    try {
      const base = apiBase(ctx, 'europepmc', 'https://www.ebi.ac.uk/europepmc/webservices/rest');
      const r = await getJson(ctx, `${base}/search?query=${enc(`DOI:"${doi}"`)}&format=json&resultType=core`);
      const list = r.resultList?.result?.[0]?.fullTextUrlList?.fullTextUrl || [];
      for (const l of list) if (/pdf/i.test(l.documentStyle || '') && /^(OA|F)$/i.test(l.availabilityCode || '')) add(l.url, 'Open access (Europe PMC)', 'Europe PMC');
    } catch (e: any) { log.push(`Europe PMC: ${e.message}`); }

    const ax = doi.match(/^10\.48550\/arxiv\.(.+)$/i); if (ax) add(`https://arxiv.org/pdf/${ax[1]}`, 'Open access (arXiv)', 'arXiv');
  }

  // landing page of the publication itself (publisher or institutional repository)
  const landing = pub.fullTextUrl || pub.url || (doi ? `https://doi.org/${doi}` : undefined);
  let landingTried = false;
  const tryLanding = async () => {
    if (!landing || landingTried) return; landingTried = true;
    try {
      const html = await getText(ctx, landing, { redirect: 'follow', credentials: ctx.settings.institutionalAccess ? 'include' : 'omit', headers: { accept: 'text/html' } });
      const m = metaPdf(html); if (m) add(abs(m, landing), pub.access?.startsWith('Open') ? pub.access : ctx.settings.institutionalAccess ? 'Publisher (your institutional access)' : 'Publisher / repository', 'landing page', ctx.settings.institutionalAccess);
      else log.push('Landing page lists no PDF link.');
    } catch (e: any) { log.push(`Landing page: ${e.message}`); }
  };

  const attempt = async (): Promise<FullTextResult | null> => {
    for (const c of candidates.splice(0)) {
      const r = await downloadPdf(ctx, c.url, { credentials: c.credentials });
      if ('bytes' in r) {
        log.push(`✓ PDF from ${c.via}`);
        return { log, landingUrl: landing, access: c.access, file: { bytes: r.bytes, name: pdfFileName(pub), size: r.bytes.byteLength, sourceUrl: c.url, access: c.access } };
      }
      log.push(`${c.via}: ${r.reason}`);
    }
    return null;
  };

  const first = await attempt(); if (first) return first;
  await tryLanding();
  const second = await attempt(); if (second) return second;
  log.push('No legally accessible PDF was found. You can open the publication page, or attach a PDF you are allowed to use yourself.');
  return { log, landingUrl: landing, access: pub.access };
}
