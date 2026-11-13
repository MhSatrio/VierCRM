// The research workflow engine: runs the lookup fields of a record in dependency order.
//
//   Full Name ─▶ Latest Publication ─▶ DOI / URL / Date / Access ─▶ PDF ─▶ Abstract ─▶ Keywords
//
// A lookup only fills an EMPTY cell (unless forced), never overwrites what you typed, and a downstream field never runs when its
// upstream field is empty – it is skipped with a message that names the missing field.
import * as DB from '../core/db';
import * as S from '../core/store';
import type { AttachmentFile, AttachmentValue, CellValue, Field, MatchCandidate, Publication, RecordMeta, RecordRow, SourceId } from '../core/types';
import { dependenciesOf, topologicalOrder } from '../core/deps';
import { cellText, isEmptyValue } from '../core/values';
import { fid } from '../core/defaults';
import type { Ctx } from './http';
import { decide, searchName, type Query } from './matching';
import { fetchAbstract, SOURCES, type Hit, type SearchOpts } from './sources';
import { findFullText } from './fulltext';
import { deriveKeywords } from './keywords';

export interface LookupReport { fieldId: string; fieldName: string; status: 'filled' | 'skipped' | 'needsMatch' | 'notFound' | 'error'; message: string; log?: string[] }
export interface LookupRun { record: RecordRow; reports: LookupReport[]; found: boolean }
export interface RunOpts { fieldIds?: string[]; force?: boolean; origin?: RecordMeta['origin']; choice?: { fieldId: string; candidate: MatchCandidate } }

export type SearchOutcome =
  | { status: 'found'; pub: Publication }
  | { status: 'ambiguous'; candidates: MatchCandidate[] }
  | { status: 'none'; errors: string[] };

const label = (id: SourceId) => ({ openalex: 'OpenAlex', crossref: 'Crossref', semanticscholar: 'Semantic Scholar', pubmed: 'PubMed', googlescholar: 'Google Scholar', researchgate: 'ResearchGate', repository: 'Repository', publisher: 'Publisher' }[id]);
const dateKey = (p: Publication) => p.date || String(p.year || '');

/** Search the configured sources in order; the first source that identifies the author with enough confidence wins. */
export async function searchPublication(ctx: Ctx, q: Query, sources: SourceId[], opts: SearchOpts): Promise<SearchOutcome> {
  const accept = ctx.settings.autoAcceptConfidence; const margin = ctx.settings.autoAcceptMargin;
  const errors: string[] = []; const ambiguous: MatchCandidate[] = [];
  for (const id of sources) {
    const src = SOURCES[id]; if (!src) continue;
    try {
      if (src.kind === 'author') {
        const cands = await src.candidates(ctx, q); const d = decide(cands, accept, margin);
        if (d.status === 'found') { const pub = await src.latest(ctx, d.pick, opts); if (pub) return { status: 'found', pub }; errors.push(`${label(id)}: found the author but no publication in the requested range`); }
        else if (d.status === 'ambiguous') ambiguous.push(...d.candidates);
      } else {
        const hits: Hit[] = await src.search(ctx, q, opts);
        const sure = hits.filter(h => h.confidence >= accept).sort((a, b) => dateKey(b.pub).localeCompare(dateKey(a.pub)));
        if (sure.length) return { status: 'found', pub: sure[0].pub };
        for (const h of hits.sort((a, b) => b.confidence - a.confidence || dateKey(b.pub).localeCompare(dateKey(a.pub))).slice(0, 4)) {
          if (h.confidence >= 0.3) ambiguous.push({ id: h.pub.doi || h.pub.sourceId || h.pub.title, name: h.pub.title, institution: [h.pub.venue, h.pub.year].filter(Boolean).join(' · '), confidence: h.confidence, reasons: h.reasons, source: id, url: h.pub.url, publication: h.pub });
        }
      }
    } catch (e: any) { errors.push(`${label(id)}: ${e?.message || e}`); }
    await ctx.sleep(ctx.settings.lookupDelayMs);
  }
  if (ambiguous.length) return { status: 'ambiguous', candidates: ambiguous.sort((a, b) => b.confidence - a.confidence).slice(0, 8) };
  return { status: 'none', errors };
}

/** The user picked one of the candidates: author-based candidates are resolved to that author's latest work. */
export async function resolveChoice(ctx: Ctx, cand: MatchCandidate, opts: SearchOpts): Promise<Publication | null> {
  const confirmed = { confidence: 1, reasons: ['chosen by you'] };
  if (cand.publication) return { ...cand.publication, authorMatch: { name: cand.name, id: cand.id, ...confirmed } };
  const src = SOURCES[cand.source]; if (!src || src.kind !== 'author') return null;
  const pub = await src.latest(ctx, cand, opts); return pub ? { ...pub, authorMatch: { name: cand.name, id: cand.id, institution: cand.institution, ...confirmed } } : null;
}

