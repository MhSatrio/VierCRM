// End-to-end: the REAL built extension issues applicant tokens from its own table, against a RUNNING assessment server.
//   npm run build && npm run e2e:tokens            (ASSESSMENT_URL defaults to http://localhost:3002; HEADED=1 to watch)
// The issuer key is read from the assessment's .env.local and is never printed. Only fictional names are used, and each run
// issues a few tokens from the server's daily cap (20 a day, UTC). Nothing is sent by e-mail.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'tests/e2e/out'); fs.mkdirSync(out, { recursive: true });
const exe = process.env.CHROMIUM || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1248/chrome-win64/chrome.exe');
const ASSESSMENT = (process.env.ASSESSMENT_URL || 'http://localhost:3002').replace(/\/$/, '');
const ASSESSMENT_ENV = process.env.ASSESSMENT_ENV || path.resolve(root, '../vier-assessment/.env.local');
const TABLE = 'tbl_research';   // the Researchers base: it has a "Full Name" field (key fullName)
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail && !ok ? `  → ${String(detail).slice(0, 300)}` : ''}`); };
const step = s => console.log(`\n▶ ${s}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Read the key without printing it.
const issuerKey = (() => {
  if (!fs.existsSync(ASSESSMENT_ENV)) return '';
  const line = fs.readFileSync(ASSESSMENT_ENV, 'utf8').split(/\r?\n/).find(l => l.startsWith('TOKEN_ISSUER_KEY='));
  return line ? line.slice('TOKEN_ISSUER_KEY='.length).trim().replace(/^['"]|['"]$/g, '') : '';
})();
if (!issuerKey) { console.error(`TOKEN_ISSUER_KEY was not found in ${ASSESSMENT_ENV}.`); process.exit(2); }
if (!fs.existsSync(path.join(root, 'dist/manifest.json'))) { console.error('dist/ not found – run `npm run build` first'); process.exit(2); }

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'viercrm-tokens-'));
const extDir = path.join(userData, 'ext');
fs.cpSync(path.join(root, 'dist'), extDir, { recursive: true });
// The test copy of the manifest holds the broad host access the real extension asks for at run time (see run.mjs).
const mf = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
mf.host_permissions.push('https://*/*', 'http://*/*'); fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(mf, null, 2));
const ctx = await chromium.launchPersistentContext(userData, {
  executablePath: exe, headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...(process.env.HEADED ? [] : ['--headless=new']), '--no-first-run', '--window-size=1400,950'],
  viewport: { width: 1360, height: 900 },
});

