// Base templates. A "base" (an Airtable-style table) starts from a template – Contacts, Companies, Researchers or Blank – and from then
// on is just a table: add, rename or remove any field. Research features (latest publication, DOI, PDF …) are an add-on that works in ANY base.
//
// Every field has a semantic `key` (email, fullName, latestPublication …). Scraping, e-mail and research find fields by key, so the same
// code serves every base. Field ids are unique per base: `fld_<key>` in the original Researchers base (tbl_research, kept for existing
// data) and `<tableId>__<key>` everywhere else.
import type { ConditionGroup, EmailTemplate, Field, FieldType, LookupConfig, ScrapeConfig, View } from './types';
import { cond, emptyGroup, group } from './filters';
import type { DedupeRule } from './dedupe';

export const TABLE_ID = 'tbl_research';          // the Researchers base (id kept so existing data and links keep working)
export const DB_ID = 'db_research';
export const WORKSPACE_ID = 'ws_main';
export const CONTACTS_ID = 'tbl_contacts';
export const COMPANIES_ID = 'tbl_companies';

/** id of the field with this key in the Researchers base (used by tests and the original sample files). */
export const fid = (key: string) => `fld_${key}`;
export const fidFor = (tableId: string, key: string) => (tableId === TABLE_ID ? `fld_${key}` : `${tableId}__${key}`);
export const keyOf = (f: { id: string; key?: string }): string => f.key ?? (f.id.startsWith('fld_') ? f.id.slice(4) : f.id.includes('__') ? f.id.split('__')[1] : '');
export const fieldOf = <T extends { id: string; key?: string }>(fields: T[], key: string): T | undefined => fields.find(f => keyOf(f) === key);
export const idOf = (fields: { id: string; key?: string }[], key: string): string | undefined => fieldOf(fields, key)?.id;

export const OUTREACH_CHOICES = ['Not Contacted', 'Contacted', 'Replied', 'Follow-up needed', 'Not interested', 'Do not contact'];
export const SCRAPING_STATUS = ['Scraped', 'Partial', 'Failed'];
export const PUBLICATION_STATUS = ['Found', 'Needs match', 'Not found', 'PDF attached', 'Full text unavailable', 'Skipped'];
export const EMAIL_STATUS = ['Not sent', 'Sent', 'Delivered', 'Opened', 'Clicked', 'Bounced', 'Unsubscribed'];

type IdOf = (key: string) => string | undefined;
interface Spec { name: string; type: FieldType; width?: number; description?: string; choices?: string[]; hidden?: boolean; lookup?: (id: IdOf) => LookupConfig }

const SOURCES = ['openalex', 'crossref', 'semanticscholar', 'pubmed'] as const;
const derive = (output: LookupConfig['output']) => (id: IdOf): LookupConfig => ({ kind: 'derive', fromFieldId: id('latestPublication'), output });

