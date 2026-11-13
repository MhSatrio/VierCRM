// Background service worker: owns the scrape run, the automation engine, scheduled work and every network call to research / e-mail APIs.
// (Pages never call those APIs directly – that keeps API keys in one place and lets long jobs outlive the side panel.)
import * as DB from '../core/db';
import * as S from '../core/store';
import { buildDedupeIndex } from '../core/dedupe';
import { getSecrets, getSettings } from '../core/settings';
import type { ScrapeConfig, ScrapeProgress, ScrapedPerson } from '../core/types';
import type { BgRequest, ContentRequest, TabRequest } from '../shared/messages';
import { Engine } from '../automation/engine';
import { runLookups, searchPublication, resolveChoice } from '../research/lookup';
import { autoResearchRecords, autoResearchTick } from '../research/auto';
import { SOURCES } from '../research/sources';
import { PAGE_EXTRACTORS } from '../research/pageExtractors';
import { findNextUrl, pageNumberFromUrl } from '../scrape/paginate';
import { isMapsUrl, mapsSearchUrl } from '../scrape/maps';
import { siteContacts, type SiteContacts } from '../scrape/siteContacts';
import type { Ctx } from '../research/http';
import { sendRecordEmail } from '../email/service';
import { verifySender } from '../email/brevo';
import { connectGmail } from '../email/gmail';
import { applyEvent, pullWebhookBackend, syncBrevo } from '../email/analytics';
import type { Extracted } from '../scrape/extract';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const rand = (a: number, b: number) => Math.floor(a + Math.random() * Math.max(0, b - a));

// ------------------------------------------------------------------ tabs
/** A freshly created tab: done when it reports "complete" for a real URL (the stale about:blank "complete" is ignored). */
function waitTabComplete(tabId: number, timeout = 25000): Promise<boolean> {
  return new Promise(resolve => {
    const done = (v: boolean) => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(on); resolve(v); };
    const timer = setTimeout(() => done(false), timeout);
    const real = (u?: string) => !!u && u !== 'about:blank' && !u.startsWith('chrome://newtab');
    const on = (id: number, info: { status?: string }, tab: chrome.tabs.Tab) => { if (id === tabId && info.status === 'complete' && real(tab.url)) done(true); };
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete' && real(t.url)) done(true); }).catch(() => done(false));   // it may have finished before we started listening
    // "complete" also waits for every image and tracking script, which can take very long (or never end) on busy sites: the page can be read
    // as soon as its DOM is ready, so also poll document.readyState
    const poll = setInterval(() => {
      chrome.scripting.executeScript({ target: { tabId }, func: () => [document.readyState, location.href] }).then(r => { const [st, href] = (r?.[0]?.result as [string, string]) || []; if ((st === 'interactive' || st === 'complete') && real(href)) { clearInterval(poll); done(true); } }).catch(() => {});
    }, 400);
    const stop = () => clearInterval(poll); setTimeout(stop, timeout + 500);
  });
}
async function navigate(tabId: number, url: string): Promise<boolean> {
  // attach the listener BEFORE navigating (a fast page can finish before tabs.update resolves) and only trust a "complete" that follows OUR navigation
  const before = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
  const p = new Promise<boolean>(resolve => {
    let began = false; const done = (v: boolean) => { clearTimeout(timer); clearInterval(poll); chrome.tabs.onUpdated.removeListener(on); resolve(v); };
    const timer = setTimeout(() => done(false), 45000);
    const on = (id: number, info: { status?: string }) => { if (id !== tabId) return; if (info.status === 'loading') began = true; if (info.status === 'complete' && began) done(true); };
    chrome.tabs.onUpdated.addListener(on);
    // The browser's "complete" waits for every image, font and tracking script – on a heavy site that takes very long or never comes.
    // The list can be read as soon as the NEW document's DOM is ready, so also poll it (a different URL than before = the new document).
    const poll = setInterval(() => {
      if (!began) return;
      chrome.scripting.executeScript({ target: { tabId }, func: () => [document.readyState, location.href] }).then(r => { const [st, href] = (r?.[0]?.result as [string, string]) || []; if ((st === 'interactive' || st === 'complete') && href && href !== before && href !== 'about:blank') done(true); }).catch(() => {});
    }, 400);
  });
  await chrome.tabs.update(tabId, { url });
  return p;
}
const inject = (tabId: number) => chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
const toTab = <T = any>(tabId: number, m: TabRequest): Promise<T> => chrome.tabs.sendMessage(tabId, m);

