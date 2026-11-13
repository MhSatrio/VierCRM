// Functions that run INSIDE a Google Scholar / ResearchGate results page (chrome.scripting.executeScript serialises them, so they must
// be self-contained). They read what a person would see in their own tab. If the site asks for a human check they report it and stop –
// VierCRM never tries to get past a CAPTCHA.

export function extractScholarResults(): { blocked?: string; hits: { title: string; url?: string; authors?: string; venue?: string; year?: number; snippet?: string; pdfUrl?: string }[] } {
  const text = (document.body?.innerText || '').slice(0, 4000).toLowerCase();
  if (/unusual traffic|not a robot|captcha/.test(text) || /\/sorry\//.test(location.pathname) || document.querySelector('#gs_captcha_ccl, form#captcha-form, iframe[src*="recaptcha"]')) return { blocked: 'unusual-traffic check', hits: [] };
  const hits: any[] = [];
  document.querySelectorAll('.gs_r.gs_or, .gs_ri').forEach(card => {
    const root = card.closest('.gs_r') || card;
    const a = root.querySelector('.gs_rt a') as HTMLAnchorElement | null; const titleEl = root.querySelector('.gs_rt');
    const title = (a?.textContent || titleEl?.textContent || '').replace(/^\s*\[(PDF|HTML|BOOK|B)\]\s*/i, '').trim();
    if (!title) return;
    const meta = (root.querySelector('.gs_a')?.textContent || '').replace(/ /g, ' ');
    const parts = meta.split(' - ');
    const y = meta.match(/\b(19|20)\d{2}\b/);
    const pdf = root.querySelector('.gs_or_ggsm a, .gs_ggs a') as HTMLAnchorElement | null;
    hits.push({ title, url: a?.href, authors: parts[0]?.trim(), venue: (parts[1] || '').replace(/,?\s*\b(19|20)\d{2}\b/, '').trim() || undefined, year: y ? Number(y[0]) : undefined, snippet: (root.querySelector('.gs_rs')?.textContent || '').trim() || undefined, pdfUrl: pdf && /\.pdf|\[PDF\]/i.test(pdf.href + pdf.textContent) ? pdf.href : undefined });
  });
  return { hits };
}

export function extractResearchGateResults(): { blocked?: string; hits: { title: string; url?: string; authors?: string; venue?: string; year?: number; snippet?: string }[] } {
  const text = (document.body?.innerText || '').slice(0, 3000).toLowerCase();
  if (/just a moment|verify you are human|checking your browser|captcha|access denied/.test(text) || /^just a moment/i.test(document.title)) return { blocked: 'security check', hits: [] };
  const seen = new Set<string>(); const hits: any[] = [];
  document.querySelectorAll('a[href*="/publication/"]').forEach(el => {
    const a = el as HTMLAnchorElement; const title = (a.textContent || '').trim();
    if (title.length < 15 || seen.has(a.href)) return; seen.add(a.href);
    const item = a.closest('li, article, [class*="item"], [class*="Item"]') || a.parentElement;
    const authors = Array.from(item?.querySelectorAll('a[href*="/profile/"]') || []).map(x => (x.textContent || '').trim()).filter(Boolean).join(', ');
    const y = (item?.textContent || '').match(/\b(19|20)\d{2}\b/);
    hits.push({ title, url: a.href, authors, year: y ? Number(y[0]) : undefined });
  });
  return { hits };
}

export const PAGE_EXTRACTORS = { scholar: extractScholarResults, researchgate: extractResearchGateResults } as const;
