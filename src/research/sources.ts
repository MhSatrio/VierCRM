// Publication sources. Two kinds:
//   AuthorSource      – can list WHO the author might be (with ids), then fetch that author's latest work   (OpenAlex, Semantic Scholar)
//   PublicationSource – searches works by author name and checks the author list of every hit            (Crossref, PubMed, Google Scholar, ResearchGate)
import type { MatchCandidate, Publication, SourceId } from '../core/types';
import { apiBase, cleanDoi, enc, getJson, getText, stripTags, year, type Ctx } from './http';
import { scoreAuthor, type Query } from './matching';

export interface SearchOpts { yearFrom?: number; yearTo?: number; mustContain?: string }
export type { Query };

export interface AuthorSource { kind: 'author'; id: SourceId; candidates(ctx: Ctx, q: Query): Promise<MatchCandidate[]>; latest(ctx: Ctx, cand: MatchCandidate, opts: SearchOpts): Promise<Publication | null> }
export interface Hit { pub: Publication; confidence: number; reasons: string[] }
export interface PublicationSource { kind: 'publication'; id: SourceId; search(ctx: Ctx, q: Query, opts: SearchOpts): Promise<Hit[]> }
export type Source = AuthorSource | PublicationSource;

const accessLabel = (status?: string) => ({ gold: 'Open access (gold)', green: 'Open access (repository)', hybrid: 'Open access (hybrid)', bronze: 'Free to read (bronze)', diamond: 'Open access (diamond)', closed: 'Closed access' } as Record<string, string>)[status || ''] || undefined;
const iso = (y?: number, m?: number, d?: number) => (y ? `${y}${m ? `-${String(m).padStart(2, '0')}${d ? `-${String(d).padStart(2, '0')}` : ''}` : ''}` : undefined);

/** newest first; works with a full date, a year-month or only a year */
const byDateDesc = (a: Publication, b: Publication) => (b.date || String(b.year || '')).localeCompare(a.date || String(a.year || ''));

function passes(p: Publication, opts: SearchOpts): boolean {
  if (opts.yearFrom && p.year && p.year < opts.yearFrom) return false;
  if (opts.yearTo && p.year && p.year > opts.yearTo) return false;
  if (opts.mustContain) { const hay = `${p.title} ${p.abstract || ''} ${(p.keywords || []).join(' ')}`.toLowerCase(); if (!opts.mustContain.toLowerCase().split(/[,;]+/).map(s => s.trim()).filter(Boolean).some(w => hay.includes(w))) return false; }
  return true;
}

// ================================================================== OpenAlex
const OA_WORK_SELECT = 'id,doi,title,display_name,publication_year,publication_date,type,primary_location,best_oa_location,open_access,authorships,abstract_inverted_index,keywords,topics';

function invertedToText(inv: Record<string, number[]> | null | undefined): string | undefined {
  if (!inv) return undefined; const words: string[] = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w;
  return words.filter(Boolean).join(' ') || undefined;
}

export function openAlexWork(w: any): Publication {
  const best = w.best_oa_location || {}; const prim = w.primary_location || {};
  const pdf = best.pdf_url || (w.open_access?.oa_url && /\.pdf($|\?)/i.test(w.open_access.oa_url) ? w.open_access.oa_url : undefined);
  return {
    title: String(w.display_name || w.title || '').trim(), year: w.publication_year || year(w.publication_date), date: w.publication_date || undefined,
    doi: cleanDoi(w.doi), url: prim.landing_page_url || (w.doi ? `https://doi.org/${cleanDoi(w.doi)}` : w.id),
    authors: (w.authorships || []).map((a: any) => a.author?.display_name).filter(Boolean), venue: prim.source?.display_name || undefined,
    abstract: invertedToText(w.abstract_inverted_index), pdfUrl: pdf, fullTextUrl: best.landing_page_url || w.open_access?.oa_url || undefined,
    access: accessLabel(w.open_access?.oa_status), keywords: [...(w.keywords || []).map((k: any) => k.display_name || k.keyword), ...(w.topics || []).slice(0, 3).map((t: any) => t.display_name)].filter(Boolean).slice(0, 8),
    source: 'openalex', sourceId: w.id,
  };
}

