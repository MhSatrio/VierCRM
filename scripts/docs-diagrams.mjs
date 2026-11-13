// Diagrams for the technical documentation: drawn as SVG in the VierApparatus palette, rendered to PNG by Chromium.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BLUE = '#4570B6', LIGHT = '#CAEBFB', INK = '#231F20', PALE = '#EAF5FC', GREY = '#E8EBF0', GOOD = '#DDF1E6', WARN = '#FCEFD0';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const wrap = (text, max) => { const out = []; let line = ''; for (const w of String(text).split(' ')) { if ((line + ' ' + w).trim().length > max) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); } if (line) out.push(line); return out; };

function make(width, height) {
  const parts = [];
  const api = {
    box(x, y, w, h, title, sub = '', fill = PALE, stroke = BLUE, tc = INK) {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>`);
      const tl = wrap(title, Math.floor(w / 8.2)); const sl = sub ? wrap(sub, Math.floor(w / 6.6)) : [];
      const total = tl.length * 18 + sl.length * 15; let yy = y + (h - total) / 2 + 14;
      for (const l of tl) { parts.push(`<text x="${x + w / 2}" y="${yy}" text-anchor="middle" font-size="15" font-weight="600" fill="${tc}">${esc(l)}</text>`); yy += 18; }
      for (const l of sl) { parts.push(`<text x="${x + w / 2}" y="${yy}" text-anchor="middle" font-size="12" fill="#4a4546">${esc(l)}</text>`); yy += 15; }
      return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
    },
    group(x, y, w, h, label) { parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="none" stroke="${BLUE}" stroke-width="1.4" stroke-dasharray="6 5"/><text x="${x + 14}" y="${y + 20}" font-size="13" font-weight="600" fill="${BLUE}">${esc(label)}</text>`); },
    arrow(x1, y1, x2, y2, label = '', color = INK, dashed = false) {
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.7" ${dashed ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#a)"/>`);
      if (label) parts.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" font-size="11.5" fill="#4a4546" paint-order="stroke" stroke="#fff" stroke-width="4">${esc(label)}</text>`);
    },
    line(x1, y1, x2, y2, color = INK) { parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.7"/>`); },
    dline(x1, y1, x2, y2, color = '#b7c2d6') { parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5 4"/>`); },
    text(x, y, t, size = 13, weight = 400, fill = INK, anchor = 'start') { parts.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(t)}</text>`); },
    html() { return `<!doctype html><html><body style="margin:0;background:#fff"><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="Jost, Segoe UI, Arial, sans-serif"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${INK}"/></marker></defs><rect width="100%" height="100%" fill="#fff"/>${parts.join('')}</svg></body></html>`; },
  };
  return api;
}