/** Every field any template can use. */
export const CATALOG: Record<string, Spec> = {
  fullName: { name: 'Full Name', type: 'text', width: 210 },
  firstName: { name: 'First Name', type: 'text', width: 120, hidden: true },
  lastName: { name: 'Last Name', type: 'text', width: 120, hidden: true },
  position: { name: 'Position', type: 'text', width: 180 },
  department: { name: 'Department', type: 'text', width: 190, hidden: true },
  institution: { name: 'Institution', type: 'text', width: 210 },
  country: { name: 'Country', type: 'text', width: 120 },
  location: { name: 'Location', type: 'text', width: 160 },
  email: { name: 'Email', type: 'email', width: 230 },
  phone: { name: 'Phone', type: 'phone', width: 150, hidden: true },
  website: { name: 'Website', type: 'url', width: 200 },
  industry: { name: 'Industry', type: 'text', width: 160 },
  size: { name: 'Size', type: 'text', width: 110 },
  profileUrl: { name: 'Profile URL', type: 'url', width: 220 },
  about: { name: 'About', type: 'longText', width: 280 },
  researchKeywords: { name: 'Research Keywords', type: 'text', width: 240, description: 'Scraped from the profile; filled from the latest publication only when empty', lookup: id => ({ kind: 'keywords', fromFieldId: id('latestPublication'), output: 'keywords' }) },
  latestResearch: { name: 'Latest Research', type: 'text', width: 260, hidden: true, description: 'Topic of the latest publication', lookup: derive('title') },
  latestPublication: { name: 'Latest Publication', type: 'text', width: 300, lookup: id => ({ kind: 'search', sources: [...SOURCES], nameFieldId: id('fullName'), institutionFieldId: id('institution'), profileUrlFieldId: id('profileUrl'), output: 'title' }) },
  publicationDate: { name: 'Publication Date', type: 'date', width: 130, lookup: derive('date') },
  publicationUrl: { name: 'Publication URL', type: 'url', width: 220, lookup: derive('url') },
  publicationDoi: { name: 'Publication DOI', type: 'text', width: 200, lookup: derive('doi') },
  publicationFile: { name: 'Publication File', type: 'attachment', width: 260, description: 'Legally accessible PDF (open access / repository / your own upload)', lookup: id => ({ kind: 'pdf', fromFieldId: id('latestPublication'), output: 'pdf' }) },
  publicationAccess: { name: 'Publication Access', type: 'text', width: 170, hidden: true, lookup: derive('access') },
  publicationStatus: { name: 'Publication Status', type: 'publicationStatus', width: 160, choices: PUBLICATION_STATUS },
  sourceUrl: { name: 'Source URL', type: 'url', width: 220, hidden: true },
  scrapingDate: { name: 'Scraping Date', type: 'date', width: 130 },
  scrapingStatus: { name: 'Scraping Status', type: 'scrapingStatus', width: 140, choices: SCRAPING_STATUS },
  outreachStatus: { name: 'Outreach Status', type: 'singleSelect', width: 160, choices: OUTREACH_CHOICES },
  emailStatus: { name: 'Email Status', type: 'emailStatus', width: 130, hidden: true, choices: EMAIL_STATUS },
  emailSent: { name: 'Email Sent', type: 'checkbox', width: 100 },
  emailOpened: { name: 'Email Opened', type: 'checkbox', width: 110, description: 'From Brevo analytics – imperfect (privacy protections and scanners)' },
  lastOpened: { name: 'Last Opened', type: 'date', width: 120, hidden: true },
  emailClicked: { name: 'Email Clicked', type: 'checkbox', width: 110 },
  lastClicked: { name: 'Last Clicked', type: 'date', width: 120, hidden: true },
  notes: { name: 'Notes', type: 'longText', width: 240 },
  // Google Maps places
  socials: { name: 'Social Links', type: 'longText', width: 240, description: 'WhatsApp, Facebook, Instagram, LinkedIn … found on the business’s own website' },
  rating: { name: 'Rating', type: 'number', width: 90 },
  reviews: { name: 'Reviews', type: 'number', width: 90 },
  hours: { name: 'Opening Hours', type: 'longText', width: 220, hidden: true },
  plusCode: { name: 'Plus Code', type: 'text', width: 140, hidden: true },
  coordinates: { name: 'Coordinates', type: 'text', width: 160, hidden: true, description: 'latitude, longitude' },
  searchQuery: { name: 'Search', type: 'text', width: 180, hidden: true, description: 'The Google Maps search that found this place' },
  created: { name: 'Created', type: 'createdTime', width: 150, hidden: true },
  modified: { name: 'Last Modified', type: 'lastModified', width: 150, hidden: true },
};

const OUTREACH_TAIL = ['sourceUrl', 'scrapingDate', 'scrapingStatus', 'outreachStatus', 'emailStatus', 'emailSent', 'emailOpened', 'lastOpened', 'emailClicked', 'lastClicked', 'notes', 'created', 'modified'];
/** the add-on: works in any base that has a name field */
export const RESEARCH_KEYS = ['researchKeywords', 'latestResearch', 'latestPublication', 'publicationDate', 'publicationUrl', 'publicationDoi', 'publicationFile', 'publicationAccess', 'publicationStatus'];

