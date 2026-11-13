// Injected into the page being scraped (chrome.scripting.executeScript). One page per call: the background worker navigates between
// pages, exactly like the job-listing scraper. This script reads the page it is on, opens profiles in the background, and reports each
// person back. It also hosts the floating control and the "pick an element" tool.
import type { ContentRequest, TabRequest } from '../shared/messages';
import type { ScrapeConfig, ScrapeProgress } from '../core/types';
import { crawlPage, type PageIO } from '../scrape/pageCrawler';
import { findFirst, findNext } from '../scrape/paginate';
import { detectPeople } from '../scrape/detect';
import { extractPerson, type Extracted } from '../scrape/extract';
import { describePick } from '../scrape/selector';
import { looksLikeName } from '../scrape/detect';
import { sleep, text, waitFor } from '../scrape/dom';
import { findFeed, isMapsPage, isPlacePage, readCards, searchQueryOf } from '../scrape/maps';
import { crawlMaps, placeAsExtracted, type MapsIO } from '../scrape/mapsCrawler';
import type { SiteContacts } from '../scrape/siteContacts';

declare global { interface Window { __vierCrm?: boolean | (() => void) } }

const send = <T = any>(m: ContentRequest): Promise<T> => new Promise(res => { try { chrome.runtime.sendMessage(m, r => { void chrome.runtime.lastError; res(r as T); }); } catch { res(undefined as T); } });

/** Same-site HTML decoded with the page's own charset (older university sites are still Latin-1 / Shift_JIS). */
async function fetchDoc(url: string): Promise<Document | null> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  let charset = res.headers.get('content-type')?.match(/charset=([\w-]+)/i)?.[1];
  if (!charset) charset = new TextDecoder('ascii').decode(buf.slice(0, 2048)).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || 'utf-8';
  let html: string; try { html = new TextDecoder(charset).decode(buf); } catch { html = new TextDecoder('utf-8').decode(buf); }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // relative links inside a fetched document must resolve against ITS url
  const base = doc.createElement('base'); base.href = url; doc.head.prepend(base);
  return doc;
}

async function control(): Promise<boolean> {
  for (;;) {
    const c = await send<{ stop: boolean; paused: boolean }>({ type: 'scrape:control' });
    if (!c || c.stop) return true;
    if (!c.paused) return false;
    await sleep(600);
  }
}

function makeIO(): MapsIO {
  return {
    site: async (url: string) => (await send<{ site: SiteContacts | null }>({ type: 'scrape:site', url }))?.site ?? null,
    fetchDoc,
    renderProfile: async (url: string) => (await send<{ extracted: Extracted | null }>({ type: 'scrape:render', url, config: currentCfg! }))?.extracted ?? null,
    emit: async person => (await send<{ action: 'created' | 'merged' | 'duplicate' | 'skipped' }>({ type: 'scrape:person', person }))?.action ?? 'skipped',
    shouldStop: control,
    progress: p => { void send({ type: 'scrape:progress-lite', patch: p as any }); },
  };
}
let currentCfg: ScrapeConfig | null = null;

// ------------------------------------------------------------------ floating control
let widget: { host: HTMLElement; set(p: Partial<ScrapeProgress>): void } | null = null;
function showWidget(p: ScrapeProgress) {
  if (!widget) {
    const host = document.createElement('div'); host.id = 'viercrm-widget'; host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .w{font:13px/1.35 Jost,system-ui,sans-serif;background:#231F20;color:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);padding:10px 12px;min-width:230px;max-width:300px;border-left:4px solid #4570B6}
      b{color:#CAEBFB}.row{display:flex;gap:6px;margin-top:8px}button{font:inherit;border:0;border-radius:7px;padding:4px 10px;cursor:pointer;background:#4570B6;color:#fff}button.s{background:#555}
      .bar{height:4px;background:#444;border-radius:2px;margin-top:6px;overflow:hidden}.bar i{display:block;height:100%;background:#CAEBFB;width:0}.m{color:#bbb;font-size:12px}
    </style><div class="w"><div><b>VierCRM</b> <span id="ph"></span></div><div class="m" id="ct"></div><div class="bar"><i id="pb"></i></div>
      <div class="row"><button id="pr">Pause</button><button id="st" class="s">Stop</button></div></div>`;
    document.documentElement.append(host);
    const $ = (id: string) => root.getElementById(id)!;
    let paused = false;
    $('pr').addEventListener('click', () => { paused = !paused; $('pr').textContent = paused ? 'Resume' : 'Pause'; void send({ type: 'widget:action', action: paused ? 'pause' : 'resume' }); });
    $('st').addEventListener('click', () => { void send({ type: 'widget:action', action: 'stop' }); });
    widget = { host, set(pr) {
      $('ph').textContent = pr.running ? (pr.paused ? '· paused' : `· ${pr.phase || 'working'}`) : `· ${pr.stopReason || 'finished'}`;
      $('ct').textContent = `${pr.found ?? 0} read · ${pr.saved ?? 0} saved · ${pr.skipped ?? 0} skipped${pr.errors?.length ? ` · ${pr.errors.length} errors` : ''}`;
      ($('pb') as HTMLElement).style.width = pr.running ? `${Math.min(95, 10 + (pr.page || 1) * 8)}%` : '100%';
      ($('pr') as HTMLButtonElement).disabled = !pr.running; ($('st') as HTMLButtonElement).disabled = !pr.running;
      if (!pr.running) setTimeout(() => { host.remove(); widget = null; }, 6000);
    } };
  }
  widget.set(p);
}

// ------------------------------------------------------------------ element picker
let picking: { stop(): void } | null = null;
function startPicker() {
  picking?.stop();
  const box = document.createElement('div'); box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #4570B6;background:rgba(69,112,182,.18);border-radius:3px;display:none';
  const tip = document.createElement('div'); tip.style.cssText = 'position:fixed;z-index:2147483647;background:#231F20;color:#CAEBFB;font:12px Jost,system-ui;padding:3px 8px;border-radius:6px;pointer-events:none;display:none';
  document.documentElement.append(box, tip);
  let last: Element | null = null;
  const over = (e: MouseEvent) => { const el = e.target as Element; if (!el || el === box || el === tip || el.id === 'viercrm-widget') return; last = el; const r = el.getBoundingClientRect(); Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` }); tip.textContent = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/)[0]}` : ''} — click to pick, Esc to cancel`; Object.assign(tip.style, { display: 'block', left: `${Math.min(r.left, innerWidth - 320)}px`, top: `${Math.max(4, r.top - 24)}px` }); };
  const click = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); if (last) void send({ type: 'picker:result', result: describePick(last) }); stop(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(); };
  const stop = () => { document.removeEventListener('mouseover', over, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); box.remove(); tip.remove(); picking = null; };
  document.addEventListener('mouseover', over, true); document.addEventListener('click', click, true); document.addEventListener('keydown', key, true);
  picking = { stop };
}

