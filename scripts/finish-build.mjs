// Vite copies public/ (manifest, icons) into dist/ already; this just verifies the extension is complete.
import fs from 'node:fs';
const need = ['manifest.json', 'background.js', 'content.js', 'sidepanel.html', 'app.html', 'icons/icon128.png'];
const missing = need.filter(f => !fs.existsSync(`dist/${f}`));
if (missing.length) { console.error('Build incomplete, missing:', missing.join(', ')); process.exit(1); }
console.log('dist/ ready – load it at chrome://extensions → Developer mode → Load unpacked');