export interface Template { id: string; name: string; description: string; icon: string; fields: (string | [string, Partial<Spec>])[]; autoResearch?: boolean }
export const TEMPLATES: Template[] = [
  { id: 'contacts', name: 'Contacts', icon: '☺', description: 'People: name, position, company, e-mail, phone, profile link – for LinkedIn / Apollo exports, event lists, anyone you contact.',
    fields: ['fullName', 'firstName', 'lastName', 'position', ['institution', { name: 'Company' }], 'country', 'email', 'phone', ['profileUrl', { name: 'Profile URL' }], 'about', ...OUTREACH_TAIL] },
  { id: 'companies', name: 'Companies', icon: '▣', description: 'Organisations: name, website, industry, size, location, contact e-mail and phone.',
    fields: [['fullName', { name: 'Company' }], 'website', 'industry', 'size', 'location', 'country', 'email', 'phone', ['profileUrl', { name: 'Listing / profile URL' }], ['about', { name: 'Description' }], ...OUTREACH_TAIL] },
  { id: 'places', name: 'Places', icon: '⌖', description: 'Businesses from Google Maps searches (freight forwarders, boarding houses, clinics …): category, address, phone, website, e-mail from the website, rating, hours, Maps link.',
    fields: [['fullName', { name: 'Name' }], ['industry', { name: 'Category' }], ['location', { name: 'Address', width: 260 }], ['phone', { hidden: false }], 'website', 'email', 'socials', 'rating', 'reviews', 'hours', 'plusCode', 'coordinates', ['profileUrl', { name: 'Google Maps link' }], 'searchQuery', ...OUTREACH_TAIL] },
  { id: 'researchers', name: 'Researchers', icon: '✦', autoResearch: true, description: 'Contacts plus research fields: latest publication, DOI, date, URL, PDF, keywords – found automatically.',
    fields: ['fullName', 'firstName', 'lastName', 'position', 'department', 'institution', 'country', 'email', 'phone', 'profileUrl', 'about', ...RESEARCH_KEYS, 'sourceUrl', 'scrapingDate', 'scrapingStatus', 'outreachStatus', 'emailStatus', 'emailSent', 'emailOpened', 'lastOpened', 'emailClicked', 'lastClicked', 'notes', 'created', 'modified'] },
  { id: 'blank', name: 'Blank', icon: '▢', description: 'Just a name, notes and scraping details. Add the fields you need.',
    fields: [['fullName', { name: 'Name' }], 'notes', 'website', 'sourceUrl', 'scrapingDate', 'scrapingStatus'] },
];
export const templateById = (id?: string) => TEMPLATES.find(t => t.id === id) ?? TEMPLATES[0];

export function buildFields(tableId: string, templateId: string): Field[] {
  const t = templateById(templateId); const id = (key: string) => fidFor(tableId, key);
  const present = new Set(t.fields.map(f => (Array.isArray(f) ? f[0] : f)));
  const has: IdOf = key => (present.has(key) ? id(key) : undefined);
  return t.fields.map((f, order) => {
    const [key, over] = Array.isArray(f) ? f : [f, {}]; const s = { ...CATALOG[key], ...over }; const lookup = s.lookup?.(has);
    return { id: id(key), key, tableId, name: s.name, type: s.type, order, width: s.width, primary: key === 'fullName' || undefined, description: s.description, lookup, hidden: s.hidden || undefined,
      options: s.choices ? { choices: s.choices.map((c, i) => ({ id: `${key}_${i}`, name: c })) } : undefined } as Field;
  });
}

/** Research fields to add to a base that does not have them yet (by key). Names are matched too, so nothing is duplicated. */
export function researchAddOn(tableId: string, existing: Field[]): Field[] {
  const taken = new Set(existing.map(f => keyOf(f))); const names = new Set(existing.map(f => f.name.trim().toLowerCase()));
  const all = [...existing.map(f => f.key ? f : { ...f, key: keyOf(f) }), ...RESEARCH_KEYS.map(k => ({ id: fidFor(tableId, k), key: k }))];
  const has: IdOf = key => (all.some(f => f.key === key) ? all.find(f => f.key === key)!.id : undefined);
  let order = existing.length;
  return RESEARCH_KEYS.filter(k => !taken.has(k) && !names.has(CATALOG[k].name.toLowerCase())).map(k => { const s = CATALOG[k]; return { id: fidFor(tableId, k), key: k, tableId, name: s.name, type: s.type, order: order++, width: s.width, description: s.description, hidden: s.hidden || undefined, lookup: s.lookup?.(has), options: s.choices ? { choices: s.choices.map((c, i) => ({ id: `${k}_${i}`, name: c })) } : undefined } as Field; });
}

