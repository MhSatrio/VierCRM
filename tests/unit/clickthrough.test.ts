import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { text } from '../../src/scrape/dom';
import { detectPeople } from '../../src/scrape/detect';
import { findNextUrl, findNextButton } from '../../src/scrape/paginate';
import { crawlPage, type PageIO } from '../../src/scrape/pageCrawler';
import { clickTargetOf, emptyClickReport, readOpenedEntry } from '../../src/scrape/clickDetail';
import { exampleScrapeConfigs, fid } from '../../src/core/defaults';
import type { ScrapeConfig, ScrapedPerson } from '../../src/core/types';

const BASE = 'http://127.0.0.1:9';
const dom = (html: string, url = `${BASE}/candidates/`) => { const d = new JSDOM(html, { url, pretendToBeVisual: true }); d.window.scrollTo = () => {}; return d; };
const cfg = (over: Partial<ScrapeConfig> = {}, pg: Partial<ScrapeConfig['pagination']> = {}): ScrapeConfig => {
  const c = structuredClone(exampleScrapeConfigs()[0]);
  return { ...c, visitProfiles: false, ...over, pagination: { ...c.pagination, mode: 'next', delayMinMs: 0, delayMaxMs: 0, ...pg } };
};
const io = (out: ScrapedPerson[]): PageIO => ({
  fetchDoc: async () => null, renderProfile: async () => null,
  emit: async p => { out.push(p); return 'created'; },
  shouldStop: async () => false, progress: () => {}, sleep: async () => {},
});

describe('icons are not text', () => {
  it('an SVG icon’s <title> (“Verified Icon”) is not read as part of a name', () => {
    const d = dom('<body><h3 id="n">Nia Fitriani<svg width="16" height="16" role="img"><title>Verified Icon</title><path d="M0 0"/></svg></h3></body>');
    expect(text(d.window.document.getElementById('n'))).toBe('Nia Fitriani');
  });
  it('the candidate card reads “Nia Fitriani”, not “Nia FitrianiVerified Icon”', () => {
    const card = (name: string, i: number) => `<li class="c"><a href="/people/p${i}"><h3>${name}<svg role="img"><title>Verified Icon</title><path d="M0 0"/></svg></h3><p>Administrative Staff at PT Example</p></a></li>`;
    const d = dom(`<body><ul>${card('Nia Fitriani', 1)}${card('Desi Triyana', 2)}${card('Budi Santoso', 3)}</ul></body>`);
    const cards = detectPeople(d.window.document, { baseUrl: BASE });
    expect(cards.map(c => c.name)).toEqual(['Nia Fitriani', 'Desi Triyana', 'Budi Santoso']);
  });
});

describe('“Next” that is a script button (no address)', () => {
  it('is found as a clickable control – it has no URL to follow', () => {
    const d = dom('<body><nav class="pager"><a class="pn">Previous</a><a class="pn" id="nx">Next</a></nav></body>').window.document;
    expect(findNextUrl(d, `${BASE}/candidates/`, cfg().pagination)).toBeNull();
    expect(findNextButton(d, cfg().pagination)?.id).toBe('nx');
  });
});

