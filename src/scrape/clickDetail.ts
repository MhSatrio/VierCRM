// Some lists show a person's contact details only after the entry is opened: its name is clicked, a panel or dialog appears (or the page
// changes), the details are read from it, and the panel is closed again so the list keeps its place. Opt-in per configuration (clickDetails).
//
// Nothing is clicked except the entry's own name / link (and, inside an opened panel, a control that says it shows the contact details).
// A link never takes the tab away: the click's default action is cancelled, the page's own script still runs. Every step waits for the page
// and gives up quietly – a list that does not open on click just keeps what it shows. `report` says what each step saw, for the test button.
import type { ScrapeConfig } from '../core/types';
import { fid } from '../core/defaults';
import { clean, isVisible, qs, qsa, sleep, text, waitFor } from './dom';
import { detectPeople, type DetectOpts, type PersonCard } from './detect';
import { extractPerson, findEmails, findPhone, pickEmail, type Extracted } from './extract';

/** Things that open over or beside a list: dialogs, drawers, side panels, modals. */
const PANEL = '[role="dialog"], [aria-modal="true"], dialog, aside, [class*="drawer" i], [class*="modal" i], [class*="side-panel" i], [class*="sidepanel" i], [class*="sidebar" i], [class*="flyout" i], [class*="overlay" i]';
const CLOSE = '[aria-label*="close" i], [title*="close" i], [aria-label*="dismiss" i]';
const CLOSE_TEXT = /^(×|✕|✖|x|close|tutup|dismiss)$/i;
/** a control inside an opened panel that reveals the contact details (“Show contact details”, “Show e-mail”, “Lihat kontak” …) */
const REVEAL = /\b(show|reveal|view|see|display|lihat|tampilkan)\b[^]{0,30}\b(contact|e-?mail|phone|number|kontak|nomor)\b|\bcontact (details|info|information)\b|\bshow (e-?mail|phone)\b/i;

export interface ClickReport {
  /** the element that was clicked */ target: string;
  urlBefore: string; urlAfter: string;
  /** what opened: a panel, the page itself (a page of its own), a new e-mail address only, or nothing */
  how: 'panel' | 'page' | 'new e-mail' | 'nothing';
  panel: string; panelText: string;
  emails: string[]; newEmails: string[]; phone: string;
  /** a control inside the panel was pressed to reveal the contact details */
  revealed: boolean;
  /** the panel was closed again (or the page went back to the list) */
  closed: boolean;
  /** the markup of the view with every word and address masked (structure and class names only) */
  structure: string;
}
export const emptyClickReport = (): ClickReport => ({ target: '', urlBefore: '', urlAfter: '', how: 'nothing', panel: '', panelText: '', emails: [], newEmails: [], phone: '', revealed: false, closed: false, structure: '' });

const describe = (el: Element) => {
  const role = el.getAttribute('role'); const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
  return `${el.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}${cls ? `.${cls}` : ''} “${clean(text(el)).slice(0, 60)}”`;
};

/** The element to click for this entry: its own link when that carries the name; else the control inside the card that carries the name (the
 *  smallest one holding it); else the control around the name heading. A click on a heading does not reach a button inside it, so the
 *  control itself is what is clicked. */
export function clickTargetOf(card: PersonCard): HTMLElement | null {
  const name = clean(card.name); if (!name) return null;
  const named = (e: Element) => clean(text(e)).includes(name) && isVisible(e);
  const a = card.anchor as HTMLElement | null;
  if (a && named(a)) return a;
  const controls = qsa<HTMLElement>(card.root, 'a, button, [role="button"], [tabindex]:not([tabindex="-1"])').filter(e => e.tagName !== 'INPUT' && named(e));
  if (controls.length) return controls.sort((x, y) => text(x).length - text(y).length)[0];
  // a name written as plain text (SEEK and many job boards have no link or button around it): the innermost element holding it.
  // A click bubbles up from there to whatever handler the card or its wrapper has.
  const leaves = qsa<HTMLElement>(card.root, '*').filter(e => e.tagName !== 'INPUT' && named(e) && !Array.from(e.children).some(c => clean(text(c)).includes(name)));
  if (leaves.length) return leaves.sort((x, y) => text(x).length - text(y).length)[0];
  const heading = qsa<HTMLElement>(card.root, 'h1, h2, h3, h4, h5, h6, [class*="name" i]').find(named);
  if (heading) return heading.closest<HTMLElement>('a, button, [role="button"], [tabindex]') ?? heading;
  return card.root as HTMLElement;                       // last resort: the card itself
}

/** A click that must not take the tab away: a link's default action is cancelled; the page's own handler still runs. */
function clickKeepingPage(doc: Document, el: HTMLElement) {
  const keep = (e: Event) => e.preventDefault();
  doc.addEventListener('click', keep, { capture: true, once: true });
  try { el.click(); } finally { doc.removeEventListener('click', keep, { capture: true }); }
}