const vid = (tableId: string, name: string) => (tableId === TABLE_ID ? `view_${name}` : `${tableId}__view_${name}`);
const choiceName = (key: string, i: number) => CATALOG[key].choices![i];
export function buildViews(tableId: string, templateId: string): View[] {
  const id = (k: string) => fidFor(tableId, k); const t = templateById(templateId); const keys = new Set(t.fields.map(f => (Array.isArray(f) ? f[0] : f)));
  const mk = (name: string, slug: string, filter: ConditionGroup, extra: Partial<View> = {}): View => ({ id: vid(tableId, slug), tableId, name, filter, sort: [], hiddenFieldIds: [], order: 0, builtin: true, ...extra });
  const out: View[] = [mk('All records', 'all', emptyGroup())];
  if (keys.has('scrapingDate')) out.push(mk('Recently Scraped', 'recent', group('and', cond(id('scrapingDate'), 'isNotEmpty')), { sort: [{ fieldId: id('scrapingDate'), dir: 'desc' }] }));
  if (keys.has('email')) out.push(mk('Missing Email', 'noemail', group('and', cond(id('fullName'), 'isNotEmpty'), cond(id('email'), 'isEmpty'))));
  if (keys.has('outreachStatus') && keys.has('email')) {
    const need = ['position', 'institution'].filter(k => keys.has(k)).map(k => cond(id(k), 'isNotEmpty'));
    out.push(mk('Ready for Outreach', 'ready', group('and', cond(id('email'), 'isNotEmpty'), ...need, cond(id('outreachStatus'), 'is', 'Not Contacted'))));
  }
  if (keys.has('latestPublication')) {
    out.push(mk('Missing Publication', 'nopub', group('and', cond(id('fullName'), 'isNotEmpty'), cond(id('latestPublication'), 'isEmpty'))));
    out.push(mk('Publication Found', 'pubfound', group('and', cond(id('latestPublication'), 'isNotEmpty'))));
    out.push(mk('PDF Available', 'pdf', group('and', cond(id('publicationFile'), 'isNotEmpty'))));
  }
  if (keys.has('emailSent')) {
    out.push(mk('Email Sent', 'sent', group('and', cond(id('emailSent'), 'isTrue'))));
    out.push(mk('Email Opened', 'opened', group('and', cond(id('emailOpened'), 'isTrue'))));
    out.push(mk('Follow-Up Required', 'followup', group('and', cond(id('emailSent'), 'isTrue'), cond(id('outreachStatus'), 'is', choiceName('outreachStatus', 1)), cond(id('emailClicked'), 'isFalse'))));
  }
  if (keys.has('scrapingStatus')) out.push(mk('Failed Scraping', 'failed', group('and', cond(id('scrapingStatus'), 'is', 'Failed'))));
  return out.map((v, order) => ({ ...v, order }));
}

export function rulesFor(tableId: string, templateId: string): DedupeRule[] {
  const id = (k: string) => fidFor(tableId, k); const keys = new Set(templateById(templateId).fields.map(f => (Array.isArray(f) ? f[0] : f)));
  const rules: DedupeRule[] = [];
  if (templateId === 'places') {
    // branches of one chain share a website, a mailbox and often a name: only the Maps link, "same name + same phone" or "same name + same address" identify the SAME place
    return [
      { id: 'dd-profile', name: 'Same Google Maps link', fieldIds: [id('profileUrl')], normalize: 'url', enabled: true },
      { id: 'dd-name-phone', name: 'Same name and phone number', fieldIds: [id('fullName'), id('phone')], normalize: 'text', enabled: true },
      { id: 'dd-name-address', name: 'Same name at the same address', fieldIds: [id('fullName'), id('location')], normalize: 'text', enabled: true },
      { id: 'dd-email', name: 'Same e-mail address (off: branches share one)', fieldIds: [id('email')], normalize: 'email', enabled: false },
      { id: 'dd-website', name: 'Same website (off: branches share one)', fieldIds: [id('website')], normalize: 'url', enabled: false },
    ];
  }
  if (keys.has('email')) rules.push({ id: 'dd-email', name: 'Same e-mail address', fieldIds: [id('email')], normalize: 'email', enabled: true });
  if (keys.has('website')) rules.push({ id: 'dd-website', name: 'Same website', fieldIds: [id('website')], normalize: 'url', enabled: true });
  if (keys.has('profileUrl')) rules.push({ id: 'dd-profile', name: 'Same profile URL', fieldIds: [id('profileUrl')], normalize: 'url', enabled: true });
  if (keys.has('publicationDoi')) rules.push({ id: 'dd-doi', name: 'Same publication DOI', fieldIds: [id('publicationDoi')], normalize: 'doi', enabled: false });
  const second = keys.has('institution') ? 'institution' : keys.has('website') ? 'website' : null;
  const guards = ['email', 'profileUrl'].filter(k => keys.has(k)).map(k => ({ fieldId: id(k), normalize: (k === 'email' ? 'email' : 'url') as 'email' | 'url' }));
  rules.push({ id: 'dd-name-inst', name: second ? `Same name at the same ${second === 'institution' ? (templateId === 'contacts' ? 'company' : 'institution') : 'website'} (unless e-mail or profile differ)` : 'Same name (unless e-mail or profile differ)', fieldIds: second ? [id('fullName'), id(second)] : [id('fullName')], normalize: 'text', enabled: true, unlessDifferent: guards });
  return rules;
}

