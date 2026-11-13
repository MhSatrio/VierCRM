// Data-access layer: workspaces → databases → tables → fields / records / views, plus change notification for the automation engine.
import * as DB from './db';
import type { CellValue, ConditionGroup, Database, Field, FieldType, RecordMeta, RecordRow, ScrapedPerson, SortSpec, Table, View, Workspace } from './types';
import { buildFields, buildViews, CONTACTS_ID, COMPANIES_ID, defaultTemplates, DB_ID, exampleScrapeConfigs, fid, idOf, keyOf, researchAddOn, rulesFor, TABLE_ID, templateById, WORKSPACE_ID } from './defaults';
import { buildDedupeIndex, fillEmptyCells, type DedupeRule } from './dedupe';
import { cellText } from './values';

export const uid = (prefix: string) => `${prefix}_${(globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).replace(/-/g, '').slice(0, 16)}`;
export const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------------ change notification
export interface Change { kind: 'created' | 'updated' | 'deleted'; tableId: string; record: RecordRow; before?: RecordRow; origin?: RecordMeta['origin'] }
type Listener = (c: Change) => unknown;
const listeners = new Set<Listener>();
let remoteSink: ((c: Change) => void) | null = null;
/** Subscribe to every record change made through this module (the background service worker runs the automation engine here). */
export const onChange = (fn: Listener) => { listeners.add(fn); return () => listeners.delete(fn); };
/** Pages (side panel / app) forward their changes to the background worker, which owns the engine. */
export const setRemoteSink = (fn: ((c: Change) => void) | null) => { remoteSink = fn; };
let channel: BroadcastChannel | null = null;
const bc = () => (channel ??= typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('viercrm') : null);
export const onRemoteRefresh = (fn: (tableId: string, change?: { id: string; kind: Change['kind'] }) => void) => { const c = bc(); if (!c) return () => {}; const h = (e: MessageEvent) => { if (e.data?.type === 'changed') fn(e.data.tableId, e.data.id ? { id: e.data.id, kind: e.data.kind } : undefined); }; c.addEventListener('message', h); return () => c.removeEventListener('message', h); };
const slimChange = (c: Change): Change => ({ ...c });

async function emit(c: Change) {
  bc()?.postMessage({ type: 'changed', tableId: c.tableId, id: c.record.id, kind: c.kind });
  remoteSink?.(slimChange(c));
  for (const l of listeners) { try { await l(c); } catch (e) { console.warn('change listener failed', e); } }
}

// ------------------------------------------------------------------ seeding
const SCHEMA = 3;           // 3: the built-in "Google Maps results" configuration (migrate() is safe to run again)
async function seedBase(id: string, name: string, templateId: string, order: number): Promise<Table> {
  const tpl = templateById(templateId);
  const table: Table = { id, databaseId: DB_ID, name, order, template: tpl.id, autoResearch: tpl.autoResearch || undefined };
  await DB.put('tables', table); await DB.putMany('fields', buildFields(id, tpl.id)); await DB.putMany('views', buildViews(id, tpl.id)); await DB.kvSet(`dedupe:${id}`, rulesFor(id, tpl.id));
  return table;
}

/** Fresh install: three ready-made bases (Researchers, Contacts, Companies). Existing installs are migrated, never reset. */
export async function ensureSeeded(): Promise<void> {
  if (await DB.get('workspaces', WORKSPACE_ID)) { if (((await DB.kvGet<number>('schemaVersion', 1)) ?? 1) < SCHEMA) await migrate(); return; }
  await DB.put('workspaces', { id: WORKSPACE_ID, name: 'VierApparatus' } as Workspace);
  await DB.put('databases', { id: DB_ID, workspaceId: WORKSPACE_ID, name: 'VierApparatus', order: 0 } as Database);
  await seedBase(TABLE_ID, 'Researchers', 'researchers', 0); await seedBase(CONTACTS_ID, 'Contacts', 'contacts', 1); await seedBase(COMPANIES_ID, 'Companies', 'companies', 2);
  await DB.putMany('templates', defaultTemplates()); await DB.putMany('configs', exampleScrapeConfigs());
  await DB.kvSet('schemaVersion', SCHEMA);
}