const SHOWN_ATTRS = new Set(['class', 'id', 'role', 'type', 'tabindex', 'name', 'for', 'data-testid', 'data-cy', 'data-analytics', 'data-intercom-target']);
const maskText = (t: string) => t.replace(/[A-Za-z]/g, 'x').replace(/[0-9]/g, '0');
/** The markup of an element with every word, address and link value masked (letters → x, digits → 0): the structure and class names stay. */
export function structureOf(el: Element, max = 30000): string {
  const copy = el.cloneNode(true) as Element;
  const walk = (n: Node) => {
    if (n.nodeType === 3) { n.nodeValue = maskText(n.nodeValue || ''); return; }
    if (n.nodeType !== 1) return;
    const e = n as Element;
    if (/^(script|style|noscript)$/i.test(e.tagName)) { e.textContent = ''; return; }
    for (const a of Array.from(e.attributes)) if (!SHOWN_ATTRS.has(a.name)) e.setAttribute(a.name, maskText(a.value).slice(0, 60));
    Array.from(e.childNodes).forEach(walk);
  };
  walk(copy);
  return copy.outerHTML.slice(0, max);
}

/**
 * Open one entry by clicking it, read the details that appear, close it again. Returns what was read, or null when nothing opened.
 * `detect` is used to find the entry again when an earlier click redrew the list. `report` (optional) is filled with what each step saw.
 */
