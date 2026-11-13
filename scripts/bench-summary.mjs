// Median of the "final*" benchmark runs next to the recorded "before" run → tests/perf/out/summary.json (read by build-docs.mjs).
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve(import.meta.dirname, '../tests/perf/out');
const load = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const finals = fs.readdirSync(dir).filter(f => /^bench-final[g-z]\.json$/.test(f)).map(load);
const before = load('bench-before.json');
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const keys = ['openBase (grid with rows)', 'another tab edits a cell → grid shows it', 'switch view (Missing Email)', 'search “anna fixture” (keystrokes)', 'sort by Full Name (header click)', 'dashboard (all bases counted)', 'burstMainThreadBlockedMs', 'heapMB'];
const rows = keys.map(k => ({ metric: k, before: before[k] ?? null, after: med(finals.map(f => f[k])), runs: finals.map(f => f[k]) }));
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ records: before.records, runsAfter: finals.length, rows, distJsKB: finals[0]?.distJsKB, distFontKB: finals[0]?.distFontKB, at: new Date().toISOString() }, null, 2));
console.log(JSON.stringify(rows, null, 1));