export const openAlex: AuthorSource = {
  kind: 'author', id: 'openalex',
  async candidates(ctx, q) {
    const base = apiBase(ctx, 'openalex', 'https://api.openalex.org');
    const r = await getJson(ctx, `${base}/authors?search=${enc(q.name)}&per-page=10`);
    return (r.results || []).map((a: any): MatchCandidate => {
      const inst = [...(a.last_known_institutions || []), a.last_known_institution].filter(Boolean).map((i: any) => i.display_name);
      const topics = (a.topics || a.x_concepts || []).slice(0, 8).map((t: any) => t.display_name);
      const s = scoreAuthor(q, { names: [a.display_name, ...(a.display_name_alternatives || [])], institutions: inst, topics, ids: [a.orcid, a.id] });
      return { id: String(a.id).replace('https://openalex.org/', ''), name: a.display_name, institution: inst[0], worksCount: a.works_count, topics: topics.slice(0, 4), orcid: a.orcid || undefined, confidence: s.confidence, reasons: s.reasons, source: 'openalex', url: a.id };
    });
  },
  async latest(ctx, cand, opts) {
    const base = apiBase(ctx, 'openalex', 'https://api.openalex.org');
    const f = [`author.id:${cand.id}`, opts.yearFrom ? `from_publication_date:${opts.yearFrom}-01-01` : '', opts.yearTo ? `to_publication_date:${opts.yearTo}-12-31` : ''].filter(Boolean).join(',');
    const r = await getJson(ctx, `${base}/works?filter=${f}&sort=publication_date:desc&per-page=25&select=${OA_WORK_SELECT}`);
    const works = (r.results || []).filter((w: any) => !['erratum', 'paratext', 'retraction'].includes(w.type)).map(openAlexWork).filter((p: Publication) => p.title && passes(p, opts));
    const pub = works.sort(byDateDesc)[0]; if (!pub) return null;
    return { ...pub, authorMatch: { name: cand.name, id: cand.id, institution: cand.institution, confidence: cand.confidence, reasons: cand.reasons } };
  },
};

/** Look one work up by DOI (used for abstracts and full-text locations). */
export async function openAlexByDoi(ctx: Ctx, doi: string): Promise<{ pub: Publication; raw: any } | null> {
  const base = apiBase(ctx, 'openalex', 'https://api.openalex.org');
  try { const w = await getJson(ctx, `${base}/works/https://doi.org/${enc(doi)}`); return { pub: openAlexWork(w), raw: w }; } catch { return null; }
}

// ================================================================== Crossref
function crossrefItem(it: any): Publication {
  const dp: number[] = (it.issued?.['date-parts'] || it['published-print']?.['date-parts'] || it['published-online']?.['date-parts'] || [[]])[0] || [];
  const lic = (it.license || []).map((l: any) => String(l.URL || '')).find((u: string) => /creativecommons/i.test(u));
  const pdfLink = (it.link || []).find((l: any) => /pdf/i.test(l['content-type'] || '') && l['intended-application'] !== 'similarity-checking');
  return {
    title: stripTags((it.title || [])[0] || ''), year: dp[0], date: iso(dp[0], dp[1], dp[2]), doi: cleanDoi(it.DOI), url: it.URL, venue: (it['container-title'] || [])[0],
    authors: (it.author || []).map((a: any) => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean),
    abstract: it.abstract ? stripTags(it.abstract) : undefined, access: lic ? 'Open access (licensed)' : 'Publisher (access not confirmed)', pdfUrl: lic && pdfLink ? pdfLink.URL : undefined, source: 'crossref', sourceId: it.DOI,
  };
}

export const crossref: PublicationSource = {
  kind: 'publication', id: 'crossref',
  async search(ctx, q, opts) {
    const base = apiBase(ctx, 'crossref', 'https://api.crossref.org');
    const from = opts.yearFrom ? `,from-pub-date:${opts.yearFrom}` : ''; const until = opts.yearTo ? `,until-pub-date:${opts.yearTo}` : '';
    // Crossref's author query is fuzzy relevance search: sorting it by date returns the newest papers of anyone with a similar surname.
    // So fetch the best-matching works, VERIFY the author list of each, and only then pick the latest.
    const url = base + '/works?query.author=' + enc(q.name) + (q.institution ? '&query.affiliation=' + enc(q.institution) : '') + '&rows=100&filter=type:journal-article' + from + until + '&select=DOI,title,author,issued,container-title,URL,abstract,license,link,published-print,published-online';
    const r = await getJson(ctx, url);
    const hits: Hit[] = [];
    for (const it of r.message?.items || []) {
      const pub = crossrefItem(it); if (!pub.title || !passes(pub, opts)) continue;
      let best: { confidence: number; reasons: string[] } = { confidence: 0, reasons: [] };
      for (const a of it.author || []) {
        const nm = [a.given, a.family].filter(Boolean).join(' ');
        const s = scoreAuthor(q, { names: [nm], institutions: (a.affiliation || []).map((x: any) => x.name), ids: [a.ORCID] });
        if (s.confidence > best.confidence) { best = s; pub.authorMatch = { name: nm, id: a.ORCID, institution: a.affiliation?.[0]?.name, confidence: s.confidence, reasons: s.reasons }; }
      }
      if (best.confidence > 0) hits.push({ pub, ...best });
    }
    return hits;
  },
};