export const DIAGRAMS = {
  'architecture': { w: 1240, h: 640, draw(d) {
    d.group(10, 10, 300, 240, 'Extension pages (React)'); const side = d.box(30, 50, 260, 80, 'Side panel', 'scrape while you browse · quick contacts'); const app = d.box(30, 150, 260, 80, 'Full-page app', 'database · research · automations · e-mail');
    d.group(350, 10, 520, 470, 'Background service worker (src/background)');
    const router = d.box(370, 50, 220, 64, 'Message router', 'one place for every request'); const scr = d.box(630, 50, 220, 64, 'Scrape run', 'page loop · pause / stop', GOOD);
    const lk = d.box(370, 150, 220, 64, 'Research / lookups', 'sources · matching · PDFs'); const au = d.box(630, 150, 220, 64, 'Automation engine', 'triggers · guards · actions');
    const em = d.box(370, 250, 220, 64, 'E-mail service', 'guard rails · Brevo · Gmail'); const al = d.box(630, 250, 220, 64, 'Alarms (1 min)', 'wait · scheduled · sync');
    d.box(370, 360, 480, 90, 'Shared core (src/core)', 'data model · store · formulas · filters · dedupe · CSV · dependencies · settings', LIGHT);
    d.group(10, 290, 300, 190, 'Browser storage'); const idb = d.box(30, 330, 260, 60, 'IndexedDB', 'records · fields · views · files (PDF blobs) · logs'); d.box(30, 405, 260, 60, 'chrome.storage.local', 'API keys & OAuth tokens only', WARN);
    d.group(910, 10, 320, 300, 'Websites you scrape'); const cs = d.box(930, 50, 280, 70, 'Content script (injected)', 'detect · extract · paginate · picker · floating control', GOOD); d.box(930, 150, 280, 70, 'Directory + profile pages', 'read like a person would', GREY); d.box(930, 245, 280, 50, 'Hidden tab for JS-only profiles', '', GREY);
    d.group(910, 330, 320, 290, 'External services'); d.box(930, 370, 280, 54, 'OpenAlex · Crossref · PubMed', 'public APIs'); d.box(930, 436, 280, 54, 'Semantic Scholar · Unpaywall', 'Europe PMC · arXiv'); d.box(930, 502, 280, 54, 'Brevo API · Gmail API', 'send + analytics', WARN); d.box(930, 566, 280, 40, 'Optional webhook backend (Brevo → you)', '', GREY);
    d.arrow(310, 130, 350, 130, 'messages');
    d.arrow(160, 250, 160, 290, 'read / write directly');
    d.arrow(350, 400, 310, 400, 'read / write');
    d.arrow(870, 130, 910, 130, 'inject · crawl');
    d.arrow(870, 450, 910, 450, 'HTTPS');
    d.text(12, 628, 'Pages write to IndexedDB themselves and notify the worker (record:changed); the worker owns the automation engine and every outgoing API call.', 12, 400, '#4a4546');
  } },
  'scrape-flow': { w: 1300, h: 560, draw(d) {
    const lanes = [['Side panel', 100], ['Background worker', 360], ['Content script (page)', 640], ['Website', 920], ['Database', 1160]];
    for (const [n, x] of lanes) { d.box(x - 60, 10, 170, 46, n, '', BLUE, BLUE, '#fff'); d.dline(x + 25, 56, x + 25, 545); }
    const step = (i, from, to, label, y) => { const fx = lanes[from][1] + 25, tx = lanes[to][1] + 25; d.arrow(fx, y, tx, y, `${i}. ${label}`); };
    step(1, 0, 1, 'scrape:start (config, table)', 90); step(2, 1, 2, 'inject content.js · crawl:page', 135);
    step(3, 2, 3, 'wait for list · expand (load more / scroll)', 180); d.text(lanes[2][1] + 40, 220, '4. detect people on the page (cards, links, names)', 11.5, 400, '#4a4546'); step(5, 2, 3, 'fetch profile (same site)', 255);
    step(6, 2, 1, 'render profile if JS-only / other domain', 300); step(7, 1, 3, 'open hidden tab · read · close', 335);
    step(8, 2, 1, 'scrape:person (values, status)', 380); step(9, 1, 4, 'de-duplicate · create / merge record', 420); step(10, 1, 0, 'scrape:progress', 455);
    step(11, 2, 1, 'page result: nextUrl · seen · stop reason', 495); step(12, 1, 3, 'navigate to next page → repeat from 2', 530);
  } },
  'research-chain': { w: 1240, h: 600, draw(d) {
    d.box(20, 30, 150, 60, 'Full Name', 'Institution · Profile URL', GOOD);
    d.group(215, 10, 330, 250, 'Sources, in the order you choose'); d.box(235, 40, 140, 36, 'OpenAlex', ''); d.box(385, 40, 140, 36, 'Crossref', ''); d.box(235, 86, 140, 36, 'Semantic Scholar', ''); d.box(385, 86, 140, 36, 'PubMed', ''); d.box(235, 132, 140, 36, 'Google Scholar*', '', GREY); d.box(385, 132, 140, 36, 'ResearchGate*', '', GREY);
    d.text(235, 196, '* read through a tab in your own browser,', 12, 400, '#4a4546'); d.text(235, 212, '  one page / 8 s, stops at any human check', 12, 400, '#4a4546');
    d.box(590, 40, 200, 80, 'Score each author', 'name · institution · ORCID / profile id · topics'); d.box(590, 150, 200, 80, 'Confident AND clear lead?', 'default ≥ 75 % and ≥ 20 points ahead');
    d.box(850, 30, 190, 60, 'Choose automatically', '', GOOD); d.box(850, 150, 190, 66, 'Show candidates', 'you pick, then it continues', WARN);
    d.box(1075, 80, 140, 80, 'Latest Publication', 'stored with the author match', LIGHT);
    d.arrow(170, 60, 215, 60); d.arrow(545, 80, 590, 80); d.arrow(690, 120, 690, 150); d.arrow(790, 175, 850, 70, 'yes'); d.arrow(790, 200, 850, 185, 'no');
    d.arrow(1040, 70, 1075, 105); d.arrow(1040, 185, 1075, 140);
    d.line(1145, 160, 1145, 290); d.line(1145, 290, 105, 290); d.text(20, 282, 'every field below reads the stored publication', 12, 400, '#4a4546');
    const row = [[20, 170, 'DOI · URL · Date · Venue · Access', 'derived – no network', PALE], [210, 170, 'Abstract', 'stored, or fetched by DOI', PALE], [400, 170, 'Research Keywords', 'from the paper itself · only if empty', PALE], [590, 200, 'PDF finder', 'lawful sources only', GOOD]];
    for (const [x, w, t, sub, f] of row) { d.line(x + w / 2, 290, x + w / 2, 310); d.arrow(x + w / 2, 306, x + w / 2, 330); d.box(x, 330, w, 66, t, sub, f); }
    d.arrow(790, 363, 850, 363); d.box(850, 330, 340, 66, 'Valid %PDF → attach · otherwise “Full text unavailable”', 'metadata and links are always kept', WARN);
    d.text(20, 140, 'If an upstream field is', 13, 600, INK); d.text(20, 158, 'empty, everything below it', 13, 400); d.text(20, 176, 'is skipped; the log names', 13, 400); d.text(20, 194, 'the missing field.', 13, 400);
    d.group(20, 430, 1195, 150, 'PDF finder order (first valid PDF wins)'); ['link from the source', 'Unpaywall (your e-mail)', 'OpenAlex locations', 'Europe PMC', 'arXiv', 'landing page (citation_pdf_url)'].forEach((n, i) => { d.box(40 + i * 193, 475, 172, 80, n, i === 5 ? 'your own login only if enabled' : '', PALE); if (i) d.arrow(40 + i * 193 - 21, 510, 40 + i * 193, 510); });
  } },
  'automation-flow': { w: 1240, h: 470, draw(d) {
    const t = d.box(20, 30, 200, 130, 'Trigger', 'record created / updated · field becomes (non-)empty · enters a view · scraping done · publication found · schedule · manual', PALE);
    const g = d.box(260, 40, 210, 110, 'Guards', '1 loop: chain & depth ≤ 4  ·  2 repeat: one-shot key per record & value', WARN);
    const c = d.box(520, 60, 180, 70, 'Conditions', 'AND / OR / NOT, nested', PALE);
    const a = d.box(750, 20, 230, 150, 'Actions, in order', 'send e-mail · update field · change status · create record · run lookup · download PDF · update publication · wait · run automation', LIGHT);
    d.arrow(220, 95, 260, 95); d.arrow(470, 95, 520, 95); d.arrow(700, 95, 750, 95);
    const w = d.box(750, 220, 230, 70, 'Writes carry chain + depth', 'so the change they cause knows who made it', GOOD); d.arrow(865, 170, 865, 220); d.arrow(750, 255, 400, 150, 'the new change goes back to Guards', INK, true);
    const tm = d.box(1020, 20, 200, 90, 'Test mode', 'describes every step; writes, sends and downloads NOTHING', GREY); d.arrow(980, 70, 1020, 65, '', INK, true);
    const em = d.box(1020, 140, 200, 150, 'E-mail extra gates', 'automation ON · test mode OFF · global “Allow sending” · not do-not-contact / bounced / unsubscribed · not already sent · daily cap · min gap · sender verified', WARN); d.arrow(980, 110, 1020, 190);
    const wt = d.box(20, 220, 260, 70, 'Wait action', 'saved as a pending job; the 1-minute alarm resumes the run', PALE);
    d.box(20, 340, 1200, 100, 'Every run is logged: trigger · steps · status (ok / test / skipped / error / waiting) · chain · retry link', 'Retry re-runs the automation for that record; history is kept per automation.', GREY);
    void t; void g; void c; void a; void w; void tm; void em; void wt;
  } },
};

export async function renderDiagrams(outDir, exe) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const files = {};
  for (const [name, def] of Object.entries(DIAGRAMS)) {
    const d = make(def.w, def.h); def.draw(d);
    const page = await browser.newPage({ viewport: { width: def.w, height: def.h }, deviceScaleFactor: 1.5 }); await page.setContent(d.html());
    const file = path.join(outDir, `${name}.png`); await page.screenshot({ path: file, clip: { x: 0, y: 0, width: def.w, height: def.h } }); files[name] = file; await page.close();
  }
  await browser.close(); return files;
}