export function outputOf(pub: Publication, output: string): CellValue {
  switch (output) {
    case 'title': return pub.title || null;
    case 'year': return pub.year ?? null;
    case 'date': return pub.date || (pub.year ? String(pub.year) : null);
    case 'doi': return pub.doi || null;
    case 'url': return pub.url || (pub.doi ? `https://doi.org/${pub.doi}` : null);
    case 'authors': return pub.authors.join(', ') || null;
    case 'venue': return pub.venue || null;
    case 'abstract': return pub.abstract || null;
    case 'fullTextUrl': return pub.fullTextUrl || pub.pdfUrl || null;
    case 'access': return pub.access || null;
    case 'keywords': return deriveKeywords(pub).join(', ') || null;
    default: return null;
  }
}

const hasPdf = (v: CellValue) => !!v && typeof v === 'object' && !Array.isArray(v) && (v as AttachmentValue).files?.length > 0;

export async function runLookups(recordId: string, ctx: Ctx, opts: RunOpts = {}): Promise<LookupRun> {
  const rec0 = await S.getRecord(recordId); if (!rec0) throw new Error('Record not found');
  const fields = await S.listFields(rec0.tableId);
  const byId = new Map(fields.map(f => [f.id, f]));
  const cells: Record<string, CellValue> = { ...rec0.cells };
  const meta: RecordMeta = { ...(rec0.meta || {}), publications: { ...(rec0.meta?.publications || {}) }, pending: { ...(rec0.meta?.pending || {}) }, lookupErrors: { ...(rec0.meta?.lookupErrors || {}) } };
  const reports: LookupReport[] = []; let found = false;
  const blocked = new Set<string>();                 // fields whose upstream failed → everything below them is skipped
  const statusField = fields.find(f => f.type === 'publicationStatus');
  let status: string | null = null;

  const order = topologicalOrder(fields, f => !!f.lookup && (!opts.fieldIds || opts.fieldIds.includes(f.id)));
  // when specific fields are requested their upstream search must already have a stored result – otherwise they are skipped below

  const report = (f: Field, r: Omit<LookupReport, 'fieldId' | 'fieldName'>) => reports.push({ fieldId: f.id, fieldName: f.name, ...r });

  for (const id of order) {
    const f = byId.get(id)!; const l = f.lookup!;
    const filled = l.kind === 'pdf' ? hasPdf(cells[f.id]) : !isEmptyValue(cells[f.id]);
    const isChoice = opts.choice?.fieldId === f.id;
    if (filled && !opts.force && !isChoice) { report(f, { status: 'skipped', message: 'already has a value' }); continue; }

    // ---- dependencies
    const upstream = l.kind === 'search' ? null : byId.get(l.fromFieldId || '');
    const missing: string[] = [];
    if (l.kind === 'search') { const name = byId.get(l.nameFieldId || ''); if (!name || isEmptyValue(cells[name.id])) missing.push(name?.name || 'name field'); }
    else {
      if (!upstream) missing.push('the publication field');
      else if (blocked.has(upstream.id) || !meta.publications?.[upstream.id]) missing.push(upstream.name);
    }
    for (const d of l.dependsOn || []) { const df = byId.get(d); if (df && isEmptyValue(cells[df.id])) missing.push(df.name); }
    if (missing.length) { blocked.add(f.id); report(f, { status: 'skipped', message: `skipped – ${missing.map(m => `“${m}”`).join(', ')} is empty` }); continue; }

    const searchOpts: SearchOpts = { yearFrom: l.yearFrom, yearTo: l.yearTo, mustContain: l.mustContain };
    try {
      if (l.kind === 'search') {
        let pub: Publication | null = null;
        if (isChoice) { pub = await resolveChoice(ctx, opts.choice!.candidate, searchOpts); if (!pub) { report(f, { status: 'error', message: 'could not load that author’s publications' }); blocked.add(f.id); continue; } }
        else {
          const q: Query = { name: searchName(cellText(cells[l.nameFieldId!])), institution: l.institutionFieldId ? cellText(cells[l.institutionFieldId]) || undefined : undefined, profileUrl: [l.profileUrlFieldId ? cellText(cells[l.profileUrlFieldId]) : '', ...(rec0.meta?.scrape?.identifiers || [])].filter(Boolean).join(' ') || undefined, /* ORCID / Scholar links found on the profile are identity evidence */ keywords: l.keywordsFieldId ? cellText(cells[l.keywordsFieldId]).split(/[,;]/).map(s => s.trim()).filter(Boolean) : undefined };
          const out = await searchPublication(ctx, q, l.sources?.length ? l.sources : ['openalex', 'crossref'], searchOpts);
          if (out.status === 'ambiguous') { meta.pending![f.id] = { candidates: out.candidates, at: new Date().toISOString() }; status = 'Needs match'; blocked.add(f.id); report(f, { status: 'needsMatch', message: `${out.candidates.length} possible matches – choose the right one` }); continue; }
          if (out.status === 'none') { status = 'Not found'; blocked.add(f.id); const why = out.errors.length ? out.errors.join(' · ') : 'no publication found'; meta.lookupErrors![f.id] = why; report(f, { status: out.errors.length ? 'error' : 'notFound', message: why }); continue; }
          pub = out.pub;
        }
        delete meta.pending![f.id]; delete meta.lookupErrors![f.id];
        meta.publications![f.id] = pub; cells[f.id] = outputOf(pub, l.output); found = true; status = status ?? 'Found';
        report(f, { status: 'filled', message: `${pub.title} (${pub.year ?? 'n.d.'}) via ${label(pub.source as SourceId)}${pub.authorMatch ? ` · match ${Math.round(pub.authorMatch.confidence * 100)}%` : ''}` });
      } else {
        const pub = meta.publications![upstream!.id];
        if (l.kind === 'derive') {
          const v = outputOf(pub, l.output);
          if (v == null) { report(f, { status: 'notFound', message: `the publication has no ${l.output}` }); continue; }
          cells[f.id] = v; report(f, { status: 'filled', message: String(v).slice(0, 80) });
        } else if (l.kind === 'abstract') {
          let abs = pub.abstract;
          if (!abs && pub.doi) { abs = await fetchAbstract(ctx, pub.doi); if (abs) meta.publications![upstream!.id] = { ...pub, abstract: abs }; }
          if (!abs) { report(f, { status: 'notFound', message: pub.doi ? 'no abstract available from any source' : 'no DOI to look the abstract up with' }); continue; }
          cells[f.id] = abs; report(f, { status: 'filled', message: `${abs.length} characters` });
        } else if (l.kind === 'keywords') {
          const kws = deriveKeywords(pub); if (!kws.length) { report(f, { status: 'notFound', message: 'no keywords could be derived' }); continue; }
          cells[f.id] = kws.join(', '); report(f, { status: 'filled', message: kws.join(', ') });
        } else if (l.kind === 'pdf') {
          const ft = await findFullText(ctx, pub);
          meta.publications![upstream!.id] = { ...pub };
          if (ft.file) {
            const fileId = S.uid('file');
            await DB.put('files', { id: fileId, name: ft.file.name, mime: 'application/pdf', size: ft.file.size, data: ft.file.bytes });
            const af: AttachmentFile = { id: fileId, name: ft.file.name, size: ft.file.size, mime: 'application/pdf', title: pub.title, year: pub.year, venue: pub.venue, doi: pub.doi, sourceUrl: ft.file.sourceUrl, access: ft.file.access, addedAt: new Date().toISOString() };
            cells[f.id] = { files: [af] }; status = 'PDF attached'; delete meta.lookupErrors![f.id];
            report(f, { status: 'filled', message: `${ft.file.name} (${(ft.file.size / 1024).toFixed(0)} KB) · ${ft.file.access}`, log: ft.log });
          } else {
            cells[f.id] = { files: [], unavailable: 'Full text unavailable' }; if (status !== 'PDF attached') status = 'Full text unavailable';
            meta.lookupErrors![f.id] = ft.log.slice(-2).join(' · ');
            report(f, { status: 'notFound', message: 'Full text unavailable – metadata and links were saved', log: ft.log });
          }
        }
      }
    } catch (e: any) { blocked.add(f.id); meta.lookupErrors![f.id] = String(e?.message || e); report(f, { status: 'error', message: String(e?.message || e) }); }
    await ctx.sleep(ctx.settings.lookupDelayMs);
  }

  if (statusField && status && (reports.some(r => r.status !== 'skipped'))) cells[statusField.id] = status;
  const record = await S.updateRecord(recordId, cells, { origin: opts.origin, meta });
  return { record, reports, found };
}