describe('numbered pager whose numbers are not links', () => {
  it('finds the page after the current one when the current page is marked', () => {
    const d = dom('<body><div class="pager"><button type="button"><span>1</span></button><button type="button"><span>2</span></button><span class="current">3</span><button type="button"><span>4</span></button></div></body>').window.document;
    expect(findNextButton(d, cfg().pagination)?.textContent?.trim()).toBe('4');
  });
  it('treats the one number that is not clickable as the current page', () => {
    const d = dom('<body><div><button type="button"><span>1</span></button><button type="button"><span>2</span></button><span>3</span><button type="button"><span>4</span></button></div></body>').window.document;
    expect(findNextButton(d, cfg().pagination)?.textContent?.trim()).toBe('4');
  });
  it('does not mistake sizes like “10 · 20 · 50” for pages', () => {
    const d = dom('<body><div class="per-page"><span>10</span><span>20</span><span>50</span></div></body>').window.document;
    expect(findNextButton(d, cfg().pagination)).toBeNull();
  });
  it('goes through every page of such a pager and stops on the last one', async () => {
    const NAMES = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra', 'Barbara Liskov', 'Donald Knuth', 'Margaret Hamilton', 'John McCarthy', 'Radia Perlman'];
    const people = (page: number) => NAMES.slice((page - 1) * 3, page * 3).map(name => ({ name, slug: name.toLowerCase().replace(/\s+/g, '-') }));
    const d = dom('<body><div id="list"></div><div id="pager"></div></body>');
    const doc = d.window.document;
    const render = (page: number) => {
      doc.getElementById('list')!.innerHTML = `<ul>${people(page).map(p => `<li><a href="/people/${p.slug}">${p.name}</a></li>`).join('')}</ul>`;
      doc.getElementById('pager')!.innerHTML = [1, 2, 3].map(n => {
        const cur = n === page;
        return cur ? `<span class="current">${n}</span>` : `<button type="button" data-p="${n}"><span>${n}</span></button>`;
      }).join('');
      doc.querySelectorAll<HTMLButtonElement>('#pager button').forEach(b => b.addEventListener('click', () => render(Number(b.dataset.p))));
    };
    render(1);
    const out: ScrapedPerson[] = [];
    const res = await crawlPage(doc, cfg({}, { mode: 'auto', maxPages: 10 }), { seen: [], pageIndex: 1, recordsLeft: 99, pagesLeft: 10 }, io(out));
    expect(out.map(p => p.values[fid('fullName')])).toEqual(NAMES);
    expect(res.finished).toBe(true);
  });
});

