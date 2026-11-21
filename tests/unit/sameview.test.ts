import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { detectPeople } from '../../src/scrape/detect';
import { emptyClickReport, readOpenedEntry } from '../../src/scrape/clickDetail';
import { crawlPage, type PageIO } from '../../src/scrape/pageCrawler';
import { exampleScrapeConfigs, fid } from '../../src/core/defaults';
import type { ScrapeConfig, ScrapedPerson } from '../../src/core/types';

const BASE = 'http://127.0.0.1:9';
const dom = (html: string, url = `${BASE}/candidates/`) => { const d = new JSDOM(html, { url, pretendToBeVisual: true }); d.window.scrollTo = () => {}; return d; };
const cfg = (over: Partial<ScrapeConfig> = {}): ScrapeConfig => {
  const c = structuredClone(exampleScrapeConfigs()[0]);
  return { ...c, visitProfiles: false, clickDetails: true, ...over, pagination: { ...c.pagination, mode: 'none' as const, delayMinMs: 0, delayMaxMs: 0 } };
};
const detect = { baseUrl: BASE, kind: 'people' as const };

const people = [
  { name: 'Maya Fictional', email: 'maya.fictional@example.test' },
  { name: 'Nia Fitriani', email: 'nia@example.test' },
  { name: 'Desi Triyana', email: 'desi@example.test' },
];

/**
 * A list whose candidate view is updated IN PLACE (text changes inside <main>, nothing new is added to the page);
 * a menu outside <main> shows another address after the click, as the signed-in account does.
 */
const page = (opts: { contact: boolean; menu: boolean }) => {
  const d = dom(`<body><header><span>Signed in</span></header><ul id="list">${people.map(p => `<li class="cand"><div><span class="nm">${p.name}</span></div><div><span>Sales Consultant</span></div></li>`).join('')}</ul><main><h2 id="who"></h2><p id="contact"></p></main><div id="menu"></div></body>`);
  const doc = d.window.document;
  doc.getElementById('list')!.addEventListener('click', e => {
    const li = (e.target as Element).closest('li.cand'); if (!li) return;
    const p = people[Array.from(doc.querySelectorAll('li.cand')).indexOf(li)];
    d.window.history.pushState({}, '', `/candidates/?jobid=1&p=2&selected=${p.name.length}&tab=profile`);
    setTimeout(() => {
      doc.getElementById('who')!.textContent = p.name;
      if (opts.contact) doc.getElementById('contact')!.textContent = `Contact ${p.email}`;
      if (opts.menu) doc.getElementById('menu')!.textContent = 'Signed in as menu@employer.test';
    }, 300);
  });
  return doc;
};

describe('same-page candidate view: an address counts only together with the candidate’s name', () => {
  it('the candidate’s address in the view is taken; the menu’s address elsewhere on the page is not', async () => {
    const doc = page({ contact: true, menu: true }); const report = emptyClickReport();
    const ex = await readOpenedEntry(doc, detectPeople(doc, detect)[0], cfg(), detect, report);
    expect(ex?.values[fid('email')]).toBe(people[0].email);
    expect(report.how).toBe('page'); expect(report.urlAfter).toContain('tab=profile');
  }, 20000);

  it('when only the menu’s address appears, nothing is taken', async () => {
    const doc = page({ contact: false, menu: true }); const report = emptyClickReport();
    const ex = await readOpenedEntry(doc, detectPeople(doc, detect)[0], cfg(), detect, report);
    expect(ex?.values[fid('email')] || '').toBe(''); expect(report.newEmails).toEqual([]);
  }, 20000);

  it('the structure copied for the report keeps tags, ids and classes, and masks words and addresses', async () => {
    const doc = page({ contact: true, menu: false }); const report = emptyClickReport();
    await readOpenedEntry(doc, detectPeople(doc, detect)[0], cfg(), detect, report);
    expect(report.structure).toContain('<main'); expect(report.structure).toContain('id="contact"');
    expect(report.structure).not.toContain('Maya'); expect(report.structure).not.toContain('maya.fictional'); expect(report.structure).not.toContain('example.test');
  }, 20000);
});

describe('“Role at Company” in a people list', () => {
  it('“Sales Consultant at Mitsubishi (4 months)” is split into position and company', async () => {
    const d = dom(`<body><ul>${people.map(p => `<li class="cand"><div><span class="nm">${p.name}</span></div><div><span>Sales Consultant at Mitsubishi(4 month)</span></div></li>`).join('')}</ul></body>`);
    const out: ScrapedPerson[] = [];
    const io: PageIO = { fetchDoc: async () => null, renderProfile: async () => null, emit: async p => { out.push(p); return 'created'; }, shouldStop: async () => false, progress: () => {}, sleep: async () => {} };
    await crawlPage(d.window.document, cfg({ clickDetails: false }), { seen: [], pageIndex: 1, recordsLeft: 99, pagesLeft: 1 }, io);
    expect(out[0].values[fid('position')]).toBe('Sales Consultant');
    expect(out[0].values[fid('institution')]).toBe('Mitsubishi');
  });
});