/** v1 → v2: "Research Contacts" becomes the Researchers base (data and ids untouched), plus Contacts and Companies. */
async function migrate(): Promise<void> {
  const db = await DB.get<Database>('databases', DB_ID); if (db && db.name === 'Research Contacts') await DB.put('databases', { ...db, name: 'VierApparatus' });
  const t = await DB.get<Table>('tables', TABLE_ID);
  if (t) {
    await DB.put('tables', { ...t, name: t.name === 'Research Contacts' ? 'Researchers' : t.name, template: t.template ?? 'researchers', autoResearch: t.autoResearch ?? true });
    const fields = await listFields(TABLE_ID); await DB.putMany('fields', fields.filter(f => !f.key && f.id.startsWith('fld_') && !/^fld_[0-9a-f]{16}$/.test(f.id)).map(f => ({ ...f, key: f.id.slice(4) })));
  }
  const n = (await listTables()).length;
  if (!(await getTable(CONTACTS_ID))) await seedBase(CONTACTS_ID, 'Contacts', 'contacts', n);
  if (!(await getTable(COMPANIES_ID))) await seedBase(COMPANIES_ID, 'Companies', 'companies', n + 1);
  const have = new Set((await DB.all<{ id: string }>('templates')).map(x => x.id)); await DB.putMany('templates', defaultTemplates().filter(x => !have.has(x.id)));
  const cfgs = await DB.all<{ id: string; builtin?: boolean }>('configs'); const haveC = new Map(cfgs.map(c => [c.id, c]));
  for (const c of exampleScrapeConfigs()) if (!haveC.has(c.id) || haveC.get(c.id)!.builtin) await DB.put('configs', haveC.has(c.id) ? { ...(haveC.get(c.id) as object), name: c.name, list: c.list } : c);
  await DB.kvSet('schemaVersion', SCHEMA);
}

// ------------------------------------------------------------------ structure
export const listWorkspaces = () => DB.all<Workspace>('workspaces');
export const listDatabases = async () => (await DB.all<Database>('databases')).sort((a, b) => a.order - b.order);
export const listTables = async () => (await DB.all<Table>('tables')).sort((a, b) => a.order - b.order);
export const getTable = (id: string) => DB.get<Table>('tables', id);
export const listFields = async (tableId: string) => (await DB.byIndex<Field>('fields', 'tableId', tableId)).sort((a, b) => a.order - b.order);
export const listViews = async (tableId: string) => (await DB.byIndex<View>('views', 'tableId', tableId)).sort((a, b) => a.order - b.order);
export const listRecords = (tableId: string) => DB.byIndex<RecordRow>('records', 'tableId', tableId);
export const listRecordsHead = (tableId: string, n = 150) => DB.byIndexHead<RecordRow>('records', 'tableId', tableId, n);
export const getRecord = (id: string) => DB.get<RecordRow>('records', id);
export const countRecords = (tableId: string) => DB.countByIndex('records', 'tableId', tableId);

