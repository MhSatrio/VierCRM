// Renders the extension icons from the VierApparatus website's own icon (assets/icon.svg = vierapparatus/src/app/icon.svg).
// Run on demand (`npm run icons`) – the PNGs in public/icons are committed, so a normal build needs no browser.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
const exe = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');
const svg = fs.readFileSync('assets/icon.svg', 'utf8');
fs.mkdirSync('public/icons', { recursive: true });
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined });
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: `public/icons/icon${size}.png`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
  }
} finally { await browser.close(); }
console.log('icons written from assets/icon.svg');