let finishCode = 0;
try {
  step('Extension loads and the assessment server answers');
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  const health = await fetch(`${ASSESSMENT}/access`).catch(() => null);
  check('the assessment server is reachable', health !== null && health.status === 200, `${ASSESSMENT}/access`);

  const app = await ctx.newPage();
  const errors = [];
  app.on('pageerror', e => errors.push(String(e)));
  app.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  step('Settings: the server address and the issuer key are saved in the extension');
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/settings`); await app.waitForSelector('h1:has-text("Settings")', { timeout: 20000 });
  await app.getByLabel('Server address').fill(ASSESSMENT);
  await app.getByLabel('Token issuer key').fill(issuerKey);
  await app.getByRole('button', { name: 'Save settings' }).click();
  await sleep(700);
  await app.reload(); await app.waitForSelector('h1:has-text("Settings")', { timeout: 20000 });
  check('the server address is kept after a reload', (await app.getByLabel('Server address').inputValue()) === ASSESSMENT);
  check('the issuer key is stored (shown only as saved, never as text)', /saved/.test(await app.getByLabel('Token issuer key').getAttribute('placeholder') ?? ''));

  step('The base: three fictional people with a Full Name');
  const sfx = Math.random().toString(36).slice(2, 7);
  const people = [`Token Check Alpha ${sfx}`, `Token Check Beta ${sfx}`];
  await app.goto(`chrome-extension://${extId}/app.html?e2e#/base/${TABLE}`); await app.waitForSelector('.g-row, .grid-wrap', { timeout: 20000 });
  await app.evaluate(async ({ names, table }) => {
    const { S } = window.__vier;
    const fields = await S.listFields(table);
    const nameField = fields.find(f => f.key === 'fullName') ?? fields.find(f => f.name.trim().toLowerCase() === 'full name');
    for (const n of names) await S.createRecord(table, { [nameField.id]: n });
  }, { names: people, table: TABLE });
  await app.reload(); await app.waitForSelector('input[aria-label="Select row 1"]', { timeout: 20000 });
  check('the Researchers base shows the two new people', (await app.locator('.grid-wrap').innerText()).includes(people[0]));

  const selectFirstTwo = async () => {
    await app.locator('input[aria-label="Select row 1"]').check();
    await app.locator('input[aria-label="Select row 2"]').check();
    await sleep(250);
  };
  const tokensByName = () => app.evaluate(async ({ names, table }) => {
    const { S } = window.__vier;
    const fields = await S.listFields(table);
    const nameField = fields.find(f => f.key === 'fullName') ?? fields.find(f => f.name.trim().toLowerCase() === 'full name');
    const tokenField = fields.find(f => f.name === 'token');
    const expiresField = fields.find(f => f.name === 'token expires');
    const out = {};
    for (const r of await S.listRecords(table)) {
      const name = r.cells[nameField.id];
      if (names.includes(name)) out[name] = { token: r.cells[tokenField?.id] ?? null, expires: r.cells[expiresField?.id] ?? null };
    }
    return { out, hasFields: Boolean(tokenField && expiresField) };
  }, { names: people, table: TABLE });

  step('Issue tokens: two selected people get a token each, written into the base');
  await selectFirstTwo();
  check('the selection bar offers Issue tokens and Re-issue', (await app.locator('.selbar button', { hasText: 'Issue tokens' }).count()) === 1 && (await app.locator('.selbar button', { hasText: 'Re-issue' }).count()) === 1);
  app.once('dialog', d => d.accept());
  await app.locator('.selbar button', { hasText: 'Issue tokens' }).click();
  await app.locator('.toasts', { hasText: /Issued 2 token/ }).waitFor({ timeout: 25000 }).catch(() => {});
  const first = await tokensByName();
  check('the token and token expires fields were created in the base', first.hasFields);
  const TOKEN = /^VA-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
  check('each person has a token in the documented format', people.every(n => TOKEN.test(first.out[n]?.token ?? '')), JSON.stringify(first.out));
  check('each token expires four days after it was issued', people.every(n => {
    const days = (Date.parse(first.out[n]?.expires) - Date.now()) / 86400000;
    return days > 3.9 && days <= 4.01;
  }), JSON.stringify(first.out));
  check('the token is not derived from the name', people.every(n => !(first.out[n]?.token ?? '').toLowerCase().includes('token')));

  step('Issue again without replace: a still-valid token is not overwritten');
  await app.reload(); await app.waitForSelector('input[aria-label="Select row 1"]', { timeout: 20000 });
  await selectFirstTwo();
  app.once('dialog', d => d.accept());
  await app.locator('.selbar button', { hasText: 'Issue tokens' }).click();
  await app.locator('.toasts', { hasText: /skipped/ }).waitFor({ timeout: 25000 }).catch(() => {});
  const toastText = await app.locator('.toasts').innerText().catch(() => '');
  const again = await tokensByName();
  check('the second issue is refused with the reason shown', /still valid/.test(toastText), toastText.slice(0, 200));
  check('the existing tokens are unchanged after the refusal', people.every(n => again.out[n]?.token === first.out[n]?.token));

  step('Re-issue (cancels old): replaces the tokens, and the old ones stop working');
  await app.reload(); await app.waitForSelector('input[aria-label="Select row 1"]', { timeout: 20000 });
  await selectFirstTwo();
  app.once('dialog', d => d.accept());
  await app.locator('.selbar button', { hasText: 'Re-issue' }).click();
  await app.locator('.toasts', { hasText: /Issued 2 token/ }).waitFor({ timeout: 25000 }).catch(() => {});
  const reissued = await tokensByName();
  check('re-issuing gives each person a new token', people.every(n => reissued.out[n]?.token && reissued.out[n].token !== first.out[n].token));

  step('Sign-in: the issued token opens the assessment, and the replaced token does not');
  const candidate = await ctx.newPage();
  await candidate.goto(`${ASSESSMENT}/access`, { waitUntil: 'domcontentloaded' });
  const oldLogin = await candidate.evaluate(async ({ username, token }) => (await fetch('/api/access/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, token }) })).status, { username: people[0], token: first.out[people[0]].token });
  check('the replaced token is refused (401)', oldLogin === 401, `status ${oldLogin}`);
  await candidate.goto(`${ASSESSMENT}/access`, { waitUntil: 'domcontentloaded' });
  await candidate.getByLabel('Full name').fill(people[0].toUpperCase().replace(/\s+/g, '   '));
  await candidate.getByLabel('Unique access token').fill(reissued.out[people[0]].token);
  await candidate.getByRole('button', { name: /Sign in/ }).click();
  await candidate.waitForURL(/\/test$/, { timeout: 25000 }).catch(() => {});
  check('the new token signs in with the full name, in capitals and extra spaces', /\/test$/.test(new URL(candidate.url()).pathname), candidate.url());

  step('Console hygiene');
  check('no uncaught errors in the extension page', errors.filter(e => !/favicon|Failed to load resource|ERR_/i.test(e)).length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('the token run completed without crashing', false, String(err.stack || err).slice(0, 700)); finishCode = 1;
  for (const [i, pg] of ctx.pages().entries()) { try { await pg.screenshot({ path: path.join(out, `tokens-failure-${i}.png`) }); } catch { /* ignore */ } }
} finally {
  await ctx.close().catch(() => {}); fs.rmSync(userData, { recursive: true, force: true });
  const failed = results.filter(r => !r.ok);
  fs.writeFileSync(path.join(out, 'tokens-report.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: failed.length, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map(f => f.name).join('; ')}` : ''}`);
  process.exit(failed.length || finishCode ? 1 : 0);
}
