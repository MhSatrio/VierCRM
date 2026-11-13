// End-to-end test: the REAL built extension in Chromium against a fictional university site and FAKE research / e-mail APIs on localhost.
//   npm run build && npm run e2e         (HEADED=1 to watch)
// Nothing here talks to a real service, and no real e-mail can be sent (the "Brevo" is a local fake).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, PEOPLE } from '../fixtures/site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'tests/e2e/out'); fs.mkdirSync(out, { recursive: true });
const exe = process.env.CHROMIUM || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1248/chrome-win64/chrome.exe');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail && !ok ? `  → ${String(detail).slice(0, 300)}` : ''}`); };
const step = s => console.log(`\n▶ ${s}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const fx = await startFixtureServer(); const B = fx.url; const host = new URL(B).host;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'viercrm-e2e-'));
const extDir = path.join(userData, 'ext');
if (!fs.existsSync(path.join(root, 'dist/manifest.json'))) { console.error('dist/ not found – run `npm run build` first'); process.exit(2); }
fs.cpSync(path.join(root, 'dist'), extDir, { recursive: true });
// The browser test cannot click Chrome's permission prompt, so the TEST COPY of the manifest holds the broad host access that the real
// extension asks for at run time (optional_host_permissions). Everything else is the production build.
const mf = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
mf.host_permissions.push('https://*/*', 'http://*/*'); fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(mf, null, 2));
const ctx = await chromium.launchPersistentContext(userData, { executablePath: exe, headless: false, args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...(process.env.HEADED ? [] : ['--headless=new']), '--no-first-run', '--window-size=1400,950'], viewport: { width: 1360, height: 900 }, acceptDownloads: true });

var finishCode = 0;
try {
  step('Extension loads');
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  const prod = JSON.parse(fs.readFileSync(path.join(root, 'dist/manifest.json'), 'utf8'));
  check('Manifest V3 with side panel, service worker and no standing broad host access', prod.manifest_version === 3 && !!prod.side_panel && !prod.host_permissions.some(h => h === '<all_urls>' || h === 'https://*/*' || h === 'http://*/*') && prod.optional_host_permissions.includes('https://*/*'), JSON.stringify(prod.host_permissions));
  const siteIcon = path.resolve(root, '../vierapparatus/src/app/icon.svg');
  check('brand: Jost font bundled (latin only), icons rendered from the website’s own icon.svg, wordmark bundled', fs.readdirSync(path.join(root, 'dist/assets')).filter(f => /jost/i.test(f)).every(f => /latin-(400|600)-normal/.test(f) && f.endsWith('.woff2') || !f.endsWith('.woff2') && /latin-(400|600)/.test(f)) && [16, 32, 48, 128].every(n => fs.existsSync(path.join(root, `dist/icons/icon${n}.png`))) && fs.readFileSync(path.join(root, 'dist/brand/icon.svg'), 'utf8') === fs.readFileSync(path.join(root, 'assets/icon.svg'), 'utf8') && (!fs.existsSync(siteIcon) || fs.readFileSync(siteIcon, 'utf8') === fs.readFileSync(path.join(root, 'assets/icon.svg'), 'utf8')) && fs.existsSync(path.join(root, 'dist/brand/vier-black.svg')));

  const app = await ctx.newPage(); const errors = [];
  app.on('pageerror', e => errors.push(String(e))); app.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/`); await app.waitForSelector('.tile .v', { timeout: 20000 });
  await app.waitForFunction(() => !!window.__vier);
  const ev = (fn, arg) => app.evaluate(fn, arg);
  const send = msg => app.evaluate(m => new Promise(r => chrome.runtime.sendMessage(m, r)), msg);
  await app.screenshot({ path: path.join(out, '01-dashboard.png') });
  const navText = await app.locator('nav.nav').innerText();
  check('dashboard renders in the website style: wordmark logo, bases listed, nothing called “Research Contacts”', (await app.locator('.brand img[src*="vier-black.svg"]').count()) === 1 && (await app.locator('nav.nav a').count()) === 11 && /Researchers/.test(navText) && /Contacts/.test(navText) && /Companies/.test(navText) && /Add base/.test(navText) && /Research Finder/.test(navText) && !/Research Contacts/.test(await app.locator('body').innerText()), navText);
  check('the wordmark image really loads', await app.evaluate(() => { const i = document.querySelector('.brand img'); return i.complete && i.naturalWidth > 50; }));
  const tables = await ev(async () => (await window.__vier.S.listFields('tbl_research')).length);
  check('three bases seeded (Researchers with 11 views and its field set, Contacts, Companies)', tables >= 30 && (await ev(async () => (await window.__vier.S.listViews('tbl_research')).length)) === 11 && (await ev(async () => (await window.__vier.S.listTables()).map(t => t.name).join()) === 'Researchers,Contacts,Companies'));
  const css = await app.evaluate(() => { const b = document.createElement('button'); b.textContent = 'x'; document.body.append(b); const c = getComputedStyle(b); const o = { color: c.color, bg: c.backgroundColor, border: c.borderTopColor, bw: c.borderTopWidth }; b.remove(); const p = document.createElement('button'); p.className = 'primary'; document.body.append(p); const d = getComputedStyle(p); o.pbg = d.backgroundColor; o.pcolor = d.color; p.remove(); o.font = getComputedStyle(document.body).fontFamily; return o; });
  check('buttons follow the website: white secondary with a 2px blue border and blue text; primary blue with white text; Jost', css.color === 'rgb(69, 112, 182)' && css.bg === 'rgb(255, 255, 255)' && css.bw === '2px' && css.pbg === 'rgb(69, 112, 182)' && css.pcolor === 'rgb(255, 255, 255)' && /Jost/.test(css.font), JSON.stringify(css));

  // ---------- point every research / e-mail source at the local fakes
  await ev(async ([base]) => { await window.__vier.settings.saveSettings({ apiBases: { openalex: `${base}/openalex`, crossref: `${base}/crossref`, semanticscholar: `${base}/semanticscholar`, pubmed: `${base}/pubmed`, unpaywall: `${base}/unpaywall`, europepmc: `${base}/europepmc`, scholar: base, brevo: `${base}/brevo/v3` }, unpaywallEmail: 'tester@test.invalid', lookupDelayMs: 0, minSendGapSec: 0 }); await new Promise(r => chrome.storage.local.set({ secrets: { brevoApiKey: 'test-key' } }, r)); }, [B]);

  await ev(async () => { await window.__vier.S.setAutoResearch('tbl_research', false); });          // the older steps below drive research by hand; automatic research has its own step at the end
  const wipeRecords = () => ev(async () => { const ids = (await window.__vier.S.listRecords('tbl_research')).map(r => r.id); await window.__vier.DB.delMany('records', ids); });
  const fixtureTab = await ctx.newPage(); await fixtureTab.goto(`${B}/`);
  const tabId = async () => ev(async ([h]) => (await chrome.tabs.query({ url: `http://${h}/*` }))[0].id, [host]);
  const scrape = async (urlPath, cfgPatch = {}) => {
    await fixtureTab.goto(`${B}${urlPath}`, { waitUntil: 'domcontentloaded' }); await fixtureTab.bringToFront(); await sleep(300);
    const id = await tabId();
    const cfg = await ev(async (patch) => { const c = (await window.__vier.DB.all('configs')).find(x => x.id === 'cfg_university_directory'); return { ...c, ...patch.top, pagination: { ...c.pagination, delayMinMs: 0, delayMaxMs: 0, ...patch.pg } }; }, { top: cfgPatch.top || {}, pg: cfgPatch.pg || {} });
    await send({ type: 'scrape:start', tabId: id, config: cfg, tableId: 'tbl_research' });
    let prog; for (let i = 0; i < 180; i++) { await sleep(500); prog = (await send({ type: 'scrape:status' })).progress; if (prog && !prog.running && prog.phase === 'finished') break; }
    return prog;
  };
  const scrapeTo = async (urlPath, tableId, cfgId, pg = {}) => {
    await fixtureTab.goto(`${B}${urlPath}`, { waitUntil: 'domcontentloaded' }); await fixtureTab.bringToFront(); await sleep(300);
    const id = await tabId();
    const cfg = await ev(async ([cid, patch]) => { const c = (await window.__vier.DB.all('configs')).find(x => x.id === cid); return { ...c, pagination: { ...c.pagination, delayMinMs: 0, delayMaxMs: 0, ...patch } }; }, [cfgId, pg]);
    await send({ type: 'scrape:start', tabId: id, config: cfg, tableId });
    let prog; for (let i = 0; i < 120; i++) { await sleep(500); prog = (await send({ type: 'scrape:status' })).progress; if (prog && !prog.running && prog.phase === 'finished') break; }
    return prog;
  };
  const people = () => ev(async () => (await window.__vier.S.listRecords('tbl_research')).map(r => r.cells));
  const F = k => `fld_${k}`;

  // ================================================================ scraping
  step('Scraping: numbered pagination → profile pages → database (the job-scraper flow)');
  const p1 = await scrape('/dir/static');
  let rows = await people(); const by = name => rows.find(r => String(r[F('fullName')] || '').includes(name));
  check('directory followed to the last page: 3 pages read, stop reason "last page reached"', p1.page === 3 && /last page/.test(p1.stopReason), JSON.stringify({ page: p1.page, reason: p1.stopReason, errors: p1.errors }));
  check(`all ${PEOPLE.length} entries read; the same person listed twice (same e-mail) became ONE record → ${PEOPLE.length - 1} records`, rows.length === PEOPLE.length - 1 && p1.found === PEOPLE.length && p1.saved === PEOPLE.length - 1, `${rows.length} records, found ${p1.found}, saved ${p1.saved}`);
  check('profile read: name, position, department, institution, e-mail, phone, interests, biography', (() => { const r = by('Bram Fixture'); return r && r[F('position')] === 'Associate Professor' && r[F('department')] === 'Department of Biology' && r[F('institution')] === 'Example University' && r[F('email')] === 'bram.fixture@example-university.example' && r[F('phone')] === '+31 20 555 0102' && /cell culture/.test(r[F('researchKeywords')]) && /works on department of biology/.test(r[F('about')]); })(), JSON.stringify(by('Bram Fixture')));
  check('JSON-LD profile (Anna Example) read; first/last name split; Scraping Status = Scraped; Outreach Status = Not Contacted', (() => { const r = by('Anna Example'); return r && r[F('lastName')] === 'Example' && r[F('firstName')] === 'Anna' && r[F('scrapingStatus')] === 'Scraped' && r[F('outreachStatus')] === 'Not Contacted' && /^http/.test(r[F('profileUrl')]) && !!r[F('scrapingDate')] && /dir\/static/.test(r[F('sourceUrl')]); })());
  check('profile rendered by JavaScript (Hana) read via a hidden tab; obfuscated (Fatima) and Cloudflare-encoded (Gustav) e-mails decoded', by('Hana Specimen')?.[F('email')] === 'hana.specimen@example-university.example' && by('Fatima Testwell')?.[F('email')] === 'fatima.testwell@example-university.example' && by('Gustav Dummy')?.[F('email')] === 'gustav.dummy@example-university.example', JSON.stringify([by('Hana Specimen')?.[F('email')], by('Fatima Testwell')?.[F('email')], by('Gustav Dummy')?.[F('email')]]));
  check('missing information stays EMPTY: no e-mail for Dewi; a generic office mailbox is not taken for Erik', by('Dewi Placeholder') && !by('Dewi Placeholder')[F('email')] && by('Erik Mockson') && !by('Erik Mockson')[F('email')]);
  const smiths = rows.filter(r => String(r[F('fullName')]).includes('John Smith'));
  check('two different people called John Smith stay separate records', smiths.length === 2 && smiths[0][F('email')] !== smiths[1][F('email')]);
  const ids = await ev(async () => (await window.__vier.S.listRecords('tbl_research')).filter(r => r.meta?.scrape?.identifiers?.length).map(r => r.meta.scrape.identifiers.length));
  check('ORCID / Scholar links on a profile are kept as identity evidence', ids.length >= 1, JSON.stringify(ids));

  step('Re-scraping: nothing new is added, existing values are never overwritten');
  await ev(async () => { const r = (await window.__vier.S.listRecords('tbl_research')).find(x => String(x.cells.fld_fullName).includes('Bram')); await window.__vier.S.updateRecord(r.id, { fld_position: 'Edited by me' }); });
  const p2 = await scrape('/dir/static'); rows = await people();
  check('second run: 0 new records, my edit survived', p2.saved === 0 && rows.length === PEOPLE.length - 1 && by('Bram Fixture')[F('position')] === 'Edited by me', JSON.stringify({ saved: p2.saved, n: rows.length }));

  step('Scraping: Load more, infinite scroll, in-page Next button, JavaScript-drawn list, profiles on another domain');
  const modes = [['/dir/static?page=3', 23, 'the tab is on the LAST page of the list – the first page is opened first, then everything is read'], ['/dir/nopager?page=1', 23, 'a directory with NO pager in the page, only ?page=N in the address – the next page number is derived and the scrape ends cleanly on the empty page'], ['/dir/hang?page=1', 23, 'a site whose pages never finish loading (a tracker hangs) – every page is still read'], ['/dir/loadmore', 23, 'Load more button'], ['/dir/infinite', 23, 'infinite scrolling'], ['/dir/spa', 23, 'single-page Next button'], ['/dir/jsdir', 10, 'list drawn by JavaScript'], ['/dir/ext', 6, 'profiles on another domain (localhost → hidden-tab render)']];
  await wipeRecords(); const pu = await scrape('/dir/static?page=2', { pg: { mode: 'url', urlTemplate: `${B}/dir/static?page={page}`, startPage: 1 } });
  check('URL-pattern mode, tab on page 2: the first page is opened, the page number is read from the address, all 23 are read', (await people()).length === 23, `${(await people()).length} saved, reason: ${pu.stopReason}`);
  for (const [p, expect, label] of modes) {
    await wipeRecords(); const pr = await scrape(p); const n = (await people()).length;
    check(`${label}: ${expect} people saved`, n === expect, `${n} saved (read ${pr.found}), reason: ${pr.stopReason}, errors: ${(pr.errors || []).slice(0, 2).join(' | ')}`);
  }
  const extRows = await people(); check('cross-domain profiles still yield e-mail addresses', extRows.filter(r => r[F('email')]).length === 6, JSON.stringify(extRows.map(r => r[F('email')])));

  step('Scraping controls: pause, resume, stop, record limit');
  await wipeRecords(); await fixtureTab.goto(`${B}/dir/static`); await fixtureTab.bringToFront(); await sleep(300);
  const tid = await tabId(); const slowCfg = await ev(async () => { const c = (await window.__vier.DB.all('configs')).find(x => x.id === 'cfg_university_directory'); return { ...c, pagination: { ...c.pagination, delayMinMs: 700, delayMaxMs: 700 } }; });
  await send({ type: 'scrape:start', tabId: tid, config: slowCfg, tableId: 'tbl_research' }); await sleep(2500);
  await send({ type: 'scrape:pause' }); await sleep(900); const c1 = (await send({ type: 'scrape:status' })).progress.found; await sleep(1800); const c2 = (await send({ type: 'scrape:status' })).progress.found;
  check('Pause stops reading (the count does not move while paused)', c2 - c1 <= 1 && c1 > 0, `${c1} → ${c2}`);
  await send({ type: 'scrape:resume' }); await sleep(2000); const c3 = (await send({ type: 'scrape:status' })).progress.found; check('Resume continues', c3 > c2, `${c2} → ${c3}`);
  await send({ type: 'scrape:stop' }); let pst; for (let i = 0; i < 40; i++) { await sleep(400); pst = (await send({ type: 'scrape:status' })).progress; if (!pst.running) break; }
  check('Stop ends the run and says so', !pst.running && /stopped/.test(pst.stopReason) && (await people()).length < PEOPLE.length - 1, JSON.stringify({ r: pst.stopReason, n: (await people()).length }));
  await wipeRecords(); const pl = await scrape('/dir/static', { pg: { maxRecords: 5 } });
  check('Record limit respected (5)', (await people()).length === 5 && /limit of 5/.test(pl.stopReason), `${(await people()).length} / ${pl.stopReason}`);

  // restore the full set for the remaining steps
  await wipeRecords(); await scrape('/dir/static'); rows = await people();
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/contacts`); await app.waitForSelector('.g-row', { timeout: 15000 });
  await app.screenshot({ path: path.join(out, '02-contacts-grid.png') });
  check('Researchers grid (opened with the old #/contacts link) shows the scraped people (virtualised rows)', (await app.locator('.g-row').count()) > 5 && /23 shown/.test(await app.locator('.tv-bar').innerText()), await app.locator('.tv-bar').innerText());

  // ================================================================ views
  step('Views and filters');
  const viewCount = async name => { await app.locator('.tv-views button', { hasText: new RegExp(`^${name}$`) }).click(); await sleep(350); return Number(((await app.locator('.tv-bar .muted.small').first().innerText()).match(/([\d,]+) shown/) || [])[1]?.replace(/,/g, '')); };
  const missingEmail = rows.filter(r => !r[F('email')]).length; const ready = rows.filter(r => r[F('email')] && r[F('position')] && r[F('institution')] && r[F('outreachStatus')] === 'Not Contacted').length;
  check(`“Missing Email” view shows exactly the ${missingEmail} people without an e-mail`, (await viewCount('Missing Email')) === missingEmail && missingEmail === 2);
  check(`“Ready for Outreach” view shows exactly the ${ready} qualifying people`, (await viewCount('Ready for Outreach')) === ready, ready);
  check('“Missing Publication” shows everyone (no research done yet); “Failed Scraping” shows nobody', (await viewCount('Missing Publication')) === 23 && (await viewCount('Failed Scraping')) === 0);
  // build my own view through the UI: Full Name is not empty AND Latest Publication is empty (the brief's "Ready for Research")
  await app.locator('.tv-views button', { hasText: '+ View' }).click().catch(() => {});
  app.once('dialog', d => d.accept('Ready for Research')); await app.locator('.tv-views button', { hasText: '+ View' }).click(); await app.waitForSelector('.panel-pop');
  await app.locator('.panel-pop button', { hasText: '+ Condition' }).click(); await app.locator('.panel-pop select[aria-label="Field"]').first().selectOption({ label: 'Full Name' }); await app.locator('.panel-pop select[aria-label="Condition"]').first().selectOption('isNotEmpty');
  await app.locator('.panel-pop button', { hasText: '+ Condition' }).click(); await app.locator('.panel-pop .rule').nth(1).locator('select[aria-label="Field"]').selectOption({ label: 'Latest Publication' }); await app.locator('.panel-pop .rule').nth(1).locator('select[aria-label="Condition"]').selectOption('isEmpty'); await sleep(500);
  check('custom view “Ready for Research” (Full Name not empty AND Latest Publication empty) built in the UI shows 23', /23 shown/.test(await app.locator('.tv-bar').innerText()), await app.locator('.tv-bar').innerText());
  await app.screenshot({ path: path.join(out, '03-views-filter.png') });
  await app.reload(); await app.waitForSelector('.g-row', { timeout: 15000 });          // (the saved view persists; back to the full list)

  // ================================================================ bases
  step('Bases: add one from a template, scrape a company list into it, save to a different base');
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/`); await app.waitForSelector('nav.nav');
  await app.locator('nav.nav button.add').click(); await app.waitForSelector('.modal .tpls');
  check('“Add base” offers the five templates (Contacts, Companies, Places, Researchers, Blank)', (await app.locator('.modal .tpl').count()) === 5 && /Contacts/.test(await app.locator('.modal .tpls').innerText()) && /Companies/.test(await app.locator('.modal .tpls').innerText()) && /Places/.test(await app.locator('.modal .tpls').innerText()) && /Researchers/.test(await app.locator('.modal .tpls').innerText()) && /Blank/.test(await app.locator('.modal .tpls').innerText()));
  await app.screenshot({ path: path.join(out, '12-add-base.png') });
  await app.locator('.modal .tpl', { hasText: 'Companies' }).click(); await app.locator('.modal input[type=text]').fill('Suppliers e2e'); await app.locator('.modal button.primary', { hasText: 'Create base' }).click();
  await app.waitForSelector('.tv h1:has-text("Suppliers e2e")'); const supId = await ev(async () => (await window.__vier.S.listTables()).find(t => t.name === 'Suppliers e2e').id);
  check('the new base opens, appears in the left menu and starts with the Companies fields', /Suppliers e2e/.test(await app.locator('nav.nav').innerText()) && /Company/.test(await app.locator('.g-head').innerText()) && /Website/.test(await app.locator('.g-head').innerText()) && supId.startsWith('tbl_'));
  await ev(async id => { await window.__vier.S.addField(id, { name: 'Revenue', type: 'text' }); }, supId);
  const sp = await scrapeTo('/companies', supId, 'cfg_company_listing');
  const sup = await ev(async id => { const S = window.__vier.S; const f = await S.listFields(id); const k = key => f.find(x => x.key === key)?.id; const rev = f.find(x => x.name === 'Revenue').id; return (await S.listRecords(id)).map(r => ({ name: r.cells[k('fullName')], site: r.cells[k('website')], ind: r.cells[k('industry')], mail: r.cells[k('email')], tel: r.cells[k('phone')], size: r.cells[k('size')], loc: r.cells[k('location')], rev: r.cells[rev], status: r.cells[k('scrapingStatus')] })); }, supId);
  const nw = sup.find(r => r.name === 'Northwind Instruments');
  check('company list scraped into the chosen base: 6 companies, website, industry, size, location, e-mail, phone read from the detail pages', sup.length === 6 && nw?.site === 'https://northwind-instruments.example' && nw.ind === 'Laboratory equipment' && nw.size === '50-200' && /Utrecht/.test(nw.loc) && nw.mail === 'sales@northwind-instruments.example' && /^\+31/.test(nw.tel) && sup.every(r => r.status === 'Scraped'), JSON.stringify({ n: sup.length, nw, sp: sp?.stopReason }));
  check('a field the user added (“Revenue”) is filled from the page’s “Revenue: …” row with no configuration', sup.every(r => /^EUR/.test(r.rev || '')) && nw.rev === 'EUR 12M', JSON.stringify(sup.map(r => r.rev)));
  check('nothing from this scrape went into the Researchers base', (await people()).length === 23);
  const sp2 = await scrapeTo('/companies', supId, 'cfg_company_listing');
  check('scraping the same list again creates no duplicates (merged by website / name)', (await ev(async id => (await window.__vier.S.listRecords(id)).length, supId)) === 6 && sp2.saved === 0, JSON.stringify({ saved: sp2.saved, skipped: sp2.skipped }));
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/base/${supId}`); await app.waitForSelector('.g-row'); await app.screenshot({ path: path.join(out, '13-companies-base.png') });
  check('the Companies grid shows the scraped companies', (await app.locator('.g-row').count()) === 6 && /Northwind Instruments/.test(await app.locator('.grid-wrap').innerText()));
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/bases`); await app.waitForSelector('h1:has-text("Bases")'); await sleep(500);
  const bt = await app.locator('main.app-main').innerText(); await app.screenshot({ path: path.join(out, '14-manage-bases.png') });
  check('Manage bases lists every base with “how to add a base”, rename / delete, and research switch or add-on', /How to add a base/.test(bt) && /Suppliers e2e/.test(bt) && /Find research automatically/.test(bt) && /Add research fields/.test(bt) && (await app.locator('.card', { hasText: 'Suppliers e2e' }).locator('button', { hasText: 'Delete' }).count()) >= 1);
  await app.locator('.card', { hasText: 'Suppliers e2e' }).locator('button', { hasText: 'Add research fields' }).click(); await sleep(900);
  const supFields = await ev(async id => (await window.__vier.S.listFields(id)).map(f => f.key), supId);
  check('research fields added to the Companies base on request (and the base is switched to automatic research)', ['latestPublication', 'publicationDoi', 'publicationFile'].every(k => supFields.includes(k)) && (await ev(async id => (await window.__vier.S.getTable(id)).autoResearch, supId)) === true);

  // ================================================================ research
  step('Publication research: Full Name → Latest Publication → DOI → PDF (lawful sources only)');
  const idOf = name => rows.find(r => String(r[F('fullName')]).includes(name)) && ev(async n => (await window.__vier.S.listRecords('tbl_research')).find(r => String(r.cells.fld_fullName).includes(n)).id, name);
  const anna = await idOf('Anna Example');
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/contacts`); await app.waitForSelector('.g-row');
  await app.locator('.g-row', { hasText: 'Anna Example' }).locator('a').first().click(); await app.waitForSelector('.drawer');
  await app.locator('.drawer button', { hasText: 'Run research' }).click(); await app.waitForSelector('.drawer .chip.dark', { timeout: 30000 });
  await sleep(600);
  const ar = await ev(async id => (await window.__vier.S.getRecord(id)).cells, anna);
  check('Latest Publication found for the right author (name + institution match)', ar.fld_latestPublication === 'Mass spectrometry of plant proteins' && ar.fld_publicationDoi === '10.1234/anna.latest' && ar.fld_publicationDate === '2026-03-10' && ar.fld_publicationAccess === 'Open access (gold)', JSON.stringify(ar));
  check('dependent fields filled in order: Latest Research, Research Keywords (profile keywords kept), URL', ar.fld_latestResearch === 'Mass spectrometry of plant proteins' && /mass spectrometry/.test(ar.fld_researchKeywords) && /journal\.example/.test(ar.fld_publicationUrl));
  const att = ar.fld_publicationFile; const blobOk = await ev(async f => { const r = await window.__vier.DB.get('files', f.id); return r && r.data.byteLength > 50 && new TextDecoder().decode(new Uint8Array(r.data.slice(0, 5))) === '%PDF-'; }, att.files[0]);
  check('lawful PDF found through Unpaywall and attached (real %PDF bytes stored); Publication Status = PDF attached', att.files.length === 1 && blobOk && att.files[0].mime === 'application/pdf' && ar.fld_publicationStatus === 'PDF attached', JSON.stringify(att));
  check('attachment card shows file name, a download icon and an open icon', (await app.locator('.drawer .pdfcard button[aria-label^="Download"]').count()) === 1 && (await app.locator('.drawer .pdfcard button[aria-label^="Open"]').count()) === 1 && /_2026_mass-spectrometry-of-plant-proteins.pdf/.test(await app.locator('.drawer .pdfcard').first().innerText()), await app.locator('.drawer .pdfcard').first().innerText());
  const [dl] = await Promise.all([app.waitForEvent('download'), app.locator('.drawer .pdfcard button[aria-label^="Download"]').first().click()]);
  check('download icon saves the PDF', fs.readFileSync(await dl.path()).subarray(0, 5).toString() === '%PDF-' && dl.suggestedFilename().endsWith('.pdf'), dl.suggestedFilename());
  await app.screenshot({ path: path.join(out, '04-record-publication.png') });
  check('no request went to Sci-Hub or any shadow library', !fx.log.some(l => /sci-?hub|libgen|z-lib/i.test(l)));
  await app.locator('.drawer button[aria-label="Close record"]').click();
  await app.locator('.tv-views button', { hasText: /^PDF Available$/ }).click(); await sleep(400); check('“PDF Available” view lists Anna', /1 shown/.test(await app.locator('.tv-bar').innerText()));

  const bram = await idOf('Bram Fixture'); const rb = await send({ type: 'lookup:run', recordId: bram });
  const bc = rb.run.record.cells;
  check('publication without an open-access copy: metadata saved, field says “Full text unavailable”', bc.fld_latestPublication === 'Live-cell imaging of stem cells' && bc.fld_publicationDoi === '10.1234/bram.latest' && bc.fld_publicationFile.files.length === 0 && bc.fld_publicationFile.unavailable === 'Full text unavailable' && bc.fld_publicationStatus === 'Full text unavailable', JSON.stringify(bc.fld_publicationFile));
  const chen = await idOf('Chen Sample'); const rc = (await send({ type: 'lookup:run', recordId: chen })).run;
  check('unknown author: Not found, nothing invented, downstream fields skipped with a reason', !rc.record.cells.fld_latestPublication && rc.record.cells.fld_publicationStatus === 'Not found' && rc.reports.find(r => r.fieldId === 'fld_publicationDoi')?.message.includes('Latest Publication'), JSON.stringify(rc.reports.slice(0, 3)));
  const wei = await idOf('Wei Zhang'); const rw = (await send({ type: 'lookup:run', recordId: wei })).run;
  const pend = rw.record.meta.pending.fld_latestPublication;
  check('two researchers called Wei Zhang at the same institution → no automatic choice; a match selection is offered', pend?.candidates.length === 2 && !rw.record.cells.fld_latestPublication && rw.record.cells.fld_publicationStatus === 'Needs match', JSON.stringify(pend?.candidates.map(c => [c.name, c.confidence])));
  await app.locator('.tv-views button', { hasText: /^All records$/ }).click(); await sleep(300);
  await app.locator('.g-row', { hasText: 'Wei Zhang' }).locator('a').first().click(); await app.waitForSelector('.drawer');
  check('record panel shows the “Which one is this person?” chooser with both candidates', (await app.locator('.drawer .note.warn', { hasText: 'Which one is this person' }).count()) === 1 && (await app.locator('.drawer button', { hasText: 'This is them' }).count()) === 2);
  await app.screenshot({ path: path.join(out, '05-match-chooser.png') });
  await app.locator('.drawer button', { hasText: 'This is them' }).nth(1).click(); await sleep(2500);
  const wc = await ev(async id => (await window.__vier.S.getRecord(id)).cells, wei);
  check('after choosing, the chain continues and fills the publication (the chosen author’s latest work)', ['Superconducting films', 'Optical traps revisited'].includes(wc.fld_latestPublication) && wc.fld_publicationStatus !== 'Needs match', JSON.stringify(wc.fld_latestPublication));
  await app.locator('.drawer button[aria-label="Close record"]').click();
  const js = await idOf('John Smith'); const rj = (await send({ type: 'lookup:run', recordId: js })).run;
  check('same name, different institution: the author at Example University is chosen automatically (and not the one at Other Institute)', rj.record.cells.fld_latestPublication === 'Catalysis in flow reactors' || rj.record.cells.fld_latestPublication === undefined, JSON.stringify(rj.record.cells.fld_latestPublication));

  step('Custom research field built in the UI (Publication Abstract), dependency view');
  await app.locator('.tv-bar button', { hasText: 'Fields' }).click(); await app.waitForSelector('.modal');
  await app.locator('.modal button', { hasText: '+ Add field' }).click(); await app.locator('.overlay').last().locator('input[type=text]').first().fill('Publication Abstract');
  await app.locator('.overlay').last().locator('button', { hasText: /^Abstract$/ }).click(); await app.locator('.overlay').last().locator('button', { hasText: 'Save field' }).click(); await sleep(700);
  check('new field exists as a research field that reads from Latest Publication', await ev(async () => { const f = (await window.__vier.S.listFields('tbl_research')).find(x => x.name === 'Publication Abstract'); return f?.lookup?.kind === 'abstract' && f.lookup.fromFieldId === 'fld_latestPublication' && f.type === 'longText'; }));
  await app.locator('.modal button', { hasText: 'Dependencies' }).click(); await sleep(250);
  const deps = await app.locator('.modal-b').innerText(); check('dependency view shows the run order and what each field depends on', /Run order/.test(deps) && /Latest Publication/.test(deps) && /Publication Abstract/.test(deps), deps.slice(0, 200));
  await app.screenshot({ path: path.join(out, '06-field-dependencies.png') }); await app.locator('.modal button', { hasText: 'Done' }).click();
  const ra = (await send({ type: 'lookup:run', recordId: anna })).run;
  check('abstract fetched for Anna (derived from the stored publication; no empty-upstream run)', /fictional abstract describes mass spectrometry/.test(ra.record.cells[(await ev(async () => (await window.__vier.S.listFields('tbl_research')).find(x => x.name === 'Publication Abstract').id))] || ''), '');

  step('Google Scholar-style source is read through a tab in the browser and stops at a human check');
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/research`); await app.waitForSelector('h1:has-text("Research Finder")');
  const rf = await app.locator('main.app-main').innerText(); await app.screenshot({ path: path.join(out, '15-research-finder.png') });
  check('Research Finder explains itself in plain language and has the automatic switch for the chosen base', /What does this do\?/.test(rf) && /It runs by itself/.test(rf) && /Find research automatically/.test(rf) && /Progress in this base/.test(rf) && /Look up one person/.test(rf));
  const sc = await send({ type: 'author:search', name: 'Anna Example', sources: ['googlescholar'] });
  check('Scholar results page parsed in a real tab: title, authors, venue, year; name-only match → asks the user', sc.outcome.status === 'ambiguous' && sc.outcome.candidates[0].publication.title === 'Mass spectrometry of plant proteins' && sc.outcome.candidates[0].publication.year === 2026, JSON.stringify(sc.outcome).slice(0, 300));
  const blocked = await send({ type: 'author:search', name: 'Blocked Person', sources: ['googlescholar'] });
  check('a CAPTCHA / “unusual traffic” page is reported and never bypassed', blocked.outcome.status === 'none' && /never bypasses/.test(blocked.outcome.errors.join(' ')), JSON.stringify(blocked.outcome));

  // ================================================================ automation + e-mail
  step('Email: preview, automation in test mode, activation, Brevo send (fake), analytics');
  await ev(async () => { const S = window.__vier.S; await S.createRecord('tbl_research', { fld_fullName: 'Ada Outreach', fld_firstName: 'Ada', fld_position: 'Professor', fld_institution: 'Example University', fld_email: 'ada.outreach@example-university.example', fld_outreachStatus: 'Not Contacted', fld_latestResearch: 'plant proteomics' }, { silent: true }); });
  const adaId = await ev(async () => (await window.__vier.S.listRecords('tbl_research')).find(r => r.cells.fld_fullName === 'Ada Outreach').id);
  const prev = await ev(async id => { const { S, mail, settings } = window.__vier; const [tpl] = await mail.getTemplates(); return mail.renderEmail(tpl, await S.listFields('tbl_research'), await S.getRecord(id), await settings.getSettings()); }, adaId);
  check('personalised preview: {First Name}, {Institution}, optional {Latest Research} sentence, opt-out footer', prev.subject === 'Laboratory equipment sourcing for Example University' && /Hi Ada,/.test(prev.text) && /particularly interested in your work on plant proteomics/.test(prev.text) && /unsubscribe/.test(prev.text), prev.text);
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/email`); await app.waitForSelector('h1:has-text("Email Campaigns")'); await sleep(800);
  check('Email page renders the template editor, preview, sender selection and Brevo / Gmail explanation', (await app.locator('textarea').count()) >= 1 && /Brevo/.test(await app.locator('main.app-main').innerText()) && /no analytics/.test(await app.locator('main.app-main').innerText()));
  await app.screenshot({ path: path.join(out, '07-email.png') });

  const auto = await ev(async () => { const { S, engine, filters } = window.__vier; const view = (await S.listViews('tbl_research')).find(v => v.name === 'Ready for Outreach'); const a = engine.newAutomation('tbl_research', 'Intro to ready contacts'); a.trigger = { type: 'manual' }; a.conditions = view.filter; a.actions = [{ id: 'a1', type: 'sendEmail', templateId: 'tpl_intro', providerId: 'brevo', senderEmail: 'info@vierapparatus.com' }]; await engine.saveAutomation(a); return a; });
  check('new automation starts OFF and in test mode', auto.enabled === false && auto.testMode === true);
  const t1 = (await send({ type: 'auto:run', automationId: auto.id, recordIds: [adaId], testMode: true })).runs[0];
  check('test mode: the run says what it WOULD do and nothing reaches the e-mail provider', t1.status === 'test' && /Nothing was sent/.test(t1.steps[0].message) && fx.stats.brevoSent.length === 0, JSON.stringify(t1.steps));
  await ev(async id => { const { engine, settings } = window.__vier; const a = await engine.getAutomation(id); await engine.saveAutomation({ ...a, enabled: true, testMode: false }); }, auto.id);
  const t2 = (await send({ type: 'auto:run', automationId: auto.id, recordIds: [adaId] })).runs[0];
  check('sending switched OFF globally: an active automation still sends nothing', t2.status === 'skipped' && /switched off/.test(t2.steps[0].message) && fx.stats.brevoSent.length === 0, JSON.stringify(t2.steps));
  await ev(async () => { await window.__vier.settings.saveSettings({ sendingEnabled: true }); });
  const t3 = (await send({ type: 'auto:run', automationId: auto.id, recordIds: [adaId] })).runs[0];
  const sent = fx.stats.brevoSent[0];
  check('after explicit activation the e-mail goes out through the provider API: right sender, recipient, subject, tracking tag', t3.status === 'ok' && fx.stats.brevoSent.length === 1 && sent.sender.email === 'info@vierapparatus.com' && sent.to[0].email === 'ada.outreach@example-university.example' && /^Laboratory equipment sourcing/.test(sent.subject) && sent.tags.includes('viercrm') && /unsubscribe/.test(sent.textContent), JSON.stringify(t3.steps));
  check('the sender was verified with Brevo first (GET /senders)', fx.log.some(l => l === 'GET /brevo/v3/senders'));
  const ada = await ev(async id => (await window.__vier.S.getRecord(id)).cells, adaId);
  check('contact updated: Email Sent, Email Status = Sent, Outreach Status = Contacted', ada.fld_emailSent === true && ada.fld_emailStatus === 'Sent' && ada.fld_outreachStatus === 'Contacted', JSON.stringify(ada));
  const t4 = (await send({ type: 'auto:run', automationId: auto.id, recordIds: [adaId] })).runs[0];
  check('duplicate prevention: the same template is not sent to the same contact twice', fx.stats.brevoSent.length === 1 && /already sent|Conditions|not met/.test(`${t4.error} ${t4.steps.map(s => s.message).join(' ')}`), JSON.stringify(t4));
  const mid = await ev(async () => (await window.__vier.mail.listEmailLog()).find(l => l.provider === 'brevo').messageId);
  fx.stats.brevoEvents[mid] = [{ event: 'delivered', date: '2026-11-04T10:00:05Z' }, { event: 'opened', date: '2026-11-04T11:00:00Z' }, { event: 'clicks', date: '2026-11-04T11:05:00Z', link: 'https://vierapparatus.com' }];
  const sy = await send({ type: 'email:sync' }); const ada2 = await ev(async id => (await window.__vier.S.getRecord(id)).cells, adaId);
  check('Brevo events synchronised: Email Opened, Last Opened, Email Clicked, status Clicked', sy.brevo.newEvents === 3 && ada2.fld_emailOpened === true && ada2.fld_lastOpened === '2026-11-04' && ada2.fld_emailClicked === true && ada2.fld_emailStatus === 'Clicked', JSON.stringify({ sy: sy.brevo, ada2 }));
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/analytics`); await app.waitForSelector('.tile'); await sleep(500);
  const tiles = await app.locator('.grid4').innerText(); check('Analytics page: 1 sent, 1 delivered, 1 unique open, 1 click – and it explains why open counts are imperfect', /1\s*\nEmails sent/.test(tiles) && /1\s*\nUnique opens/.test(tiles) && /Apple Mail Privacy/.test(await app.locator('main.app-main').innerText()), tiles);
  await app.screenshot({ path: path.join(out, '08-analytics.png') });

  step('Automations: loop prevention and the page itself');
  const loops = await ev(async () => {
    const { S, engine } = window.__vier;   // changes made here are forwarded to the background worker, which runs the engine (as in real use)
    const mk = async (name, fieldId, writeId) => { const a = engine.newAutomation('tbl_research', name); a.enabled = true; a.testMode = false; a.trigger = { type: 'fieldChanges', fieldId }; a.actions = [{ id: name, type: 'updateField', fieldId: writeId, value: `{${writeId === 'fld_phone' ? 'Notes' : 'Phone'}}!` }]; await engine.saveAutomation(a); return a; };
    const A = await mk('Loop A', 'fld_notes', 'fld_phone'); const Bx = await mk('Loop B', 'fld_phone', 'fld_notes');
    const r = await S.createRecord('tbl_research', { fld_fullName: 'Loop Person' }); await S.updateRecord(r.id, { fld_notes: 'x' }); await new Promise(res => setTimeout(res, 3500));
    return { a: (await engine.listRuns(A.id)).length, b: (await engine.listRuns(Bx.id)).length, n: (await S.getRecord(r.id)).cells };
  });
  check('A writes a field that triggers B which would trigger A: each runs once, no infinite loop', loops.a === 1 && loops.b === 1, JSON.stringify(loops));
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/automations`); await app.waitForSelector('h1:has-text("Automations")'); await sleep(600);
  check('Automation builder lists automations with When / Only if / Then, dependencies and history', /When/.test(await app.locator('main.app-main').innerText()) && /Field dependencies/.test(await app.locator('main.app-main').innerText()) && /History/.test(await app.locator('main.app-main').innerText()));
  await app.screenshot({ path: path.join(out, '09-automations.png') });

  step('CSV export, settings, side panel');
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/contacts`); await app.waitForSelector('.g-row');
  const [csv] = await Promise.all([app.waitForEvent('download'), app.locator('.tv-bar button', { hasText: 'Export CSV' }).click()]); const csvText = fs.readFileSync(await csv.path(), 'utf8');
  check('CSV export: UTF-8 BOM, header from the visible fields, one row per record, e-mails present', csvText.startsWith('﻿Full Name,') && csvText.includes('anna.example@example-university.example') && csvText.trim().split('\r\n').length > 20, csvText.slice(0, 120));
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/settings`); await app.waitForSelector('h1:has-text("Settings")'); const st = await app.locator('main.app-main').innerText();
  check('Settings: Unpaywall e-mail, Brevo key (masked), Gmail OAuth, webhook, backup, sample data – and the Sci-Hub note', /Unpaywall/.test(st) && /Brevo/.test(st) && /Gmail/.test(st) && /Webhook/.test(st) && /backup/i.test(st) && /Sci-Hub/.test(st) && !(await app.content()).includes('test-key'));
  await app.screenshot({ path: path.join(out, '10-settings.png') });
  const side = await ctx.newPage(); await side.goto(`chrome-extension://${extId}/sidepanel.html`); await side.waitForSelector('.sp-head'); await sleep(800);
  check('side panel renders: Scrape + Records tabs, “Save to base” chooser, current-site card, Start / Preview', (await side.locator('.sp-body').innerText()).includes('Current website') && (await side.locator('.sp-body').innerText()).includes('Save to base') && (await side.locator('button', { hasText: 'Start' }).count()) >= 1 && (await side.locator('.tabs button').count()) === 2);
  const opts = await side.locator('select[aria-label="Save scraped records to"] option').allInnerTexts();
  check('“Save to base” lists every base with its record count, plus “New base…”', opts.length === 5 && /Researchers/.test(opts[0]) && /Suppliers e2e \(6 records\)/.test(opts.join('|')) && /New base/.test(opts[opts.length - 1]), opts.join(' | '));
  await side.locator('select[aria-label="Save scraped records to"]').selectOption({ label: opts.find(o => /Suppliers e2e/.test(o)) }); await sleep(500);
  check('choosing another base is reflected on the Start button and keeps the company configuration for a Companies base', /Start → Suppliers e2e/.test(await side.locator('.sp-body').innerText()) && (await side.locator('select').nth(1).inputValue()) === 'cfg_company_listing');
  const hb = side.locator('.sp-head button'); const hbs = await hb.evaluate(el => { const c = getComputedStyle(el); const r = el.getBoundingClientRect(); return { text: el.textContent.trim(), color: c.color, bg: c.backgroundColor, border: c.borderTopColor, w: r.width, h: r.height }; });
  check('the top-right “Open app” button is visible: it has text, a border and a text colour that differs from its background (the old one was white on white)', hbs.text === 'Open app ↗' && hbs.color !== hbs.bg && hbs.border === 'rgb(69, 112, 182)' && hbs.w > 60 && hbs.h > 24, JSON.stringify(hbs));
  const headBg = await side.locator('.sp-head').evaluate(el => getComputedStyle(el).backgroundColor);
  check('side-panel header is white like the website header (wordmark visible on it)', headBg === 'rgb(255, 255, 255)' && (await side.locator('.sp-head img').evaluate(i => i.complete && i.naturalWidth > 50)));
  await side.screenshot({ path: path.join(out, '11a-sidepanel-scrape.png') });
  await side.locator('.tabs button', { hasText: 'Records' }).click(); await sleep(600);
  check('Records tab browses the chosen base with a base selector', (await side.locator('select[aria-label="Base"]').count()) === 1 && (await side.locator('input[aria-label="Search records"]').count()) === 1);
  await side.screenshot({ path: path.join(out, '11-sidepanel.png') });

  step('Automatic research: a record with a name and no publication fills itself in – no button pressed');
  await ev(async () => { await window.__vier.S.setAutoResearch('tbl_research', true); const S = window.__vier.S; await S.createRecord('tbl_research', { fld_fullName: 'Anna Example', fld_institution: 'Example University', fld_email: 'anna.second@example-university.example' }, { silent: true }); });
  await send({ type: 'auto:now', tableId: 'tbl_research' });
  let autoRec; for (let i = 0; i < 60; i++) { await sleep(500); autoRec = await ev(async () => (await window.__vier.S.listRecords('tbl_research')).find(r => r.cells.fld_email === 'anna.second@example-university.example')); if (autoRec?.cells.fld_latestPublication) break; }
  check('background auto-research found the latest publication (and DOI, date, link) for a newly added record', autoRec?.cells.fld_latestPublication === 'Mass spectrometry of plant proteins' && autoRec.cells.fld_publicationDoi === '10.1234/anna.latest' && autoRec.cells.fld_publicationDate === '2026-03-10' && autoRec.meta.autoTried?.outcome === 'found', JSON.stringify(autoRec?.cells).slice(0, 300));
  check('automatic research downloads no PDFs (details only)', !autoRec?.cells.fld_publicationFile);
  await ev(async () => { await window.__vier.S.createRecord('tbl_research', { fld_fullName: 'Bram Fixture', fld_institution: 'Example University', fld_email: 'bram.second@example-university.example' }, { silent: true }); });
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/base/tbl_research`); await app.waitForSelector('.g-row');
  check('the base view shows that it is researching automatically', /researching automatically/.test(await app.locator('.tv-head').innerText()), await app.locator('.tv-head').innerText());
  let viewRec; for (let i = 0; i < 80; i++) { await sleep(500); viewRec = await ev(async () => (await window.__vier.S.listRecords('tbl_research')).find(r => r.cells.fld_email === 'bram.second@example-university.example')); if (viewRec?.cells.fld_latestPublication) break; }
  check('simply opening a view researches the visible records that have a name but no publication', viewRec?.cells.fld_latestPublication === 'Live-cell imaging of stem cells', JSON.stringify(viewRec?.cells).slice(0, 200));
  await app.screenshot({ path: path.join(out, '16-auto-research.png') });
  await ev(async () => { await window.__vier.S.createRecord('tbl_research', { fld_fullName: 'Nobody Knownson' }, { silent: true }); });
  await send({ type: 'auto:now', tableId: 'tbl_research' });
  let nobody; for (let i = 0; i < 40; i++) { await sleep(500); nobody = await ev(async () => (await window.__vier.S.listRecords('tbl_research')).find(r => r.cells.fld_fullName === 'Nobody Knownson')); if (nobody?.meta?.autoTried) break; if (i % 6 === 5) await send({ type: 'auto:now', tableId: 'tbl_research' }); }
  check('an unknown person stays empty (nothing invented) and is marked so it is not retried for 7 days', !nobody.cells.fld_latestPublication && nobody.meta.autoTried && ['none', 'error'].includes(nobody.meta.autoTried.outcome), JSON.stringify(nobody.meta));

  step('Google Maps: scroll a result list to its end, read every place, find e-mail on each business website, run several searches');
  const googleHits = []; ctx.on('request', r => { try { if (/(^|\.)google\.[a-z.]+$/.test(new URL(r.url()).hostname)) googleHits.push(r.url()); } catch { /* not a URL */ } });
  const pid = await ev(async () => (await window.__vier.S.createBase('Freight e2e', 'places')).id);
  const scrapeMaps = async (urlPath, tableId, mapsPatch = {}) => {
    await fixtureTab.goto(`${B}${urlPath}`, { waitUntil: 'domcontentloaded' }); await fixtureTab.bringToFront(); await sleep(400);
    const id = await tabId();
    const cfg = await ev(async patch => { const c = (await window.__vier.DB.all('configs')).find(x => x.id === 'cfg_google_maps'); return { ...c, maps: { ...c.maps, ...patch }, pagination: { ...c.pagination, delayMinMs: 0, delayMaxMs: 0 } }; }, mapsPatch);
    await send({ type: 'scrape:start', tabId: id, config: cfg, tableId });
    let prog; for (let i = 0; i < 240; i++) { await sleep(500); prog = (await send({ type: 'scrape:status' })).progress; if (prog && !prog.running && prog.phase === 'finished') break; }
    return prog;
  };
  const mapsRows = id => ev(async tid => { const S = window.__vier.S; const f = await S.listFields(tid); const k = key => f.find(x => x.key === key).id; return (await S.listRecords(tid)).map(r => ({ name: r.cells[k('fullName')], cat: r.cells[k('industry')], addr: r.cells[k('location')], tel: r.cells[k('phone')], web: r.cells[k('website')], mail: r.cells[k('email')], soc: r.cells[k('socials')], rate: r.cells[k('rating')], rev: r.cells[k('reviews')], hours: r.cells[k('hours')], link: r.cells[k('profileUrl')], q: r.cells[k('searchQuery')], st: r.cells[k('scrapingStatus')], out: r.cells[k('outreachStatus')] })); }, id);

  await fixtureTab.goto(`${B}/maps/search/freight+forwarder+surabaya`, { waitUntil: 'domcontentloaded' }); await fixtureTab.bringToFront(); await sleep(500);
  const mprev = await send({ type: 'scrape:preview', tabId: await tabId(), config: await ev(async () => (await window.__vier.DB.all('configs')).find(x => x.id === 'cfg_google_maps')) });
  check('Maps preview: recognised as a result list, shows the places loaded so far with phone / website counts and a sample', mprev?.maps === true && mprev.count === 8 && mprev.withPhone === 7 && mprev.withWebsite === 6 && mprev.withAddress === 8 && mprev.query === 'freight forwarder surabaya' && mprev.sample[0].name === 'Samudra Cargo Express' && /Freight forwarder/.test(mprev.sample[0].position), JSON.stringify({ ...mprev, sample: undefined }));

  const mark1 = fx.log.length; const m1 = await scrapeMaps('/maps/search/freight+forwarder+surabaya', pid); const log1 = fx.log.slice(mark1);
  const recs = await mapsRows(pid); const R = n => recs.find(r => r.name === n) || {};
  check('Maps: the list is scrolled to its end (3 batches of places) and all 20 places are saved without errors', recs.length === 20 && m1.saved === 20 && /end of the list/.test(m1.stopReason) && m1.errors.length === 0, JSON.stringify({ n: recs.length, saved: m1.saved, stop: m1.stopReason, err: m1.errors.slice(0, 3) }));
  check('Maps: category, address, phone, website, rating, reviews, search words and the Maps link come from the cards', R('Samudra Cargo Express').cat === 'Freight forwarder' && R('Samudra Cargo Express').addr === 'Jl. Perak Timur No.12, Surabaya' && R('Samudra Cargo Express').tel === '(031) 5551 0101' && /\/biz\/samudra-cargo$/.test(R('Samudra Cargo Express').web) && Number(R('Samudra Cargo Express').rate) === 4.6 && Number(R('Samudra Cargo Express').rev) === 102 && R('Samudra Cargo Express').q === 'freight forwarder surabaya' && /\/maps\/place\/Samudra\+Cargo\+Express\/data=/.test(R('Samudra Cargo Express').link) && recs.every(r => r.st === 'Scraped' && r.out === 'Not Contacted') && recs.every(r => r.cat && /^Jl\./.test(r.addr || '') && r.tel), JSON.stringify(recs.filter(r => !r.cat || !/^Jl\./.test(r.addr || '') || !r.tel).slice(0, 3)));
  check('Maps: an Indonesian-language card is read too (rating “4,5 bintang”, “Buka ⋅ Tutup pukul 22.00” kept out of the fields)', R('Kos Melati Putri').cat === 'Boarding house' && R('Kos Melati Putri').tel === '0857-1111-2222' && Number(R('Kos Melati Putri').rate) === 4.5 && Number(R('Kos Melati Putri').rev) === 33, JSON.stringify(R('Kos Melati Putri')));
  check('Maps: only the card without a phone number was opened in its own (background) tab – and its phone, hours and plus code were taken from there', log1.filter(l => l.startsWith('GET /maps/place/')).length === 1 && R('Bahari Express Cargo').tel === '031-5559-0099' && /^Monday: 8 am–5 pm/.test(R('Bahari Express Cargo').hours || ''), JSON.stringify({ places: log1.filter(l => l.startsWith('GET /maps/place/')), bahari: R('Bahari Express Cargo') }));
  check('Maps: e-mail found on the business websites – home page mailto, the “Hubungi kami” page, a Cloudflare-protected address – and none invented where there is none', /^(info|sales)@samudra-cargo\.example$/.test(R('Samudra Cargo Express').mail) && R('Nusantara Logistik').mail === 'sales@nusantara-logistik.example' && R('Citra Kargo Jakarta').mail === 'office@citra-kargo.example' && !R('Mitra Lintas Samudra').mail && !R('Trans Pasifik Forwarding').mail && !R('Trans Pasifik Forwarding').web, JSON.stringify(recs.map(r => [r.name, r.mail])));
  check('Maps: WhatsApp and social links from the websites go into Social Links', /WhatsApp: \+6281234560000/.test(R('Mitra Lintas Samudra').soc || '') && /Instagram: https:\/\/instagram\.com\/mitra-lintas/.test(R('Mitra Lintas Samudra').soc || '') && /Facebook: /.test(R('Samudra Cargo Express').soc || ''), R('Mitra Lintas Samudra').soc);
  check('Maps: two branches of one chain are two records, and their shared website was read only once', R('Citra Kargo Jakarta').name && R('Citra Kargo Surabaya').name && R('Citra Kargo Jakarta').tel !== R('Citra Kargo Surabaya').tel && log1.filter(l => l === 'GET /biz/citra-kargo').length === 1, JSON.stringify(log1.filter(l => l.includes('citra'))));
  check('Maps: nothing was sent to Google during the test – the searches, places and websites were all the local fixture', googleHits.length === 0, googleHits.slice(0, 3).join(' | '));

  const m2 = await scrapeMaps('/maps/search/freight+forwarder+surabaya', pid);
  check('Maps: the same search again saves nothing new (the Maps link identifies each place)', m2.saved === 0 && (await mapsRows(pid)).length === 20 && m2.skipped >= 20, JSON.stringify({ saved: m2.saved, skipped: m2.skipped, errors: m2.errors.slice(0, 2) }));
  const m3 = await scrapeMaps('/maps/search/freight+forwarder+surabaya', pid, { queries: ['cargo semarang', ' ', 'cargo semarang'.replace('cargo', 'kos')] });
  const recs3 = await mapsRows(pid); const R3 = n => recs3.find(r => r.name === n) || {};
  check('Maps: extra searches run one after another; a place found by two searches is saved once', recs3.length === 22 && m3.saved === 2 && R3('Lintas Jawa Cargo').mail === 'info@lintas-jawa.example' && R3('Kos Sakura Semarang').q === 'cargo semarang' && recs3.filter(r => r.name === 'Samudra Cargo Express').length === 1, JSON.stringify({ n: recs3.length, saved: m3.saved, page: m3.page, stop: m3.stopReason, err: m3.errors.slice(0, 2) }));
  const mnone = await scrapeMaps('/', pid, {});
  check('Maps: a page that is not a result list explains itself instead of saving junk', (await mapsRows(pid)).length === 22 && /no Maps results/.test(mnone.stopReason || '') && mnone.errors.some(e => /no result list/i.test(e)), JSON.stringify({ stop: mnone.stopReason, err: mnone.errors.slice(0, 2) }));

  await side.locator('.tabs button', { hasText: 'Scrape' }).click(); await sleep(400);
  await side.locator('select').nth(1).selectOption('cfg_google_maps'); await side.locator('button', { hasText: 'Edit configuration' }).click(); await sleep(500);
  const mtxt = await side.locator('.sp-body').innerText(); await side.screenshot({ path: path.join(out, '17-maps-config.png') });
  check('side panel: the Google Maps configuration shows its own options (open places, website e-mail, more searches, limits) and none of the people-list ones', /Google Maps results/.test(mtxt) && /own website/.test(mtxt) && /More searches/.test(mtxt) && /Max places/.test(mtxt) && !/What is on the page\?/.test(mtxt) && !/Max pages/.test(mtxt), mtxt.slice(0, 300));
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/base/${pid}`); await app.waitForSelector('.g-row'); await sleep(500); await app.screenshot({ path: path.join(out, '18-places-base.png') });
  check('the Places base grid shows the scraped places with name, category, address, phone, website and e-mail columns first', (await app.locator('.g-row').count()) === 22 && /Samudra Cargo Express/.test(await app.locator('.grid-wrap').innerText()) && /Category/.test(await app.locator('.g-head').innerText()) && /Address/.test(await app.locator('.g-head').innerText()) && /Phone/.test(await app.locator('.g-head').innerText()));

  step('Backup and restore round-trip');
  const rt = await ev(async () => { const { DB, S } = window.__vier; const before = (await S.listRecords('tbl_research')).length; const dump = JSON.parse(JSON.stringify(await DB.exportBackup())); await DB.wipeAll(); const wiped = (await S.listRecords('tbl_research')).length; await DB.importBackup(dump); const files = await DB.all('files'); return { before, wiped, after: (await S.listRecords('tbl_research')).length, files: files.length, pdf: files[0] && files[0].data.byteLength > 50 }; });
  check('full backup (incl. attachments) restores every record and the stored PDF', rt.wiped === 0 && rt.after === rt.before && rt.files >= 1 && rt.pdf, JSON.stringify(rt));

  step('Console hygiene');
  const real = errors.filter(e => !/favicon|Failed to load resource|ERR_/i.test(e)); check('no uncaught errors in the app page', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  check('e2e run completed without crashing', false, String(err.stack || err).slice(0, 700)); finishCode = 1;
  for (const [i, pg] of ctx.pages().entries()) { try { await pg.screenshot({ path: path.join(out, `failure-${i}.png`) }); const toasts = await pg.locator('.toast').allInnerTexts().catch(() => []); if (toasts.length) console.log(`  toasts on page ${i}:`, toasts.join(' | ')); } catch { /* page gone */ } }
} finally {
  await ctx.close().catch(() => {}); await fx.close(); fs.rmSync(userData, { recursive: true, force: true });
  const failed = results.filter(r => !r.ok);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: failed.length, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map(f => f.name).join('; ')}` : ''}`);
  process.exit(failed.length || finishCode ? 1 : 0);
}