describe('contact details that open on a click', () => {
  // Each candidate’s name is a button; clicking it opens a dialog with the e-mail and phone (like a candidate panel), with a close button.
  const people = [
    { name: 'Ada Lovelace', email: 'ada@example.test', phone: '+31 20 555 0001' },
    { name: 'Grace Hopper', email: 'grace@example.test', phone: '+31 20 555 0002' },
    { name: 'Alan Turing', email: 'alan@example.test', phone: '+31 20 555 0003' },
  ];
  const page = () => {
    const d = dom(`<body><ul id="list">${people.map(p => `<li class="cand"><h3><button type="button" class="nm">${p.name}</button></h3><p>Administrative Staff</p><button type="button">Shortlist</button></li>`).join('')}</ul></body>`);
    const doc = d.window.document;
    doc.querySelectorAll<HTMLButtonElement>('button.nm').forEach((b, i) => b.addEventListener('click', () => {
      const p = people[i];
      doc.body.insertAdjacentHTML('beforeend', `<div role="dialog" aria-modal="true"><h2>${p.name}</h2><p>Email: <a href="mailto:${p.email}">${p.email}</a></p><p>Phone: ${p.phone}</p><button type="button" aria-label="Close">×</button></div>`);
      doc.querySelector('[role="dialog"] button[aria-label="Close"]')!.addEventListener('click', () => doc.querySelector('[role="dialog"]')!.remove());
    }));
    return doc;
  };

  it('opens each name, reads the e-mail and phone from the panel, and closes it again', async () => {
    const doc = page(); const out: ScrapedPerson[] = [];
    const res = await crawlPage(doc, cfg({ clickDetails: true }, { mode: 'none' }), { seen: [], pageIndex: 1, recordsLeft: 99, pagesLeft: 1 }, io(out));
    expect(res.found).toBe(3);
    expect(out.map(p => [p.values[fid('fullName')], p.values[fid('email')], p.values[fid('phone')]])).toEqual(people.map(p => [p.name, p.email, p.phone]));
    expect(out.every(p => p.status === 'ok')).toBe(true);
    expect(doc.querySelectorAll('[role="dialog"]')).toHaveLength(0);                    // the panel was closed – the list keeps its place
    expect(doc.querySelectorAll('li.cand')).toHaveLength(3);
  });

  it('a sidebar that redraws on every click is not mistaken for the opened panel', async () => {
    const d = dom(`<body><aside class="sidebar"><p id="recent">Nothing yet – recently viewed candidates appear here.</p></aside><ul id="list">${people.map(p => `<li class="cand"><h3><button type="button" class="nm">${p.name}</button></h3><p>Administrative Staff</p></li>`).join('')}</ul></body>`);
    const doc = d.window.document;
    doc.querySelectorAll<HTMLButtonElement>('button.nm').forEach((b, i) => b.addEventListener('click', () => {
      doc.getElementById('recent')!.textContent = `Recently viewed: someone number ${i}`;
      doc.body.insertAdjacentHTML('beforeend', `<div role="dialog" aria-modal="true"><h2>${people[i].name}</h2><p><a href="mailto:${people[i].email}">${people[i].email}</a></p><button type="button" aria-label="Close">×</button></div>`);
      doc.querySelector('[role="dialog"] button[aria-label="Close"]')!.addEventListener('click', () => doc.querySelector('[role="dialog"]')!.remove());
    }));
    const out: ScrapedPerson[] = [];
    await crawlPage(doc, cfg({ clickDetails: true }, { mode: 'none' }), { seen: [], pageIndex: 1, recordsLeft: 99, pagesLeft: 1 }, io(out));
    expect(out.map(p => p.values[fid('email')])).toEqual(people.map(p => p.email));
  });

  it('a panel with no class names or role is still recognised, because it is about this entry', async () => {
    const d = dom(`<body><ul id="list">${people.map(p => `<li class="cand"><h3><button type="button" class="nm">${p.name}</button></h3><p>Administrative Staff</p></li>`).join('')}</ul></body>`);
    const doc = d.window.document;
    doc.querySelectorAll<HTMLButtonElement>('button.nm').forEach((b, i) => b.addEventListener('click', () => {
      const div = doc.createElement('div'); div.innerHTML = `<div><span>${people[i].name}</span> <span>${people[i].email}</span></div>`; doc.body.appendChild(div);
    }));
    // Escape closes whatever opened (this markup has no close button)
    doc.addEventListener('keydown', e => { if (e.key === 'Escape') doc.querySelectorAll('body > div').forEach(n => n.remove()); });
    const detect = { baseUrl: BASE, kind: 'people' as const };
    const report = emptyClickReport();
    const ex = await readOpenedEntry(doc, detectPeople(doc, detect)[0], cfg({ clickDetails: true }), detect, report);
    expect(report.how).toBe('panel');                                   // recognised as the panel itself, not by the e-mail fallback
    expect(report.panelText).toContain(people[0].name);
    expect(ex?.values[fid('email')]).toBe(people[0].email);
    expect(doc.querySelectorAll('body > div')).toHaveLength(0);
  });

  it('a “Show contact details” control inside the panel is pressed once; the report says what happened', async () => {
    const d = dom(`<body><ul id="list">${people.map(p => `<li class="cand"><h3><button type="button" class="nm">${p.name}</button></h3><p>Administrative Staff</p></li>`).join('')}</ul></body>`);
    const doc = d.window.document;
    doc.querySelectorAll<HTMLButtonElement>('button.nm').forEach((b, i) => b.addEventListener('click', () => {
      doc.body.insertAdjacentHTML('beforeend', `<div role="dialog" aria-modal="true"><h2>${people[i].name}</h2><button type="button" class="reveal">Show contact details</button><button type="button" aria-label="Close">×</button></div>`);
      doc.querySelector('[role="dialog"] .reveal')!.addEventListener('click', () => {
        doc.querySelector('[role="dialog"] .reveal')!.outerHTML = `<p>Email: <a href="mailto:${people[i].email}">${people[i].email}</a></p><p>Phone: ${people[i].phone}</p>`;
      });
      doc.querySelector('[role="dialog"] button[aria-label="Close"]')!.addEventListener('click', () => doc.querySelector('[role="dialog"]')!.remove());
    }));
    const detect = { baseUrl: BASE, kind: 'people' as const };
    const card = detectPeople(doc, detect)[0];
    const report = emptyClickReport();
    const ex = await readOpenedEntry(doc, card, cfg({ clickDetails: true }), detect, report);
    expect(ex?.values[fid('email')]).toBe(people[0].email);
    expect(ex?.values[fid('phone')]).toBe(people[0].phone);
    expect(report).toMatchObject({ how: 'panel', revealed: true, closed: true, emails: [people[0].email] });
    expect(report.target).toContain('“Ada Lovelace”');
    expect(doc.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  }, 20000);

  it('without the option, the list alone is read (no contact details) – unchanged behaviour', async () => {
    const doc = page(); const out: ScrapedPerson[] = [];
    await crawlPage(doc, cfg({ clickDetails: false }, { mode: 'none' }), { seen: [], pageIndex: 1, recordsLeft: 99, pagesLeft: 1 }, io(out));
    expect(out.every(p => !p.values[fid('email')])).toBe(true);
    expect(doc.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  });
});

describe('SEEK-style candidate card: the name is plain text, the card is what opens the candidate', () => {
  const seekPeople = [
    { name: 'Florensia Evindonta Bangun', email: 'florensia@example.test', phone: '+62 812 555 0101' },
    { name: 'Nia Fitriani', email: 'nia@example.test', phone: '+62 812 555 0102' },
    { name: 'Desi Triyana', email: 'desi@example.test', phone: '+62 812 555 0103' },
  ];
  const card = (p: { name: string }, i: number) => `<div class="vnhgci0 p3foak95" data-testid="job-application-card"><div class="vnhgci0 _1tz3d2r0" data-testid="avatar-checkbox-desktop"><div class="vnhgci0 _1tz3d2r1" id="avatar-${i}"><div aria-hidden="true"><img src="https://example.test/avatar-${i}.jpg" alt=""></div><input class="vnhgci0 p3foak5h" id="checkbox-${i}" aria-label="Select candidate ${p.name}" aria-checked="false" type="checkbox"></div></div><div class="vnhgci0 p3foak59"><div class="vnhgci0 p3foak59"><div class="vnhgci0 p3foak59"><span class="vnhgci0 p3foak4x pgzj2s0 pgzj2sg">${p.name}</span></div><div class="vnhgci0 p3foak59"><span class="vnhgci0 p3foak4x">Head of Collections Section at KSP Kopdit Mekar Sai</span><span class="vnhgci0 p3foak4x">(2 months)</span></div></div><div class="vnhgci0 p3foak4x"><span>Lampung</span></div><div class="vnhgci0 p3foak4x"><span>Bachelor in Mathematics Education, 2015</span></div></div><div class="vnhgci0 p3foak59"><span>Applied 7 hours ago</span><button class="vnhgci0" type="button" aria-label="Resumé"></button><button class="vnhgci0" type="button" aria-label="Shortlist ${p.name}"><span>Shortlist</span></button></div></div>`;
  const page = () => {
    const d = dom(`<body><div id="list">${seekPeople.map(card).join('')}</div></body>`);
    const doc = d.window.document;
    doc.getElementById('list')!.addEventListener('click', e => {
      const c = (e.target as Element).closest('[data-testid="job-application-card"]'); if (!c) return;
      if ((e.target as Element).closest('button, input')) return;
      const i = seekPeople.findIndex(x => (c.textContent || '').includes(x.name)); const p = seekPeople[i];
      doc.body.insertAdjacentHTML('beforeend', `<div class="pane" id="pane"><h2>${p.name}</h2><p>Email <a href="mailto:${p.email}">${p.email}</a></p><p>Phone ${p.phone}</p><button type="button" aria-label="Close">×</button></div>`);
      doc.querySelector('#pane button[aria-label="Close"]')!.addEventListener('click', () => doc.getElementById('pane')!.remove());
    });
    return doc;
  };

  it('the entries are found and the click starts at the name, which bubbles up to the card’s handler', () => {
    const doc = page(); const detect = { baseUrl: BASE, kind: 'people' as const };
    const cards = detectPeople(doc, detect);
    expect(cards.map(c => c.name)).toEqual(seekPeople.map(p => p.name));
    expect(clickTargetOf(cards[0])?.textContent?.trim()).toBe(seekPeople[0].name);
  });

  it('clicking the card opens the candidate pane; its e-mail and phone are read and the pane is closed again', async () => {
    const doc = page(); const detect = { baseUrl: BASE, kind: 'people' as const }; const out: ScrapedPerson[] = [];
    await crawlPage(doc, cfg({ clickDetails: true }, { mode: 'none' }), { seen: [], pageIndex: 1, recordsLeft: 99, pagesLeft: 1 }, io(out));
    expect(out.map(p => [p.values[fid('fullName')], p.values[fid('email')], p.values[fid('phone')]])).toEqual(seekPeople.map(p => [p.name, p.email, p.phone]));
    expect(doc.getElementById('pane')).toBeNull();
    const report = emptyClickReport();
    const again = await readOpenedEntry(doc, detectPeople(doc, detect)[1], cfg({ clickDetails: true }), detect, report);
    expect(again?.values[fid('email')]).toBe(seekPeople[1].email);
    expect(report).toMatchObject({ how: 'panel', closed: true });
  });
});

describe('a candidate view that opens in the same page: only this candidate’s NEW contact details are taken', () => {
  const ACCOUNT = 'signed-in@employer.test';
  const cands = [{ name: 'Maya Fictional', email: 'maya.fictional@example.test' }, { name: 'Nia Fitriani', email: 'nia@example.test' }, { name: 'Desi Triyana', email: 'desi@example.test' }];
  const page = (withEmail: boolean) => {
    const d = dom(`<body><header><span>Signed in as ${ACCOUNT}</span></header><ul id="list">${cands.map(c => `<li class="cand"><span class="nm">${c.name}</span><span>Sales Consultant</span></li>`).join('')}</ul></body>`, `${BASE}/candidates/?jobid=1&p=2`);
    const doc = d.window.document;
    doc.getElementById('list')!.addEventListener('click', e => {
      const li = (e.target as Element).closest('li.cand'); if (!li) return;
      const c = cands[[...doc.querySelectorAll('li.cand')].indexOf(li)];
      d.window.history.pushState({}, '', `/candidates/?jobid=1&p=2&selected=${c.name.length}&tab=profile`);
      setTimeout(() => {
        doc.body.insertAdjacentHTML('beforeend', `<section class="profile-view"><h2>${c.name}</h2><p>Sales Consultant</p>${withEmail ? `<p>Contact <a href="mailto:${c.email}">${c.email}</a></p>` : ''}</section>`);
      }, 300);
    });
    return doc;
  };
  const detect = { baseUrl: BASE, kind: 'people' as const };

  it('reads the candidate’s e-mail from the view; the account e-mail already on the page is never taken', async () => {
    const doc = page(true); const report = emptyClickReport();
    const ex = await readOpenedEntry(doc, detectPeople(doc, detect)[0], cfg({ clickDetails: true }), detect, report);
    expect(ex?.values[fid('email')]).toBe(cands[0].email);
    expect(report.how).toBe('panel'); expect(report.urlAfter).toContain('tab=profile'); expect(report.newEmails).toEqual([cands[0].email]);
  }, 20000);

  it('when the view has no contact details, nothing is taken – not the account e-mail', async () => {
    const doc = page(false); const report = emptyClickReport();
    const ex = await readOpenedEntry(doc, detectPeople(doc, detect)[0], cfg({ clickDetails: true }), detect, report);
    expect(ex?.values[fid('email')] || '').toBe(''); expect(report.emails).toEqual([]);
  }, 20000);
});