// ================================================================== Semantic Scholar
export const semanticScholar: AuthorSource = {
  kind: 'author', id: 'semanticscholar',
  async candidates(ctx, q) {
    const base = apiBase(ctx, 'semanticscholar', 'https://api.semanticscholar.org');
    const headers: Record<string, string> = ctx.secrets.semanticScholarKey ? { 'x-api-key': ctx.secrets.semanticScholarKey } : {};
    const r = await getJson(ctx, `${base}/graph/v1/author/search?query=${enc(q.name)}&limit=10&fields=name,affiliations,paperCount,externalIds,url`, { headers });
    return (r.data || []).map((a: any): MatchCandidate => {
      const s = scoreAuthor(q, { names: [a.name], institutions: a.affiliations || [], ids: [a.externalIds?.ORCID, a.authorId] });
      return { id: String(a.authorId), name: a.name, institution: (a.affiliations || [])[0], worksCount: a.paperCount, orcid: a.externalIds?.ORCID, confidence: s.confidence, reasons: s.reasons, source: 'semanticscholar', url: a.url };
    });
  },
  async latest(ctx, cand, opts) {
    const base = apiBase(ctx, 'semanticscholar', 'https://api.semanticscholar.org');
    const headers: Record<string, string> = ctx.secrets.semanticScholarKey ? { 'x-api-key': ctx.secrets.semanticScholarKey } : {};
    const r = await getJson(ctx, `${base}/graph/v1/author/${enc(cand.id)}/papers?limit=100&fields=title,year,publicationDate,externalIds,venue,url,abstract,openAccessPdf,authors,isOpenAccess,publicationVenue`, { headers });
    const pubs: Publication[] = (r.data || []).map((p: any): Publication => ({
      title: p.title || '', year: p.year, date: p.publicationDate || undefined, doi: cleanDoi(p.externalIds?.DOI), url: p.url, authors: (p.authors || []).map((a: any) => a.name), venue: p.venue || p.publicationVenue?.name || undefined,
      abstract: p.abstract || undefined, pdfUrl: p.openAccessPdf?.url, fullTextUrl: p.openAccessPdf?.url, access: p.isOpenAccess ? 'Open access' : undefined, source: 'semanticscholar', sourceId: p.paperId,
    })).filter((p: Publication) => p.title && passes(p, opts));
    const pub = pubs.sort(byDateDesc)[0]; if (!pub) return null;
    return { ...pub, authorMatch: { name: cand.name, id: cand.id, institution: cand.institution, confidence: cand.confidence, reasons: cand.reasons } };
  },
};

