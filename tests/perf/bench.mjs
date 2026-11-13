// Performance benchmark: the REAL built extension in Chromium with N records in the Researchers base (default 20,000).
//   npm run build && npm run bench          (BENCH_N=50000 to try more)
// Every number is the median of several runs, measured in the page with performance.now(). Nothing leaves the computer.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exe = process.env.CHROMIUM || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1248/chrome-win64/chrome.exe');
const N = Number(process.env.BENCH_N || 20000);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'viercrm-bench-')); const extDir = path.join(userData, 'ext'); fs.cpSync(path.join(root, 'dist'), extDir, { recursive: true });
const ctx = await chromium.launchPersistentContext(userData, { executablePath: exe, headless: false, args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--headless=new', '--no-first-run', '--enable-precise-memory-info', '--js-flags=--expose-gc'], viewport: { width: 1360, height: 900 } });
const res = {};
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 }); const extId = new URL(sw.url()).host;
  const app = await ctx.newPage(); const t0 = Date.now();
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/`); await app.waitForSelector('.tile .v'); await app.waitForFunction(() => !!window.__vier);
  res.firstPaintMs = await app.evaluate(() => Math.round(performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd));
  const other = await ctx.newPage(); await other.goto(`chrome-extension://${extId}/app.html?e2e#/bases`); await other.waitForFunction(() => !!window.__vier); await app.bringToFront();       // a second extension page = another tab / the background worker making changes
  console.log(`extension up after ${Date.now() - t0} ms; seeding ${N.toLocaleString()} records …`);

  await app.evaluate(async n => {
    const { DB, S } = window.__vier; const F = k => `fld_${k}`; const first = ['Anna', 'Bram', 'Chen', 'Dewi', 'Erik', 'Fatima', 'Gustav', 'Hana', 'Ivo', 'Jun', 'Kofi', 'Lena', 'Mateo', 'Nora', 'Omar', 'Petra', 'Quinn', 'Rosa', 'Sven', 'Tariq'];
    const last = ['Example', 'Fixture', 'Sample', 'Placeholder', 'Specimen', 'Mockson', 'Testwell', 'Dummy', 'Fiction', 'Imagined']; const inst = ['Example University', 'Other Institute', 'Fictional College', 'Test Polytechnic', 'Sample Hospital'];
    const recs = []; const now = new Date().toISOString();
    for (let i = 0; i < n; i++) {
      const f = first[i % first.length], l = last[(i * 7) % last.length] + (i % 97 === 0 ? ' ' + i : '');
      recs.push({ id: `rec_bench${String(i).padStart(7, '0')}`, tableId: 'tbl_research', createdAt: now, updatedAt: now, cells: { [F('fullName')]: `${f} ${l}`, [F('firstName')]: f, [F('lastName')]: l, [F('position')]: i % 3 ? 'Associate Professor' : 'Postdoctoral Researcher', [F('department')]: 'Department of Analytical Chemistry', [F('institution')]: inst[i % inst.length], [F('country')]: ['Netherlands', 'Germany', 'Japan', 'Brazil'][i % 4],
        ...(i % 25 ? { [F('email')]: `${f}.${l}.${i}@example-university.example`.toLowerCase().replace(/\s+/g, '') } : {}), [F('about')]: `${f} ${l} works on topic ${i % 50}. `.repeat(6), [F('researchKeywords')]: 'mass spectrometry, proteomics, imaging', [F('outreachStatus')]: 'Not Contacted', [F('scrapingStatus')]: 'Scraped', [F('scrapingDate')]: '2026-11-0' + (1 + (i % 9)) }, meta: {} });
    }
    await S.setAutoResearch('tbl_research', false);
    for (let i = 0; i < recs.length; i += 2000) await DB.putMany('records', recs.slice(i, i + 2000));
  }, N);
  console.log('seeded.');

  // in-page timing helper: run an action, resolve with ms until the condition holds
  await app.evaluate(() => { window.__t = (action, cond, timeout = 60000) => new Promise((resolve, reject) => { const s = performance.now(); action(); const tick = () => { let ok = false; try { ok = cond(); } catch { /* not yet */ } if (ok) return resolve(performance.now() - s); if (performance.now() - s > timeout) return reject(new Error('timeout')); requestAnimationFrame(tick); }; tick(); }); });
  const median = a => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)]); };
  const rep = async (name, n, fn) => { const xs = []; for (let i = 0; i < n; i++) xs.push(await fn(i)); res[name] = median(xs); console.log(`  ${name.padEnd(34)} ${String(res[name]).padStart(6)} ms   (runs: ${xs.map(Math.round).join(', ')})`); };

  await rep('openBase (grid with rows)', 5, async () => {
    await app.evaluate(() => { location.hash = '#/'; }); await app.waitForSelector('.tile .v'); await app.waitForSelector('.g-row', { state: 'detached' }).catch(() => {});
    return app.evaluate(() => window.__t(() => { location.hash = '#/base/tbl_research'; }, () => document.querySelectorAll('.g-row').length > 5));
  });
  await app.waitForSelector('.g-row');
  await app.waitForFunction(n => { const t = document.querySelector('.tv-head')?.textContent || ''; return !t.includes('loading all records') && t.includes(n.toLocaleString('en-US') + ' records'); }, N, { timeout: 60000 });       // wait for the complete list
  res.fullLoadMs = null;
  res.heapMB = await app.evaluate(() => { gc?.(); return Math.round(performance.memory.usedJSHeapSize / 1048576); });
  await app.evaluate(() => { window.__lt = 0; new PerformanceObserver(l => l.getEntries().forEach(e => { window.__lt += e.duration; })).observe({ entryTypes: ['longtask'] }); });
  await rep('another tab edits a cell → grid shows it', 5, async i => { const v = `Edited${i}x${Date.now()}`; const start = await other.evaluate(v => { const t = Date.now(); void window.__vier.S.updateRecord('rec_bench0000000', { fld_position: v }); return t; }, v); return app.evaluate(([v, st]) => new Promise((res, rej) => { const tick = () => { if (document.querySelector('.g-row')?.textContent.includes(v)) res(Date.now() - st); else if (Date.now() - st > 30000) rej(new Error('timeout')); else requestAnimationFrame(tick); }; tick(); }), [v, start]); });
  const shown = () => app.evaluate(() => Number((document.querySelector('.tv-bar .muted.small')?.textContent.match(/([\d,]+) shown/) || [])[1]?.replace(/,/g, '')));
  await rep('switch view (Missing Email)', 5, async i => {
    await app.locator('.tv-views button', { hasText: /^All records$/ }).click(); await app.waitForFunction(n => Number((document.querySelector('.tv-bar .muted.small')?.textContent.match(/([\d,]+) shown/) || [])[1]?.replace(/,/g, '')) === n, N);
    return app.evaluate(() => window.__t(() => [...document.querySelectorAll('.tv-views button')].find(b => b.textContent === 'Missing Email').click(), () => Number((document.querySelector('.tv-bar .muted.small')?.textContent.match(/([\d,]+) shown/) || [])[1]?.replace(/,/g, '')) < 2000));
  });
  await app.locator('.tv-views button', { hasText: /^All records$/ }).click(); await app.waitForFunction(n => Number((document.querySelector('.tv-bar .muted.small')?.textContent.match(/([\d,]+) shown/) || [])[1]?.replace(/,/g, '')) === n, N);
  await rep('search “anna fixture” (keystrokes)', 5, async i => {
    const q = i % 2 ? 'beta' : 'anna fixture';
    await app.evaluate(() => { const el = document.querySelector('.tv-bar input[type=search]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); });
    await app.waitForFunction(n => Number((document.querySelector('.tv-bar .muted.small')?.textContent.match(/([\d,]+) shown/) || [])[1]?.replace(/,/g, '')) === n, N);
    return app.evaluate(qq => window.__t(() => { const el = document.querySelector('.tv-bar input[type=search]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, qq); el.dispatchEvent(new Event('input', { bubbles: true })); }, () => Number((document.querySelector('.tv-bar .muted.small')?.textContent.match(/([\d,]+) shown/) || [])[1]?.replace(/,/g, '')) < 20000), q);
  });
  await app.evaluate(() => { const el = document.querySelector('.tv-bar input[type=search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await app.waitForFunction(n => Number((document.querySelector('.tv-bar .muted.small')?.textContent.match(/([\d,]+) shown/) || [])[1]?.replace(/,/g, '')) === n, N);
  await rep('sort by Full Name (header click)', 4, async () => app.evaluate(() => { const before = document.querySelector('.g-row')?.textContent; return window.__t(() => [...document.querySelectorAll('.g-hc')].find(h => h.textContent.startsWith('Full Name')).click(), () => document.querySelector('.g-row')?.textContent !== before); }));
  res.dashboardStatsMs = [];
  await rep('dashboard (all bases counted)', 4, async () => {
    await app.evaluate(() => { location.hash = '#/bases'; }); await app.waitForSelector('h1:has-text("Bases")'); await sleep(900);
    const quick = await app.evaluate(n => window.__t(() => { location.hash = '#/'; }, () => [...document.querySelectorAll('.tile .v')].some(v => v.textContent.replace(/[^0-9]/g, '') === String(n))), N);
    const all = await app.evaluate(() => window.__t(() => {}, () => ![...document.querySelectorAll('.tile .v')].some(v => v.textContent === '…')), 30000);
    res.dashboardStatsMs.push(Math.round(quick + all)); return quick;
  });
  res.dashboardStatsMsMedian = median(res.dashboardStatsMs); console.log(`  dashboard statistics complete           ${res.dashboardStatsMsMedian} ms`);
  // a burst of 200 changes (what a scrape or an auto-research run produces) while the grid is open: how long does the page stay busy?
  await app.evaluate(() => { location.hash = '#/base/tbl_research'; }); await app.waitForSelector('.g-row');
  await app.evaluate(() => { window.__lt = 0; });
  res.burst200 = await other.evaluate(async () => { const s = performance.now(); const S = window.__vier.S; for (let j = 0; j < 200; j++) await S.updateRecord(`rec_bench${String(100 + j).padStart(7, '0')}`, { fld_notes: `burst ${j}` }); return Math.round(performance.now() - s); });
  await new Promise(r => setTimeout(r, 2500));
  res.burstMainThreadBlockedMs = await app.evaluate(() => Math.round(window.__lt)); console.log(`  200 changes made elsewhere: writer ${res.burst200} ms; main thread of the open grid blocked ${res.burstMainThreadBlockedMs} ms`);
  res.records = N; res.at = new Date().toISOString();
} finally { await ctx.close().catch(() => {}); fs.rmSync(userData, { recursive: true, force: true }); }
const dist = fs.readdirSync(path.join(root, 'dist'), { recursive: true }).filter(f => /\.(js|css|woff2?)$/.test(String(f))).map(f => ({ f: String(f), kb: Math.round(fs.statSync(path.join(root, 'dist', String(f))).size / 1024) }));
res.distJsKB = dist.filter(d => d.f.endsWith('.js')).reduce((a, d) => a + d.kb, 0); res.distFontKB = dist.filter(d => /woff/.test(d.f)).reduce((a, d) => a + d.kb, 0); res.distFiles = dist.length;
console.log('\n' + JSON.stringify(res, null, 2));
fs.mkdirSync(path.join(root, 'tests/perf/out'), { recursive: true }); fs.writeFileSync(path.join(root, 'tests/perf/out', process.env.BENCH_LABEL ? `bench-${process.env.BENCH_LABEL}.json` : 'bench.json'), JSON.stringify(res, null, 2));