export async function readOpenedEntry(doc: Document, card: PersonCard, cfg: ScrapeConfig, detect: DetectOpts, report: ClickReport = emptyClickReport()): Promise<Extracted | null> {
  const win = doc.defaultView; if (!win) return null;
  let live: PersonCard = card;
  if (!card.root.isConnected) { const again = detectPeople(doc, detect).find(c => c.name === card.name); if (!again) return null; live = again; }
  const target = clickTargetOf(live);
  if (!target) { report.target = 'no clickable name found in this entry'; return null; }
  report.target = describe(target);

  const startUrl = doc.location.href; report.urlBefore = startUrl;
  const before = new Map<Element, string>(qsa(doc, PANEL).map(p => [p, clean(text(p))] as [Element, string]));
  // what was on the page BEFORE the click (the signed-in account, a footer, a menu) belongs to the page, never to the entry: only new contact details count
  const emailsBefore = new Set(findEmails(doc));
  const phoneBefore = findPhone(doc.body) || '';
  // every element added to the page while we wait: a view is recognised by what it says, whatever its markup
  const added: Element[] = [];
  const observer = new win.MutationObserver(records => { for (const r of records) for (const n of Array.from(r.addedNodes)) if (n.nodeType === 1) added.push(n as Element); });
  observer.observe(doc.body, { childList: true, subtree: true });

  const surname = clean(card.name).split(' ').pop() || '';
  // it must be about THIS entry: it mentions the surname, or it shows an e-mail address that was not on the page before
  const aboutEntry = (el: Element) => (!!surname && clean(text(el)).includes(surname)) || findEmails(el).some(e => !emailsBefore.has(e));
  const freshPanel = (): Element | null => {
    const hits = qsa(doc, PANEL).filter(p => !p.contains(live.root) && isVisible(p)).filter(p => {
      const t = clean(text(p)); if (t.length < 15 || t.length > 8000) return false;
      if (before.has(p) && before.get(p) === t) return false;                  // unchanged since the click
      return aboutEntry(p);
    });
    return hits.sort((a, b) => text(a).length - text(b).length)[0] ?? null;
  };
  // the largest element that was added and is about this entry (the top of what appeared); never a container of the list
  const addedPanel = (): Element | null => {
    const hits = added.filter(el => el.isConnected && !el.contains(live.root) && isVisible(el)).filter(el => {
      const t = clean(text(el)); return t.length >= 15 && t.length <= 8000 && aboutEntry(el);
    });
    return hits.sort((a, b) => text(b).length - text(a).length)[0] ?? null;
  };
  const moved = () => doc.location.href !== startUrl;
  const readPanel = (el: Element) => extractPerson(el, cfg, { url: doc.location.href, scope: 'profile', nameHint: card.name, kind: cfg.list.kind });
  // an e-mail address or phone number that appeared after the click
  const freshContact = (el: Element) => findEmails(el).some(e => !emailsBefore.has(e)) || (!!findPhone(el) && findPhone(el) !== phoneBefore);
  // the entry's own e-mail and phone: only what is new, and the one that resembles the name
  const setContact = (x: Extracted, el: Element) => {
    x.values[fid('email')] = pickEmail(findEmails(el).filter(e => !emailsBefore.has(e)), card.name);
    const ph = findPhone(el) || ''; x.values[fid('phone')] = ph && ph !== phoneBefore ? ph : '';
  };
  const emptyExtracted = (): Extracted => ({ values: {}, found: [], publicationLinks: [], identifiers: [], pairs: [] });

  // the candidate's name written outside the list card: the innermost element holding it
  const nameLeaves = (): HTMLElement[] => {
    const name = clean(card.name);
    return qsa<HTMLElement>(doc.body, '*').filter(e => {
      if (live.root.contains(e) || e.contains(live.root)) return false;       // not the list card, nor a container of it
      if (!clean(e.textContent || '').includes(name)) return false;
      return !Array.from(e.children).some(c => clean(c.textContent || '').includes(name));
    });
  };
  // Same page: the smallest container that holds this candidate's name AND an address or phone that is new. Anything elsewhere on the page is not taken.
  type Near = { el: Element; email: string; phone: string };
  const contactNearName = (): Near | null => {
    for (const leaf of nameLeaves()) {
      for (let a: Element | null = leaf; a && a !== doc.body && !a.contains(live.root); a = a.parentElement) {
        const fresh = findEmails(a).filter(e => !emailsBefore.has(e));
        const ph = findPhone(a) || ''; const phone = ph && ph !== phoneBefore ? ph : '';
        if (fresh.length || phone) return { el: a, email: pickEmail(fresh, card.name), phone };
      }
    }
    return null;
  };
  // the largest container that holds the name without holding the list: shown in the report when nothing was found
  const topOfName = (): Element | null => {
    const leaf = nameLeaves()[0]; if (!leaf) return null;
    let a: Element = leaf;
    while (a.parentElement && a.parentElement !== doc.body && !a.parentElement.contains(live.root)) a = a.parentElement;
    return a;
  };

  let root: Element | null = null; let ex: Extracted | null = null; let contactEl: Element | null = null;
  try {
    clickKeepingPage(doc, target);
    // a panel beside the list, or a view added to the page
    const panel = await waitFor(() => freshPanel() ?? addedPanel(), { timeout: 6000, interval: 250 });
    root = (panel as Element | null) ?? null;
    if (root) {
      const el: Element = root;
      report.how = 'panel'; report.panel = describe(el);
      // the details often load after the view opens: give them a moment
      await waitFor(() => freshContact(el) || null, { timeout: 4000, interval: 250 });
      ex = readPanel(el); setContact(ex, el); contactEl = el;
      // a control inside the panel that shows the contact details: press it once, then read again
      if (!freshContact(el)) {
        const reveal = qsa<HTMLElement>(el, 'button, a, [role="button"]').find(b => REVEAL.test(clean(text(b))) && isVisible(b));
        if (reveal) {
          report.revealed = true;
          clickKeepingPage(doc, reveal);
          await waitFor(() => freshContact(el) || null, { timeout: 3000, interval: 200 });
          ex = readPanel(el); setContact(ex, el);
        }
      }
    } else if (moved()) {
      // the same page now shows the candidate: only this candidate's own container counts
      report.how = 'page';
      const near = (await waitFor(() => contactNearName(), { timeout: 6000, interval: 300 })) as Near | null;
      ex = emptyExtracted();
      if (near) { ex.values[fid('email')] = near.email; ex.values[fid('phone')] = near.phone; contactEl = near.el; }
    } else {
      // no view recognised: one e-mail address that is new on the page is taken as this entry's – and nothing else is read from the page
      const news = findEmails(doc).filter(e => !emailsBefore.has(e));
      if (news.length === 1) { ex = { values: { [fid('email')]: news[0] }, found: [fid('email')], publicationLinks: [], identifiers: [], pairs: [] }; report.how = 'new e-mail'; }
    }
  } finally {
    observer.disconnect();
    report.urlAfter = doc.location.href;
    if (contactEl) { report.emails = findEmails(contactEl); report.newEmails = report.emails.filter(e => !emailsBefore.has(e)); report.phone = findPhone(contactEl) || ''; report.panelText = clean(text(contactEl)).slice(0, 240); }
    const shown = contactEl ?? root ?? topOfName();
    if (shown) report.structure = structureOf(shown);
    report.closed = await closeOpened(doc, win, root, startUrl, detect);
  }
  return ex;
}

/** Close what was opened: go back when the entry was a page of its own, else press the panel's close control (or Escape). */
async function closeOpened(doc: Document, win: Window & typeof globalThis, root: Element | null, startUrl: string, detect: DetectOpts): Promise<boolean> {
  if (doc.location.href !== startUrl) {                       // the entry was a page of its own: back to the list
    win.history.back();
    return !!(await waitFor(() => doc.location.href === startUrl && detectPeople(doc, detect).length > 0, { timeout: 5000, interval: 250 }));
  }
  const panel = root && root !== doc.body ? root : null;
  if (!panel) return true;
  const btn = qs<HTMLElement>(panel, CLOSE) ?? qsa<HTMLElement>(panel, 'button').find(b => CLOSE_TEXT.test(clean(text(b))));
  if (btn) btn.click(); else doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  const gone = await waitFor(() => !panel.isConnected || !isVisible(panel), { timeout: 2500, interval: 150 });
  await sleep(150);
  return !!gone;
}