// ================================================================== PubMed (NCBI E-utilities)
export const pubmed: PublicationSource = {
  kind: 'publication', id: 'pubmed',
  async search(ctx, q, opts) {
    const base = apiBase(ctx, 'pubmed', 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils');
    const term = `"${q.name}"[Author]${q.institution ? ` AND "${q.institution}"[Affiliation]` : ''}${opts.yearFrom || opts.yearTo ? ` AND ${opts.yearFrom || 1900}:${opts.yearTo || 3000}[dp]` : ''}`;
    const s = await getJson(ctx, `${base}/esearch.fcgi?db=pubmed&retmode=json&sort=pub+date&retmax=15&term=${enc(term)}`);
    const ids: string[] = s.esearchresult?.idlist || []; if (!ids.length) return [];
    const r = await getJson(ctx, `${base}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`);
    const hits: Hit[] = [];
    for (const id of ids) {
      const it = r.result?.[id]; if (!it) continue;
      const doi = cleanDoi((it.articleids || []).find((x: any) => x.idtype === 'doi')?.value);
      const sort = String(it.sortpubdate || '').slice(0, 10).replace(/\//g, '-');
      const pub: Publication = { title: stripTags(String(it.title || '')).replace(/\.$/, ''), year: year(it.pubdate), date: /^\d{4}-\d{2}-\d{2}$/.test(sort) ? sort : undefined, doi, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`, authors: (it.authors || []).map((a: any) => a.name), venue: it.fulljournalname || it.source, source: 'pubmed', sourceId: id };
      if (!pub.title || !passes(pub, opts)) continue;
      let best: { confidence: number; reasons: string[] } = { confidence: 0, reasons: [] };
      for (const a of pub.authors) {
        const sc = scoreAuthor({ ...q, institution: undefined }, { names: [a], institutions: [] });
        if (sc.confidence > best.confidence) best = sc;
      }
      if (!best.confidence) continue;
      // PubMed has no author ids and its affiliation filter matches ANY co-author, so the affiliation only counts as weak evidence
      if (q.institution) { best = { confidence: Math.min(1, best.confidence + 0.2), reasons: [...best.reasons, 'affiliation filter matched (any co-author)'] }; }
      pub.authorMatch = { name: q.name, confidence: best.confidence, reasons: best.reasons };
      hits.push({ pub, ...best });
    }
    return hits;
  },
};

// ================================================================== Google Scholar / ResearchGate (rendered pages in YOUR browser)
export interface RenderedHit { title: string; url?: string; authors?: string; venue?: string; year?: number; snippet?: string; pdfUrl?: string }

function renderedSource(id: 'googlescholar' | 'researchgate', extractor: 'scholar' | 'researchgate', buildUrl: (ctx: Ctx, q: Query, opts: SearchOpts) => string): PublicationSource {
  return {
    kind: 'publication', id,
    async search(ctx, q, opts) {
      if (!ctx.renderPage) throw new Error(`${id === 'googlescholar' ? 'Google Scholar' : 'ResearchGate'} is read through a tab in your own browser – run this lookup from the extension, not from a script.`);
      const result: any = await ctx.renderPage(buildUrl(ctx, q, opts), extractor);
      if (result?.blocked) throw new Error(`${id === 'googlescholar' ? 'Google Scholar' : 'ResearchGate'} is asking for a human check (${result.blocked}). Open the page, solve it yourself, then retry – VierCRM never bypasses it.`);
      const hits: Hit[] = [];
      for (const h of (result?.hits || []) as RenderedHit[]) {
        const authors = (h.authors || '').split(/,\s*/).map(s => s.replace(/…|\.\.\./g, '').trim()).filter(Boolean);
        const pub: Publication = { title: h.title, year: h.year, url: h.url, authors, venue: h.venue, abstract: h.snippet, pdfUrl: h.pdfUrl, source: id };
        if (!pub.title || !passes(pub, opts)) continue;
        let best = { confidence: 0, reasons: [] as string[] };
        for (const a of authors) { const sc = scoreAuthor({ ...q, institution: undefined }, { names: [a], institutions: [] }); if (sc.confidence > best.confidence) best = sc; }
        if (!best.confidence) continue;
        pub.authorMatch = { name: q.name, confidence: best.confidence, reasons: [...best.reasons, 'name only – no author id on a results page'] };
        hits.push({ pub, ...best });
      }
      return hits;
    },
  };
}
export const googleScholar = renderedSource('googlescholar', 'scholar', (ctx, q, o) => `${apiBase(ctx, 'scholar', 'https://scholar.google.com')}/scholar?q=${enc(`author:"${q.name}"${q.institution ? ` ${q.institution}` : ''}`)}&scisbd=1&hl=en${o.yearFrom ? `&as_ylo=${o.yearFrom}` : ''}${o.yearTo ? `&as_yhi=${o.yearTo}` : ''}`);
export const researchGate = renderedSource('researchgate', 'researchgate', (ctx, q) => `${apiBase(ctx, 'researchgate', 'https://www.researchgate.net')}/search/publication?q=${enc(`${q.name}${q.institution ? ` ${q.institution}` : ''}`)}`);

export const SOURCES: Record<string, Source> = { openalex: openAlex, crossref, semanticscholar: semanticScholar, pubmed, googlescholar: googleScholar, researchgate: researchGate };

// ================================================================== abstracts by DOI (Crossref → Semantic Scholar → PubMed → OpenAlex)
export async function fetchAbstract(ctx: Ctx, doi: string): Promise<string | undefined> {
  const tries: (() => Promise<string | undefined>)[] = [
    async () => (await openAlexByDoi(ctx, doi))?.pub.abstract,
    async () => { const base = apiBase(ctx, 'crossref', 'https://api.crossref.org'); const r = await getJson(ctx, `${base}/works/${enc(doi)}`); return r.message?.abstract ? stripTags(r.message.abstract) : undefined; },
    async () => { const base = apiBase(ctx, 'semanticscholar', 'https://api.semanticscholar.org'); const r = await getJson(ctx, `${base}/graph/v1/paper/DOI:${enc(doi)}?fields=abstract`, { headers: (ctx.secrets.semanticScholarKey ? { 'x-api-key': ctx.secrets.semanticScholarKey } : {}) as Record<string, string> }); return r.abstract || undefined; },
  ];
  for (const t of tries) { try { const a = await t(); if (a && a.length > 40) return a; } catch { /* next source */ } }
  return undefined;
}
void getText;