export async function createDatabase(name: string, workspaceId = WORKSPACE_ID): Promise<Database> {
  const d: Database = { id: uid('db'), workspaceId, name, order: (await listDatabases()).length };
  await DB.put('databases', d); return d;
}
export async function createTable(databaseId: string, name: string): Promise<Table> {
  const t: Table = { id: uid('tbl'), databaseId, name, order: (await listTables()).length, template: 'blank' };
  await DB.put('tables', t);
  await DB.put('fields', { id: uid('fld'), key: 'fullName', tableId: t.id, name: 'Name', type: 'text', order: 0, primary: true, width: 220 } as Field);
  await DB.put('views', { id: uid('view'), tableId: t.id, name: 'All records', filter: { kind: 'group', match: 'and', items: [] }, sort: [], hiddenFieldIds: [], order: 0 } as View);
  await DB.kvSet(`dedupe:${t.id}`, []);
  return t;
}
/** "+ Add base": a new table from a template (contacts, companies, researchers, blank). */
export async function createBase(name: string, templateId = 'blank'): Promise<Table> {
  const tpl = templateById(templateId); const id = uid('tbl');
  return seedBase(id, name.trim() || tpl.name, tpl.id, (await listTables()).length);
}
/** Research fields (latest publication, DOI, PDF …) for any base that has a name field. Returns the fields that were added. */
export async function addResearchFields(tableId: string): Promise<Field[]> {
  const existing = await listFields(tableId); const add = researchAddOn(tableId, existing);
  if (add.length) await DB.putMany('fields', add);
  const t = await getTable(tableId); if (t) await DB.put('tables', { ...t, autoResearch: true });
  const views = await listViews(tableId); const fields = [...existing, ...add];
  const want = buildViews(tableId, 'researchers').filter(v => /^(Missing Publication|Publication Found|PDF Available)$/.test(v.name) && !views.some(x => x.name === v.name));
  const usable = (v: View) => (JSON.stringify(v.filter).match(/"fieldId":"([^"]+)"/g) ?? []).every(m => fields.some(f => m.includes('"' + f.id + '"')));
  await DB.putMany('views', want.filter(usable).map((v, i) => ({ ...v, order: views.length + i })));
  return add;
}
export const setAutoResearch = async (id: string, on: boolean) => { const t = await getTable(id); if (t) await DB.put('tables', { ...t, autoResearch: on }); };
export const renameTable = async (id: string, name: string) => { const t = await getTable(id); if (t) await DB.put('tables', { ...t, name }); };
export async function deleteTable(id: string) {
  const [recs, fields, views, autos] = await Promise.all([listRecords(id), listFields(id), listViews(id), DB.byIndex<{ id: string }>('automations', 'tableId', id)]);
  await DB.delMany('records', recs.map(r => r.id)); await DB.delMany('fields', fields.map(f => f.id)); await DB.delMany('views', views.map(v => v.id)); await DB.delMany('automations', autos.map(a => a.id));
  await DB.del('tables', id);
}

export async function addField(tableId: string, spec: Partial<Field> & { name: string; type: FieldType }): Promise<Field> {
  const fields = await listFields(tableId);
  const f: Field = { id: uid('fld'), tableId, order: fields.length, width: 180, ...spec } as Field;
  await DB.put('fields', f); return f;
}
export const updateField = async (id: string, patch: Partial<Field>) => { const f = await DB.get<Field>('fields', id); if (!f) throw new Error('Field not found'); const next = { ...f, ...patch, id: f.id, tableId: f.tableId }; await DB.put('fields', next); return next; };
export async function deleteField(id: string) {
  const f = await DB.get<Field>('fields', id); if (!f) return;
  if (f.primary) throw new Error('The primary field cannot be deleted.');
  const recs = await listRecords(f.tableId);
  await DB.putMany('records', recs.filter(r => id in r.cells).map(r => { const cells = { ...r.cells }; delete cells[id]; return { ...r, cells }; }));
  await DB.del('fields', id);
}
export async function reorderFields(tableId: string, orderedIds: string[]) {
  const fields = await listFields(tableId); const pos = new Map(orderedIds.map((id, i) => [id, i]));
  await DB.putMany('fields', fields.map(f => ({ ...f, order: pos.get(f.id) ?? f.order })));
}

export async function saveView(v: View) { await DB.put('views', v); return v; }
export async function createView(tableId: string, name: string, filter?: ConditionGroup, sort: SortSpec[] = []): Promise<View> {
  const views = await listViews(tableId);
  const v: View = { id: uid('view'), tableId, name, filter: filter ?? { kind: 'group', match: 'and', items: [] }, sort, hiddenFieldIds: [], order: views.length };
  await DB.put('views', v); return v;
}
export const deleteView = (id: string) => DB.del('views', id);

