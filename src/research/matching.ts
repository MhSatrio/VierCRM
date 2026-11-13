// Who is this author? A matching NAME is never proof of identity. Candidates are scored on name, institution and identifiers (ORCID /
// profile ids), and a candidate is only chosen automatically when it is clearly the best AND confident enough – otherwise the user picks.
import type { MatchCandidate } from '../core/types';

const TITLE_WORDS = /\b(prof|professor|dr|drs|ir|mr|mrs|ms|assoc|assistant|associate|emeritus|phd|msc|md|dipl|ing)\b\.?/gi;
const STOP_INST = new Set(['university', 'universiteit', 'universitat', 'universität', 'universite', 'université', 'universidad', 'universitas', 'of', 'the', 'de', 'la', 'le', 'du', 'des', 'der', 'van', 'von', 'for', 'and', 'institute', 'institut', 'college', 'school', 'faculty', 'department', 'dept', 'centre', 'center', 'national', 'state', 'research', 'sciences', 'science', 'technology', 'technical', 'tech', 'at', 'in']);

/** The name as an author index knows it: no honorifics, degrees or bracketed notes ("Prof. Dr. Anna Example, PhD" → "Anna Example"). */
export function searchName(raw: string): string {
  let s = raw.replace(/\([^)]*\)/g, ' ').replace(/,\s*(ph\.?d\.?|m\.?d\.?|msc|m\.sc\.?|mba|dr\.?.*|prof\.?.*)$/i, '');
  for (let k = 0; k < 5; k++) s = s.replace(/^\s*(prof(essor)?|dr|drs|ir|mr|mrs|ms|mx|assoc|assistant|associate|emeritus|dipl|ing|habil|apl)\b\.?[\s,]+/i, '');
  return s.replace(/\s+/g, ' ').trim() || raw.trim();
}

export const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function nameTokens(name: string): string[] {
  let s = fold(name).replace(TITLE_WORDS, ' ');
  if (/^[^,]+,[^,]+$/.test(s.trim())) { const [last, first] = s.split(','); s = `${first} ${last}`; }          // "Lovelace, Ada" → "ada lovelace"
  return s.replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).map(t => t.replace(/^[-']+|[-']+$/g, '')).filter(Boolean);
}

/** 0 … 0.5. Full-name equality (any order) = 0.5; same surname + matching first name = 0.45; + initial only = 0.35; surname alone = 0.1. */
export function nameScore(query: string, candidate: string): number {
  const a = nameTokens(query); const b = nameTokens(candidate);
  if (!a.length || !b.length) return 0;
  if (a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ')) return 0.5;
  const la = a[a.length - 1]; const lb = b[b.length - 1];
  const surnameEq = la === lb || (b.length > 1 && a.includes(lb) && a.indexOf(lb) >= a.length - 2) || (a.length > 1 && b.includes(la) && b.indexOf(la) >= b.length - 2);
  if (!surnameEq) return 0;
  const fa = a[0]; const fb = b[0];
  if (fa === fb) return 0.45;
  if (fa.length === 1 || fb.length === 1) return fa[0] === fb[0] ? 0.35 : 0;
  return fa[0] === fb[0] && (fa.startsWith(fb) || fb.startsWith(fa)) ? 0.4 : 0;     // "Jon" / "Jonathan"; different first names = a different person
}

const instTokens = (s: string) => new Set(fold(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !STOP_INST.has(t)));
export function institutionScore(query: string | undefined, candidates: string[]): number {
  if (!query || !candidates.length) return 0;
  const q = instTokens(query); if (!q.size) return 0;
  let best = 0;
  for (const c of candidates) { const t = instTokens(c); if (!t.size) continue; let hit = 0; for (const x of q) if (t.has(x)) hit++; best = Math.max(best, hit / Math.min(q.size, t.size)); }
  return best >= 0.99 ? 0.3 : best >= 0.5 ? 0.2 : best > 0 ? 0.1 : 0;
}

/** A profile URL that contains the candidate's ORCID / source id is strong evidence (0.6). */
export function idScore(profileUrl: string | undefined, ids: (string | undefined)[]): number {
  if (!profileUrl) return 0; const u = fold(profileUrl);
  return ids.filter((x): x is string => !!x).some(id => id.length >= 5 && u.includes(fold(id).replace(/^https?:\/\/(orcid\.org|openalex\.org)\//, ''))) ? 0.6 : 0;
}

export function keywordScore(keywords: string[] | undefined, topics: string[] | undefined): number {
  if (!keywords?.length || !topics?.length) return 0;
  const t = topics.map(fold); const hit = keywords.map(fold).filter(k => k.length > 3 && t.some(x => x.includes(k) || k.includes(x))).length;
  return Math.min(0.1, hit * 0.05);
}

export interface AuthorLike { names: string[]; institutions: string[]; topics?: string[]; ids?: (string | undefined)[] }
export interface Query { name: string; institution?: string; profileUrl?: string; keywords?: string[] }

export function scoreAuthor(q: Query, a: AuthorLike): { confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  const n = Math.max(0, ...a.names.map(x => nameScore(q.name, x)));
  if (n === 0) return { confidence: 0, reasons: ['name does not match'] };
  reasons.push(n >= 0.5 ? 'full name matches' : n >= 0.45 ? 'surname and first name match' : 'surname + initial match');
  let c = n;
  const inst = institutionScore(q.institution, a.institutions); if (inst) { c += inst; reasons.push(inst >= 0.3 ? 'same institution' : 'similar institution'); } else if (q.institution && a.institutions.length) reasons.push('different institution');
  const id = idScore(q.profileUrl, a.ids || []); if (id) { c += id; reasons.push('profile URL contains this author’s id'); }
  const kw = keywordScore(q.keywords, a.topics); if (kw) { c += kw; reasons.push('research topics overlap'); }
  return { confidence: Math.min(1, +c.toFixed(3)), reasons };
}

export type Decision = { status: 'found'; pick: MatchCandidate } | { status: 'ambiguous'; candidates: MatchCandidate[] } | { status: 'none' };

/** Choose automatically only when one candidate is confident AND clearly ahead of the next; otherwise hand the choice to the user. */
export function decide(cands: MatchCandidate[], accept = 0.75, margin = 0.2, floor = 0.3): Decision {
  const ranked = cands.filter(c => c.confidence >= floor).sort((a, b) => b.confidence - a.confidence);
  if (!ranked.length) return { status: 'none' };
  const [best, second] = ranked;
  if (best.confidence >= accept && (!second || best.confidence - second.confidence >= margin)) return { status: 'found', pick: best };
  return { status: 'ambiguous', candidates: ranked.slice(0, 6) };
}