// ------------------------------------------------------------------ message handling
// Always install: a copy injected by an earlier version of the extension may still sit in an already-open tab (a page is not reloaded when the
// extension is updated). The old guard "install only once" kept that stale code in charge; now the previous copy is switched off first.
if (typeof window.__vierCrm === 'function') { try { window.__vierCrm(); } catch { /* the old context is gone */ } }
{
  const listener = (msg: TabRequest, _sender: chrome.runtime.MessageSender, respond: (r?: unknown) => void) => {
    (async () => {
      switch (msg.type) {
        case 'crawl:page': { currentCfg = msg.config; respond(msg.config.maps || isMapsPage(document) ? await crawlMaps(document, msg.config, msg.state, makeIO()) : await crawlPage(document, msg.config, msg.state, makeIO())); return; }
        case 'crawl:extractHere': {
          // a Google Maps place opened in a hidden tab: wait for its address / phone rows, then read them
          if (isMapsPage(document) && !findFeed(document)) { await waitFor(() => isPlacePage(document), { timeout: 14000, interval: 400 }); await sleep(600); respond({ extracted: placeAsExtracted(document, location.href) }); return; }
          if (/(^|\.)google\.[a-z.]+$/i.test(location.hostname) && /^\/maps|consent|sorry/.test(location.pathname + location.hostname)) { respond({ extracted: null }); return; }          // a Google consent / "unusual traffic" page is not a profile – never read it as one
          // a profile opened in a hidden tab: wait for the page to finish drawing, then read it
          const items = msg.config.list.kind === 'items';          // a company page's heading is not a person's name – any heading will do
          await waitFor(() => (text(document.body).length > 250 && Array.from(document.querySelectorAll('h1')).some(h => items ? !!(h.textContent || '').trim() : looksLikeName(h.textContent || ''))) || text(document.body).length > 1500, { timeout: 12000, interval: 400 });
          respond({ extracted: extractPerson(document, msg.config, { url: location.href, scope: 'profile', kind: msg.config.list.kind }) }); return;
        }
        case 'detect:preview': {
          if (isMapsPage(document)) {
            await waitFor(() => readCards(document).length > 0 || isPlacePage(document), { timeout: 6000, interval: 300 });
            const cards = readCards(document); const sample = cards.slice(0, 12).map(p => ({ name: p.name, url: p.href, position: [p.category, p.rating ? `★ ${p.rating}${p.reviews ? ` (${p.reviews})` : ''}` : ''].filter(Boolean).join(' · '), department: p.address, phone: p.phone, website: p.website }));
            respond({ maps: true, first: null, next: null, count: cards.length, withPhone: cards.filter(p => p.phone).length, withWebsite: cards.filter(p => p.website).length, withAddress: cards.filter(p => p.address).length, query: searchQueryOf(location.href), title: document.title, url: location.href, sample }); return;
          }
          const cards = detectPeople(document, { cardSelector: msg.config.list.auto ? undefined : msg.config.list.cardSelector, linkSelector: msg.config.list.auto ? undefined : msg.config.list.linkSelector, baseUrl: location.href, kind: msg.config.list.kind });
          const nx = findNext(document, location.href, msg.config.pagination, 1, cards.length);
          respond({ first: findFirst(document, location.href), next: { url: nx.url, how: nx.how, evidence: nx.evidence, pagerSeen: nx.pagerSeen }, count: cards.length, title: document.title, url: location.href, sample: cards.slice(0, 12).map(c => ({ name: c.name, url: c.url, position: c.facts.position, department: c.facts.department, email: c.facts.email })) }); return;
        }
        case 'detect:first': respond({ first: findFirst(document, location.href), url: location.href }); return;
        case 'picker:start': startPicker(); respond({ ok: true }); return;
        case 'picker:stop': picking?.stop(); respond({ ok: true }); return;
        case 'widget:progress': showWidget(msg.progress); respond({ ok: true }); return;
      }
    })().catch(e => respond({ error: String(e?.message || e) }));
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  window.__vierCrm = () => { try { chrome.runtime.onMessage.removeListener(listener); } catch { /* ignore */ } };
}