export async function getDedupeRules(tableId: string): Promise<DedupeRule[]> { return (await DB.kvGet<DedupeRule[]>(`dedupe:${tableId}`, [])) ?? []; }
export const saveDedupeRules = (tableId: string, rules: DedupeRule[]) => DB.kvSet(`dedupe:${tableId}`, rules);

// ------------------------------------------------------------------ records
interface WriteOpts { origin?: RecordMeta['origin']; silent?: boolean }

export async function createRecord(tableId: string, cells: Record<string, CellValue> = {}, opts: WriteOpts & { sourceUrl?: string; meta?: RecordMeta } = {}): Promise<RecordRow> {
  const t = nowIso();
  const rec: RecordRow = { id: uid('rec'), tableId, cells: { ...cells }, createdAt: t, updatedAt: t, sourceUrl: opts.sourceUrl, meta: { ...(opts.meta || {}), ...(opts.origin ? { origin: opts.origin } : {}) } };
  await DB.put('records', rec);
  if (!opts.silent) await emit({ kind: 'created', tableId, record: rec, origin: opts.origin });
  return rec;
}

export async function updateRecord(id: string, cells: Record<string, CellValue>, opts: WriteOpts & { meta?: Partial<RecordMeta> } = {}): Promise<RecordRow> {
  const before = await getRecord(id); if (!before) throw new Error('Record not found');
  const meta: RecordMeta = { ...(before.meta || {}), ...(opts.meta || {}) };
  if (opts.origin) meta.origin = opts.origin; else delete meta.origin;
  const rec: RecordRow = { ...before, cells: { ...before.cells, ...cells }, meta, updatedAt: nowIso() };
  for (const k of Object.keys(cells)) if (cells[k] === undefined) delete rec.cells[k];
  await DB.put('records', rec);
  if (!opts.silent) await emit({ kind: 'updated', tableId: rec.tableId, record: rec, before, origin: opts.origin });
  return rec;
}

export async function deleteRecords(ids: string[]) {
  for (const id of ids) { const r = await getRecord(id); if (!r) continue; await DB.del('records', id); await emit({ kind: 'deleted', tableId: r.tableId, record: r }); }
}