// ------------------------------------------------------------------ the original Researchers base (kept for tests, samples, existing data)
export const DEFAULT_FIELDS = TEMPLATES.find(t => t.id === 'researchers')!.fields.map(f => (Array.isArray(f) ? f[0] : f));
export const buildDefaultFields = (tableId = TABLE_ID) => buildFields(tableId, 'researchers');
export const buildDefaultViews = () => buildViews(TABLE_ID, 'researchers');
export const defaultRules = () => rulesFor(TABLE_ID, 'researchers');

export function defaultTemplates(): EmailTemplate[] {
  const now = new Date().toISOString();
  return [
    { id: 'tpl_intro', name: 'Introduction – researchers', createdAt: now, updatedAt: now, subject: 'Laboratory equipment sourcing for {Institution | fallback: your laboratory}',
      body: ['Hi {First Name | fallback: Researcher},', '', 'I noticed your research at {Institution}.', '[[I was particularly interested in your work on {Latest Research}.]]', '', 'Would you be open to discussing laboratory equipment sourcing?', '', 'Best regards,', 'VierApparatus', 'https://vierapparatus.com'].join('\n') },
    { id: 'tpl_company', name: 'Introduction – company contacts', createdAt: now, updatedAt: now, subject: 'Working together with {Company | fallback: your team}',
      body: ['Hi {First Name | fallback: there},', '', '[[I came across {Company} and thought a short conversation could be useful.]]', '', 'VierApparatus sources laboratory equipment worldwide. Would you be open to a quick call?', '', 'Best regards,', 'VierApparatus', 'https://vierapparatus.com'].join('\n') },
  ];
}

/** The example scraping configuration shipped with the extension: any directory of people. */
export function exampleScrapeConfigs(): ScrapeConfig[] {
  const now = new Date().toISOString();
  const base = { builtin: true, createdAt: now, mappings: [], autoDetect: { email: true, phone: true, name: true, position: true, institution: true, biography: true }, visitProfiles: true, returnToDirectory: true, renderJsProfiles: true,
    pagination: { mode: 'auto' as const, maxPages: 50, maxRecords: 2000, maxScrollRounds: 15, delayMinMs: 1500, delayMaxMs: 3200, stopAfterEmptyPages: 2 } };
  return [
    { ...base, id: 'cfg_university_directory', name: 'People directory (auto-detect)', list: { auto: true, kind: 'people' } },
    { ...base, id: 'cfg_company_listing', name: 'Companies / any listing (auto-detect)', list: { auto: true, kind: 'items' } },
    // Google Maps: the result list in the open tab is scrolled to its end, every place is read, and each business's own website is checked for an e-mail
    { ...base, id: 'cfg_google_maps', name: 'Google Maps results (places)', list: { auto: true, kind: 'items' }, visitProfiles: true, renderJsProfiles: true,
      maps: { details: 'missing' as const, websiteEmails: true, queries: [] },
      pagination: { mode: 'infinite' as const, maxPages: 1, maxRecords: 400, maxScrollRounds: 40, delayMinMs: 1200, delayMaxMs: 2600, stopAfterEmptyPages: 2 } },
  ];
}