async function renderInHiddenTab(url: string, config: ScrapeConfig): Promise<Extracted | null> {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    if (!(await waitTabComplete(tab.id!, 25000))) { console.warn('VierCRM: profile tab did not finish loading', url); return null; }
    await inject(tab.id!);
    const r = await toTab<{ extracted?: Extracted; error?: string }>(tab.id!, { type: 'crawl:extractHere', config });
    if (!r?.extracted) console.warn('VierCRM: profile render gave nothing', url, JSON.stringify(r)?.slice(0, 200));
    return r?.extracted ?? null;
  } finally { chrome.tabs.remove(tab.id!).catch(() => {}); }
}

// ------------------------------------------------------------------ research context
let lastRendered = 0;
async function renderForExtractor(url: string, extractor: 'scholar' | 'researchgate'): Promise<unknown> {
  const wait = 8000 - (Date.now() - lastRendered); if (wait > 0) await sleep(wait);          // one page per 8 s – a person's pace
  lastRendered = Date.now();
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitTabComplete(tab.id!, 25000); await sleep(1200);
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: PAGE_EXTRACTORS[extractor] });
    return res?.result;
  } finally { chrome.tabs.remove(tab.id!).catch(() => {}); }
}
async function makeCtx(): Promise<Ctx> { return { fetch: (u, i) => fetch(u, i), settings: await getSettings(), secrets: await getSecrets(), sleep, now: () => new Date(), renderPage: renderForExtractor }; }
async function makeEngine() { const research = await makeCtx(); return new Engine({ research, email: { fetch: (u, i) => fetch(u, i), now: () => new Date(), settings: research.settings, secrets: research.secrets }, now: () => new Date() }); }

// ------------------------------------------------------------------ scrape run
interface Run { progress: ScrapeProgress; stop: boolean; paused: boolean; tabId: number; cfg: ScrapeConfig; tableId: string; fields: Awaited<ReturnType<typeof S.listFields>>; index: ReturnType<typeof buildDedupeIndex>; /** websites already looked at in this run (branches of one chain share one) */ sites: Map<string, SiteContacts> }
let run: Run | null = null; let keepAlive: ReturnType<typeof setInterval> | null = null;

function publish() {
  if (!run) return; run.progress.updatedAt = Date.now();
  chrome.runtime.sendMessage({ type: 'scrape:progress', progress: run.progress }).catch(() => {});
  chrome.tabs.sendMessage(run.tabId, { type: 'widget:progress', progress: run.progress } satisfies TabRequest).catch(() => {});
  chrome.storage.session?.set({ scrapeProgress: run.progress }).catch(() => {});
}

async function startScrape(tabId: number, cfg: ScrapeConfig, tableId: string) {
  if (run?.progress.running) throw new Error('A scrape is already running – stop it first.');
  await S.ensureSeeded();
  const fields = await S.listFields(tableId); const index = buildDedupeIndex(await S.listRecords(tableId), await S.getDedupeRules(tableId));
  const tab = await chrome.tabs.get(tabId);
  run = { tabId, cfg, tableId, fields, index, sites: new Map(), stop: false, paused: false, progress: { running: true, paused: false, phase: 'starting', page: 0, found: 0, saved: 0, skipped: 0, errors: [], startedAt: Date.now(), updatedAt: Date.now(), configId: cfg.id, url: tab.url } };
  keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo(); }, 20000);
  publish(); void crawl(run);
}

