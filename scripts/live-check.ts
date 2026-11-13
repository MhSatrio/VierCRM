// Read-only check of the PUBLIC research APIs with the real adapters (no API keys, no personal data: a well-known public author is searched).
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { openAlex, openAlexByDoi, crossref, pubmed, semanticScholar } from '../src/research/sources';
import { decide } from '../src/research/matching';
import { findFullText } from '../src/research/fulltext';
import type { Ctx } from '../src/research/http';

const ctx: Ctx = { fetch: (u, i) => fetch(u, i), settings: { ...DEFAULT_SETTINGS, unpaywallEmail: '', lookupDelayMs: 0 }, secrets: {}, sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => new Date() };
const q = { name: 'Geoffrey Hinton', institution: 'University of Toronto' };
const t0 = Date.now(); const out: Record<string, string> = {};
const run = async (name: string, fn: () => Promise<string>) => { try { out[name] = await fn(); } catch (e: any) { out[name] = `ERROR ${e.message}`; } console.log(`${name}: ${out[name]}`); };
await run('OpenAlex authors', async () => { const c = await openAlex.candidates(ctx, q); const d = decide(c); return `${c.length} candidates; top ${c[0]?.name} @ ${c[0]?.institution} (${Math.round((c[0]?.confidence ?? 0) * 100)}%) → ${d.status}`; });
await run('OpenAlex latest work', async () => { const c = await openAlex.candidates(ctx, q); const d = decide(c); if (d.status !== 'found') return `author not auto-accepted (${d.status})`; const p = await openAlex.latest(ctx, d.pick, {}); return p ? `"${p.title.slice(0, 70)}" ${p.date ?? p.year} doi=${p.doi} access=${p.access}` : 'no work'; });
await run('Crossref', async () => { const h = await crossref.search(ctx, { name: 'Geoffrey Hinton' }, { yearFrom: 2020 }); return `${h.length} hits; first "${h[0]?.pub.title?.slice(0, 60)}" ${h[0]?.pub.date} doi=${h[0]?.pub.doi}`; });
await run('PubMed', async () => { const h = await pubmed.search(ctx, { name: 'Hinton G' }, { yearFrom: 2020 }); return `${h.length} hits; first "${h[0]?.pub.title?.slice(0, 60)}" ${h[0]?.pub.year}`; });
await run('Semantic Scholar authors', async () => { const c = await semanticScholar.candidates(ctx, q); return `${c.length} candidates; top ${c[0]?.name} (${c[0]?.worksCount} papers)`; });
await run('OpenAlex by DOI + abstract', async () => { const w = await openAlexByDoi(ctx, '10.1038/nature14539'); return w ? `"${w.pub.title}" abstract ${w.pub.abstract ? w.pub.abstract.length + ' chars' : 'none'}; oa=${w.pub.access}` : 'not found'; });
await run('Full-text finder (arXiv paper)', async () => { const r = await findFullText(ctx, { title: 'Attention Is All You Need', year: 2017, doi: '10.48550/arxiv.1706.03762', authors: ['Ashish Vaswani'], source: 'openalex' }); return r.file ? `PDF ${(r.file.size / 1024).toFixed(0)} KB from ${r.file.sourceUrl} (${r.file.access})` : `no PDF: ${r.log.join(' | ')}`; });
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
