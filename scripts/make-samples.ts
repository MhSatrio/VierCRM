// Writes the files in samples/ from the real default schema, so they always import cleanly.
import fs from 'node:fs';
import { buildDefaultFields, fid, TABLE_ID, exampleScrapeConfigs, defaultTemplates } from '../src/core/defaults';
import { toCsv } from '../src/core/csv';
import { cond, group } from '../src/core/filters';
// @ts-ignore plain JS fixtures
import { PEOPLE } from '../tests/fixtures/site.mjs';

const fields = buildDefaultFields().filter(f => !['formula', 'createdTime', 'lastModified', 'attachment'].includes(f.type));
const rows = PEOPLE.slice(0, 12).filter((p: any, i: number) => i !== 15).map((p: any) => ({
  [fid('fullName')]: p.name, [fid('position')]: p.title, [fid('department')]: p.dept, [fid('institution')]: 'Example University', [fid('country')]: 'Netherlands', [fid('email')]: p.email, [fid('phone')]: p.phone,
  [fid('profileUrl')]: `https://sample.example/people/${p.slug}`, [fid('about')]: p.bio, [fid('researchKeywords')]: p.keywords, [fid('outreachStatus')]: 'Not Contacted',
}));
fs.writeFileSync('samples/sample-researchers.csv', toCsv(fields, rows));

// a configuration for a made-up site: explicit selectors for a directory whose markup auto-detection should not be trusted
const cfg = {
  ...exampleScrapeConfigs()[0], id: 'cfg_example_university_manual', name: 'Example University – manual selectors (sample)', builtin: false,
  list: { auto: false, cardSelector: 'li.person', linkSelector: 'a' },
  mappings: [
    { fieldId: fid('fullName'), selector: 'h1', extract: 'text', from: 'profile' },
    { fieldId: fid('position'), selector: 'xpath://dt[normalize-space()="Position"]/following-sibling::dd[1]', extract: 'text', from: 'profile' },
    { fieldId: fid('department'), selector: 'xpath://dt[normalize-space()="Department"]/following-sibling::dd[1]', extract: 'text', from: 'profile' },
    { fieldId: fid('email'), selector: 'dd a[href^="mailto:"]', extract: 'email', from: 'profile' },
    { fieldId: fid('researchKeywords'), selector: 'h2 + ul li', extract: 'text', from: 'profile', multiple: true, join: ', ' },
  ],
  defaults: { [fid('institution')]: 'Example University', [fid('country')]: 'Netherlands' },
  pagination: { mode: 'next', nextSelector: 'a[rel="next"]', maxPages: 20, maxRecords: 500, maxScrollRounds: 10, delayMinMs: 1500, delayMaxMs: 3500, stopAfterEmptyPages: 2 },
};
fs.writeFileSync('samples/scrape-config-example.json', JSON.stringify(cfg, null, 2));

const auto = {
  id: 'auto_example', tableId: TABLE_ID, name: 'Introduce ourselves to contacts that are ready for outreach', enabled: false, testMode: true,
  trigger: { type: 'recordEntersView', viewId: 'view_ready' },
  conditions: group('and', cond(fid('email'), 'isNotEmpty'), cond(fid('position'), 'isNotEmpty'), cond(fid('institution'), 'isNotEmpty'), cond(fid('outreachStatus'), 'is', 'Not Contacted')),
  actions: [
    { id: 'a1', type: 'runLookup' },
    { id: 'a2', type: 'wait', seconds: 30 },
    { id: 'a3', type: 'sendEmail', templateId: 'tpl_intro', providerId: 'brevo', senderEmail: 'info@vierapparatus.com' },
    { id: 'a4', type: 'changeStatus', statusFieldId: fid('outreachStatus'), markStatus: 'Contacted' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', runCount: 0,
};
fs.writeFileSync('samples/automation-example.json', JSON.stringify(auto, null, 2));
fs.writeFileSync('samples/email-template-example.json', JSON.stringify(defaultTemplates()[0], null, 2));
console.log('samples written:', fs.readdirSync('samples').join(', '));