/** Google Maps: every search is one scrolling list – read the one on screen, then one search after another for the extra queries of the configuration. */
async function crawlMapsSearches(r: Run) {
  const pg = r.cfg.pagination; let seen: string[] = []; let recordsLeft = pg.maxRecords;
  const queries = (r.cfg.maps?.queries || []).map(q => q.trim()).filter(Boolean);
  // more searches open on the site the user is on (google.co.id, google.de …) so the results keep their country and language
  const origin = (() => { try { const u = new URL(r.progress.url || ''); return u.pathname.startsWith('/maps') ? u.origin : 'https://www.google.com'; } catch { return 'https://www.google.com'; } })();
  const searches: (string | null)[] = [null, ...queries.map(q => mapsSearchUrl(q, origin))];
  for (let i = 0; i < searches.length && !r.stop; i++) {
    r.progress.page = i + 1;
    if (searches[i]) {
      r.progress.phase = `opening search ${i + 1} of ${searches.length}: ${queries[i - 1]}`; publish(); await sleep(rand(2500, 4500));          // a person's pace between searches
      if (!(await navigate(r.tabId, searches[i]!))) { r.progress.errors.push(`The search “${queries[i - 1]}” did not finish loading.`); continue; }
    }
    r.progress.phase = searches.length > 1 ? `reading search ${i + 1} of ${searches.length}` : 'reading the Google Maps list'; publish();
    await inject(r.tabId);
    const res = await toTab<any>(r.tabId, { type: 'crawl:page', config: r.cfg, state: { seen, pageIndex: i + 1, recordsLeft, pagesLeft: searches.length - i } });
    if (!res || res.error) { r.progress.errors.push(res?.error || 'The page did not answer (was it closed or reloaded?)'); r.progress.stopReason = 'page not readable'; break; }
    seen = res.seen; recordsLeft -= res.found; r.progress.errors.push(...res.errors.slice(0, 5));
    r.progress.stopReason = res.stopReason || r.progress.stopReason;
    if (res.stopReason === 'stopped' || r.stop) { r.progress.stopReason = 'stopped by you'; break; }
    if (recordsLeft <= 0) { r.progress.stopReason = `reached the limit of ${pg.maxRecords} records`; break; }
  }
  if (!r.progress.stopReason) r.progress.stopReason = r.stop ? 'stopped by you' : 'end of the list reached';
}

async function crawl(r: Run) {
  const pg = r.cfg.pagination; const visited = new Set<string>(); let seen: string[] = []; let recordsLeft = pg.maxRecords; let empty = 0;
  try {
    if (r.cfg.maps || isMapsUrl((await chrome.tabs.get(r.tabId)).url || '')) { await crawlMapsSearches(r); return; }          // (the finally block below still runs)
    // the tab may be on a later page of the list (a scrape only moves forward): open the first page first
    if (pg.startFromFirst !== false && pg.mode === 'url' && pg.urlTemplate) {
      // URL pattern: the first page is the pattern with the first page number; go there when the tab is on a later one
      const here = (await chrome.tabs.get(r.tabId)).url || ''; const cur = pageNumberFromUrl(pg.urlTemplate, here); const first = pg.startPage ?? 1;
      if (cur != null && cur > first) { r.progress.phase = 'opening the first page of the list'; publish(); const target = pg.urlTemplate.replace('{page}', String(first)); if (!(await navigate(r.tabId, target))) r.progress.errors.push('The first page did not finish loading – reading from the current page instead.'); }
    }
    if (pg.startFromFirst !== false && pg.mode !== 'url' && pg.mode !== 'infinite' && pg.mode !== 'loadMore' && pg.mode !== 'none') {
      try {
        r.progress.phase = 'checking whether this is the first page'; publish(); await inject(r.tabId);
        const f = await toTab<{ first?: string | null; url?: string }>(r.tabId, { type: 'detect:first' });
        if (f?.first) { r.progress.phase = 'opening the first page of the list'; publish(); if (!(await navigate(r.tabId, f.first))) { r.progress.errors.push('The first page did not finish loading – reading from the current page instead.'); } }
      } catch (e: any) { r.progress.errors.push('Could not check for an earlier page: ' + String(e?.message || e)); }
    }
    for (let page = 1; page <= pg.maxPages && !r.stop; page++) {
      r.progress.page = page; r.progress.phase = `reading page ${page}`; publish();
      const url = (await chrome.tabs.get(r.tabId)).url || ''; visited.add(url);
      await inject(r.tabId);
      const res = await toTab<any>(r.tabId, { type: 'crawl:page', config: r.cfg, state: { seen, pageIndex: page, recordsLeft, pagesLeft: pg.maxPages - page + 1 } });
      if (!res || res.error) { r.progress.errors.push(res?.error || 'The page did not answer (was it closed or reloaded?)'); r.progress.stopReason = 'page not readable'; break; }
      seen = res.seen; recordsLeft -= res.found; r.progress.errors.push(...res.errors.slice(0, 5));
      empty = res.newOnPage === 0 ? empty + 1 : 0;
      if (res.stopReason === 'stopped' || r.stop) { r.progress.stopReason = 'stopped by you'; break; }
      if (recordsLeft <= 0) { r.progress.stopReason = `reached the limit of ${pg.maxRecords} records`; break; }
      if (empty >= pg.stopAfterEmptyPages) { r.progress.stopReason = `${empty} page(s) in a row with nobody new`; break; }
      if (res.finished || !res.nextUrl) { r.progress.stopReason = res.stopReason || 'last page reached'; break; }
      if (visited.has(res.nextUrl)) { r.progress.stopReason = 'pagination loops back to a page already read'; break; }
      while (r.paused && !r.stop) await sleep(500);
      r.progress.phase = 'opening the next page'; publish(); await sleep(rand(pg.delayMinMs, pg.delayMaxMs));
      if (!(await navigate(r.tabId, res.nextUrl))) { r.progress.errors.push('The next page did not finish loading.'); r.progress.stopReason = 'next page did not load'; break; }
      if (page === pg.maxPages) r.progress.stopReason = `reached the limit of ${pg.maxPages} pages`;
    }
    if (!r.progress.stopReason) r.progress.stopReason = r.stop ? 'stopped by you' : `reached the limit of ${pg.maxPages} pages`;
  } catch (e: any) { r.progress.errors.push(String(e?.message || e)); r.progress.stopReason = 'error'; }
  finally {
    r.progress.running = false; r.progress.phase = 'finished'; if (keepAlive) clearInterval(keepAlive); keepAlive = null; publish();
    await DB.kvSet('lastScrape', r.progress);
  }
}