// ------------------------------------------------------------------ scraping intake
const TITLES = /^(prof(essor)?\.?|dr\.?|drs?\.?|ir\.?|mr\.?|mrs\.?|ms\.?|assoc\.?|assistant|associate|emeritus|dipl\.?|ing\.?|phd|msc|m\.sc\.?)\s+/i;
export function splitName(full: string): { first: string; last: string } {
  let s = full.replace(/\(.*?\)/g, ' ').replace(/,.*$/, m => (/^,\s*(ph\.?d|md|msc|dr|prof)/i.test(m) ? '' : m)).trim();
  for (let i = 0; i < 4 && TITLES.test(s); i++) s = s.replace(TITLES, '');
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: '', last: parts[0] || '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export interface IntakeResult { action: 'created' | 'merged' | 'duplicate' | 'skipped'; record?: RecordRow; reason?: string }

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const LABEL_ALIASES: Record<string, string[]> = { email: ['e-mail', 'mail', 'email address'], phone: ['telephone', 'tel', 'phone number', 'mobile'], website: ['web', 'homepage', 'url', 'site'], position: ['title', 'job title', 'role'], institution: ['company', 'organisation', 'organization', 'university', 'employer', 'affiliation'], country: ['nation'], location: ['address', 'city', 'headquarters'], industry: ['sector', 'category'], size: ['employees', 'company size', 'headcount'] };

/** Save one scraped record into a base. Values keyed by a field id are used as is; values keyed fld_<key> go to whichever field of THIS base has that key;
 *  every "Label: value" pair on the page fills the field with the same name (so a field added by the user needs no configuration). */
export async function intakePerson(tableId: string, fields: Field[], person: ScrapedPerson, index: ReturnType<typeof buildDedupeIndex>, opts: { configId?: string } = {}): Promise<IntakeResult> {
  const cells: Record<string, CellValue> = {};
  const byId = new Set(fields.map(f => f.id)); const K = (key: string) => idOf(fields, key);
  for (const [k, v] of Object.entries(person.values)) {
    const val = (v ?? '').trim(); if (val === '') continue;
    if (byId.has(k)) cells[k] = val;
    else if (k.startsWith('fld_')) { const id = K(k.slice(4)); if (id && !cells[id]) cells[id] = val; }
  }
  if (person.pairs?.length) {
    const byName = new Map<string, Field>();
    for (const f of fields) { if (f.type === 'attachment' || f.type === 'formula' || f.type === 'createdTime' || f.type === 'lastModified') continue; byName.set(norm(f.name), f); }
    for (const f of fields) for (const al of LABEL_ALIASES[keyOf(f)] ?? []) if (!byName.has(norm(al))) byName.set(norm(al), f);
    for (const [label, value] of person.pairs) { const f = byName.get(norm(label)); const val = (value ?? '').trim(); if (f && val && !cells[f.id] && val.length < 600) cells[f.id] = f.type === 'email' ? val.toLowerCase() : val; }
  }
  if (!Object.keys(cells).length) return { action: 'skipped', reason: 'nothing readable on the page' };
  const name = K('fullName'), first = K('firstName'), last = K('lastName'), email = K('email'), prof = K('profileUrl'), src = K('sourceUrl'), date = K('scrapingDate'), status = K('scrapingStatus'), outreach = K('outreachStatus');
  if (name && cells[name] && (first || last)) {
    const sp = splitName(String(cells[name]));
    if (first && !cells[first] && sp.first) cells[first] = sp.first;
    if (last && !cells[last] && sp.last) cells[last] = sp.last;
  }
  if (email && cells[email]) cells[email] = String(cells[email]).toLowerCase();
  if (prof && !cells[prof] && person.profileUrl) cells[prof] = person.profileUrl;
  if (src) cells[src] = person.sourceUrl;
  if (date) cells[date] = nowIso().slice(0, 10);
  if (status) cells[status] = person.status === 'ok' ? 'Scraped' : person.status === 'partial' ? 'Partial' : 'Failed';
  const meta: RecordMeta = { scrape: { configId: opts.configId, at: nowIso(), fieldsFound: person.fieldsFound, status: person.status, error: person.error, publicationLinks: person.publicationLinks, identifiers: person.identifiers } };

  const hit = index.find(cells);
  if (hit) {
    const { cells: merged, changed } = fillEmptyCells(hit.record.cells, cells, fields);
    // a failed re-scrape must not downgrade a good record's status
    if (status && hit.record.cells[status] === 'Scraped' && person.status !== 'ok') merged[status] = 'Scraped';
    if (!changed.length) return { action: 'duplicate', record: hit.record, reason: hit.rule.name };
    const rec = await updateRecord(hit.record.id, merged, { meta });
    index.add(rec);
    return { action: 'merged', record: rec, reason: hit.rule.name };
  }
  if (outreach) cells[outreach] = 'Not Contacted';
  const rec = await createRecord(tableId, cells, { sourceUrl: person.sourceUrl, meta });
  index.add(rec);
  return { action: 'created', record: rec };
}

/** Plain text of a record (for logs and previews). */
export const recordLabel = (fields: Field[], rec: RecordRow) => { const p = fields.find(f => f.primary) ?? fields[0]; return (p && cellText(rec.cells[p.id])) || '(untitled)'; };

export async function loadSampleData(tableId = TABLE_ID): Promise<number> {
  const { SAMPLE_RESEARCHERS } = await import('./sample');
  const fields = await listFields(tableId); const rules = await getDedupeRules(tableId);
  const index = buildDedupeIndex(await listRecords(tableId), rules); let n = 0;
  for (const p of SAMPLE_RESEARCHERS) {
    const r = await intakePerson(tableId, fields, { sourceUrl: 'sample://fixture', profileUrl: p[fid('profileUrl')] || '', values: p, fieldsFound: Object.keys(p), status: 'ok' }, index);
    if (r.action === 'created') n++;
  }
  return n;
}
