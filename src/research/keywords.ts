// Research keywords derived from a publication's own title / abstract / source keywords – plain word statistics, no AI, nothing invented.
import type { Publication } from '../core/types';

const STOP = new Set(('a an and are as at be been being but by can could did do does for from had has have how if in into is it its may might more most no not of on or our out over such than that the their them then there these they this those through to under up use used using was we were what when where which while who why will with within without would you your also both each other via between among about after before during further however thus than very new based study studies results result paper approach analysis method methods case one two three first second').split(' '));

export function deriveKeywords(pub: Pick<Publication, 'title' | 'abstract' | 'keywords'>, max = 6): string[] {
  const given = (pub.keywords || []).map(k => k.trim()).filter(Boolean);
  if (given.length >= 3) return [...new Set(given.map(k => k.toLowerCase()))].slice(0, max);
  const text = `${pub.title}. ${pub.title}. ${pub.abstract || ''}`.toLowerCase();                  // the title counts double
  const words = text.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
  const score = new Map<string, number>();
  const ok = (w: string) => w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w);
  for (let i = 0; i < words.length; i++) {
    if (ok(words[i])) score.set(words[i], (score.get(words[i]) || 0) + 1);
    if (i + 1 < words.length && ok(words[i]) && ok(words[i + 1])) { const bg = `${words[i]} ${words[i + 1]}`; score.set(bg, (score.get(bg) || 0) + 2.5); }
  }
  const ranked = [...score].filter(([k, v]) => v >= 2 || k.includes(' ')).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const out: string[] = [];
  for (const k of ranked) { if (out.some(o => o.includes(k) || k.includes(o))) continue; out.push(k); if (out.length >= max) break; }
  return [...given.map(g => g.toLowerCase()), ...out].filter((v, i, a) => a.indexOf(v) === i).slice(0, max);
}