async function handlePerson(p: ScrapedPerson) {
  if (!run) return { action: 'skipped' as const };
  const r = await S.intakePerson(run.tableId, run.fields, p, run.index, { configId: run.cfg.id });
  if (r.action === 'created') run.progress.saved++; else run.progress.skipped++;
  run.progress.found++; if (p.status === 'failed') run.progress.errors.push(`${p.profileUrl || 'a card'}: ${p.error || 'nothing readable'}`);
  publish();
  if (r.record && (r.action === 'created' || r.action === 'merged')) { try { await (await makeEngine()).fire('scrapingCompleted', r.record.id, p.profileUrl); } catch (e) { console.warn('scrapingCompleted automation failed', e); } }
  return { action: r.action };
}

// ------------------------------------------------------------------ message router
type Handler = (m: any, sender: chrome.runtime.MessageSender) => Promise<any> | any;
const handlers: Record<string, Handler> = {
  ping: () => ({ ok: true }),
  'scrape:start': async (m: Extract<BgRequest, { type: 'scrape:start' }>) => { await startScrape(m.tabId, m.config, m.tableId); return { ok: true }; },
  'scrape:pause': () => { if (run) { run.paused = true; run.progress.paused = true; publish(); } return { ok: true }; },
  'scrape:resume': () => { if (run) { run.paused = false; run.progress.paused = false; publish(); } return { ok: true }; },
  'scrape:stop': () => { if (run) { run.stop = true; run.paused = false; run.progress.phase = 'stopping'; publish(); } return { ok: true }; },
  'scrape:status': async () => ({ progress: run?.progress ?? (await chrome.storage.session?.get('scrapeProgress'))?.scrapeProgress ?? (await DB.kvGet('lastScrape')) }),
  'scrape:control': () => ({ stop: !run || run.stop, paused: !!run?.paused }),
  'scrape:person': (m: Extract<ContentRequest, { type: 'scrape:person' }>) => handlePerson(m.person),
  'scrape:site': async (m: Extract<ContentRequest, { type: 'scrape:site' }>) => {
    // cached per website ADDRESS (not per host: many sites share one – a path on a site builder, a Facebook page); branches of one chain share the address
    let key = ''; try { const u = new URL(m.url); key = `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase(); } catch { return { site: null }; }
    const hit = run?.sites.get(key); if (hit) return { site: hit };
    const site = await siteContacts(m.url, { fetch: (u, i) => fetch(u, i), sleep }); run?.sites.set(key, site); return { site };
  },
  'scrape:render': async (m: Extract<ContentRequest, { type: 'scrape:render' }>) => ({ extracted: await renderInHiddenTab(m.url, m.config).catch(() => null) }),
  'scrape:progress-lite': (m: Extract<ContentRequest, { type: 'scrape:progress-lite' }>) => { if (run) { Object.assign(run.progress, { phase: m.patch.phase }); publish(); } return { ok: true }; },
  'widget:action': (m: any) => handlers[`scrape:${m.action}`]({}, {} as any),
  'scrape:preview': async (m: Extract<BgRequest, { type: 'scrape:preview' }>) => { await inject(m.tabId); return toTab(m.tabId, { type: 'detect:preview', config: m.config }); },
  'picker:start': async (m: any) => { await inject(m.tabId); return toTab(m.tabId, { type: 'picker:start' }); },
  'picker:stop': async (m: any) => toTab(m.tabId, { type: 'picker:stop' }).catch(() => ({ ok: true })),
  'picker:result': (m: any) => { chrome.runtime.sendMessage({ type: 'picker:picked', result: m.result }).catch(() => {}); return { ok: true }; },

  'record:changed': async (m: any) => { await (await makeEngine()).handleChange(m.change); return { ok: true }; },
  'lookup:run': async (m: Extract<BgRequest, { type: 'lookup:run' }>) => {
    const run1 = await runLookups(m.recordId, await makeCtx(), { fieldIds: m.fieldIds, force: m.force, choice: m.choice });
    if (run1.found) await (await makeEngine()).fire('publicationFound', m.recordId, JSON.stringify(run1.record.meta?.publications ?? {}).slice(0, 200));
    return { ok: true, run: run1 };
  },
  'lookup:many': async (m: Extract<BgRequest, { type: 'lookup:many' }>) => {
    const ctx = await makeCtx(); const out: any[] = []; let i = 0;
    for (const id of m.recordIds) {
      try { const r = await runLookups(id, ctx, { fieldIds: m.fieldIds, force: m.force }); out.push({ id, found: r.found, reports: r.reports.length }); if (r.found) await (await makeEngine()).fire('publicationFound', id, id); }
      catch (e: any) { out.push({ id, error: String(e?.message || e) }); }
      chrome.runtime.sendMessage({ type: 'lookup:progress', done: ++i, total: m.recordIds.length }).catch(() => {});
    }
    return { ok: true, results: out };
  },
  'author:search': async (m: Extract<BgRequest, { type: 'author:search' }>) => {
    const ctx = await makeCtx(); const q = { name: m.name, institution: m.institution || undefined };
    const opts = { yearFrom: m.yearFrom, yearTo: m.yearTo, mustContain: m.mustContain };
    const candidates: any[] = []; const errors: string[] = [];
    for (const id of m.sources) { const src = SOURCES[id]; if (src?.kind === 'author') { try { candidates.push(...(await src.candidates(ctx, q))); } catch (e: any) { errors.push(`${id}: ${e?.message || e}`); } } }
    const outcome = await searchPublication(ctx, q, m.sources as any, opts);
    return { ok: true, outcome, candidates: candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 12), errors };
  },
  'author:latest': async (m: Extract<BgRequest, { type: 'author:latest' }>) => ({ ok: true, publication: await resolveChoice(await makeCtx(), m.candidate, { yearFrom: m.yearFrom, yearTo: m.yearTo, mustContain: m.mustContain }) }),

  'auto:now': async (m: any) => ({ ok: true, ...(await autoStep(m.tableId ? [m.tableId] : [])) }),
  'auto:records': async (m: any) => {
    if (autoBusy) return { ok: true, done: 0, busy: true }; autoBusy = true;
    try { const t = await S.getTable(m.tableId); if (!t) return { ok: true, done: 0 }; const done = await autoResearchRecords(t, await makeCtx(), m.recordIds || []); for (const d of done) if (d.outcome === 'found') { try { await (await makeEngine()).fire('publicationFound', d.recordId, d.recordId); } catch { /* ignore */ } } return { ok: true, done: done.length, outcomes: done.map(d => d.outcome) }; }
    finally { autoBusy = false; }
  },
  'auto:run': async (m: Extract<BgRequest, { type: 'auto:run' }>) => ({ ok: true, runs: await (await makeEngine()).runManual(m.automationId, m.recordIds, { testMode: m.testMode }) }),
  'auto:retry': async (m: Extract<BgRequest, { type: 'auto:retry' }>) => ({ ok: true, run: await (await makeEngine()).retryRun(m.runId) }),

  'email:send': async (m: Extract<BgRequest, { type: 'email:send' }>) => { const ctx = await makeCtx(); return { ok: true, outcome: await sendRecordEmail({ fetch: ctx.fetch, now: () => new Date(), settings: ctx.settings, secrets: ctx.secrets }, m) }; },
  'email:sync': async () => { const ctx = await makeCtx(); const d = { fetch: ctx.fetch, now: () => new Date(), settings: ctx.settings, secrets: ctx.secrets }; const [a, b] = await Promise.all([syncBrevo(d), ctx.settings.webhookUrl ? pullWebhookBackend(d) : Promise.resolve({ applied: 0 })]); return { ok: true, brevo: a, webhook: b }; },
  'email:verifyBrevo': async (m: Extract<BgRequest, { type: 'email:verifyBrevo' }>) => { const ctx = await makeCtx(); try { return { ok: true, result: await verifySender({ fetch: ctx.fetch, apiKey: ctx.secrets.brevoApiKey, base: ctx.settings.apiBases.brevo }, m.sender) }; } catch (e: any) { return { ok: false, error: String(e?.message || e) }; } },
  'gmail:connect': async () => { try { const a = await connectGmail({ fetch: (u, i) => fetch(u, i), now: () => Date.now() }); return { ok: true, email: a.email, sendAs: a.sendAs }; } catch (e: any) { return { ok: false, error: String(e?.message || e) }; } },
};

chrome.runtime.onMessage.addListener((msg: { type: string }, sender, respond) => {
  const h = handlers[msg?.type]; if (!h) return false;
  Promise.resolve().then(() => h(msg, sender)).then(respond, e => respond({ ok: false, error: String(e?.message || e) }));
  return true;
});

// changes made by the background itself (automation writes, lookups) must reach the engine too
S.onChange(async c => { markDirty(c.tableId); await (await makeEngine()).handleChange(c); });

// ------------------------------------------------------------------ auto-research
// Only bases that changed since the last scan are looked at (a service-worker restart marks every auto base as changed once).
const dirty = new Set<string>(); let autoBusy = false; let primed = false;
function markDirty(tableId: string) { dirty.add(tableId); }
async function autoStep(force: string[] = []) {
  if (autoBusy) return { done: 0 }; autoBusy = true;
  try {
    await S.ensureSeeded();
    if (!primed) { primed = true; for (const t of await S.listTables()) if (t.autoResearch) dirty.add(t.id); }
    for (const id of force) dirty.add(id);
    const ids = [...dirty]; if (!ids.length) return { done: 0 };
    const r = await autoResearchTick(await makeCtx(), ids);
    for (const id of ids) if (!r.pending.includes(id)) dirty.delete(id);
    for (const d of r.done) if (d.outcome === 'found') { try { await (await makeEngine()).fire('publicationFound', d.recordId, d.recordId); } catch { /* ignore */ } }
    if (r.done.length) chrome.runtime.sendMessage({ type: 'auto:progress', done: r.done.length }).catch(() => {});
    return { done: r.done.length };
  } finally { autoBusy = false; }
}

// ------------------------------------------------------------------ lifecycle, schedule
chrome.runtime.onInstalled.addListener(async () => { await S.ensureSeeded(); await chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); chrome.alarms.create('tick', { periodInMinutes: 1 }); });
chrome.runtime.onStartup.addListener(() => { chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); chrome.alarms.create('tick', { periodInMinutes: 1 }); });
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'tick') return;
  try {
    const eng = await makeEngine(); await eng.processPending(); await eng.runDueScheduled(); await autoStep();
    const s = await getSettings(); const last = (await DB.kvGet<number>('lastEmailSync', 0)) || 0;
    if ((await getSecrets()).brevoApiKey && Date.now() - last > s.brevoSyncMinutes * 60000) { await DB.kvSet('lastEmailSync', Date.now()); await handlers['email:sync']({}, {} as any); }
  } catch (e) { console.warn('scheduled tick failed', e); }
});

void applyEvent; void findNextUrl;