/** Attach a PDF the user supplied (their own copy, or one they are authorised to hold). */
export async function attachUserPdf(recordId: string, fieldId: string, file: { name: string; bytes: ArrayBuffer }, origin?: RecordMeta['origin']): Promise<RecordRow> {
  const rec = await S.getRecord(recordId); if (!rec) throw new Error('Record not found');
  const f = (await S.listFields(rec.tableId)).find(x => x.id === fieldId); if (!f || f.type !== 'attachment') throw new Error('Choose an attachment field');
  const pub = Object.values(rec.meta?.publications || {})[0];
  const id = S.uid('file');
  await DB.put('files', { id, name: file.name, mime: 'application/pdf', size: file.bytes.byteLength, data: file.bytes });
  const prev = rec.cells[fieldId] as AttachmentValue | undefined;
  const af: AttachmentFile = { id, name: file.name, size: file.bytes.byteLength, mime: 'application/pdf', title: pub?.title, year: pub?.year, venue: pub?.venue, doi: pub?.doi, access: 'User provided', addedAt: new Date().toISOString() };
  const status = (await S.listFields(rec.tableId)).find(x => x.type === 'publicationStatus');
  return S.updateRecord(recordId, { [fieldId]: { files: [...(prev?.files || []), af] }, ...(status ? { [status.id]: 'PDF attached' } : {}) }, { origin });
}

export const getFile = (id: string) => DB.get<{ id: string; name: string; mime: string; size: number; data: ArrayBuffer }>('files', id);
void fid; void dependenciesOf;
