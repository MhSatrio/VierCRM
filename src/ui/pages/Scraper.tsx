import React, { useEffect, useMemo, useState } from 'react';
import * as DB from '../../core/db';
import * as S from '../../core/store';
import type { Field, FieldMapping, ScrapeConfig, ScrapeProgress } from '../../core/types';
import { templateById } from '../../core/defaults';
import { ensureHostAccess, Field_, onRuntime, send, useAsync, useBase, useBases, useToast } from '../bridge';
import { AddBaseModal } from '../components/AddBase';
import { isMapsUrl } from '../../scrape/maps';

const num = (v: string, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

function Mapping({ m, fields, onChange, onRemove, onPick, picking }: { m: FieldMapping; fields: Field[]; onChange(m: FieldMapping): void; onRemove(): void; onPick(): void; picking: boolean }) {
  return (
    <div className="rule">
      <select aria-label="Target field" value={m.fieldId} onChange={e => onChange({ ...m, fieldId: e.target.value })}>{fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
      <select aria-label="Read from" value={m.from} onChange={e => onChange({ ...m, from: e.target.value as 'card' | 'profile' })}><option value="profile">profile page</option><option value="card">directory card</option></select>
      <input type="text" aria-label="CSS selector or xpath:" className="grow" placeholder="CSS selector, or xpath://h1" value={m.selector} onChange={e => onChange({ ...m, selector: e.target.value })} />
      <button className="sm" onClick={onPick} title="Click an element on the page">{picking ? 'Click it on the page…' : '⌖ Pick'}</button>
      <select aria-label="Extract" value={m.extract} onChange={e => onChange({ ...m, extract: e.target.value as FieldMapping['extract'] })}><option value="text">text</option><option value="href">link (href)</option><option value="attr">attribute</option><option value="email">e-mail</option><option value="phone">phone</option><option value="html">text with line breaks</option></select>
      {m.extract === 'attr' && <input type="text" aria-label="Attribute" size={8} placeholder="attribute" value={m.attr ?? ''} onChange={e => onChange({ ...m, attr: e.target.value })} />}
      <label className="chk small"><input type="checkbox" checked={!!m.multiple} onChange={e => onChange({ ...m, multiple: e.target.checked })} />all matches</label>
      <input type="text" aria-label="Regex (optional)" size={10} placeholder="regex (opt.)" value={m.regex ?? ''} onChange={e => onChange({ ...m, regex: e.target.value || undefined })} />
      <button className="ghost sm" aria-label="Remove mapping" onClick={onRemove}>✕</button>
    </div>
  );
}

export function ConfigEditor({ cfg, setCfg, fields, tabId }: { cfg: ScrapeConfig; setCfg(c: ScrapeConfig): void; fields: Field[]; tabId?: number }) {
  const toast = useToast(); const [picking, setPicking] = useState<string | null>(null); const [last, setLast] = useState<any>(null);
  const writable = fields.filter(f => !['formula', 'createdTime', 'lastModified', 'attachment'].includes(f.type));
  useEffect(() => onRuntime<{ result: any }>('picker:picked', m => { setLast(m.result); setPicking(cur => { if (cur === 'card') setCfg({ ...cfg, list: { ...cfg.list, auto: false, cardSelector: m.result.generic } }); else if (cur === 'link') setCfg({ ...cfg, list: { ...cfg.list, auto: false, linkSelector: m.result.selector.replace(/^.* > /, '') } }); else if (cur === 'next') setCfg({ ...cfg, pagination: { ...cfg.pagination, mode: 'next', nextSelector: m.result.selector } }); else if (cur === 'more') setCfg({ ...cfg, pagination: { ...cfg.pagination, mode: 'loadMore', loadMoreSelector: m.result.selector } }); else if (cur?.startsWith('map:')) { const i = Number(cur.slice(4)); setCfg({ ...cfg, mappings: cfg.mappings.map((x, j) => (j === i ? { ...x, selector: m.result.genericMatches > 1 && x.multiple ? m.result.generic : m.result.selector, extract: m.result.tag === 'a' && x.extract === 'text' && /mail/i.test(fields.find(f => f.id === x.fieldId)?.name || '') ? 'email' : x.extract } : x)) }); } return null; }); }), [cfg, fields, setCfg]);
  const pick = async (what: string) => { if (!tabId) return toast('Open the website in a normal tab first.', 'bad'); try { await ensureHostAccess(); setPicking(what); await send({ type: 'picker:start', tabId }); } catch (e: any) { setPicking(null); toast(e.message, 'bad'); } };
  const pg = cfg.pagination; const setPg = (p: Partial<typeof pg>) => setCfg({ ...cfg, pagination: { ...pg, ...p } });
  const maps = cfg.maps;
  const defaults = Object.entries(cfg.defaults || {});
  return (
    <div className="col">
      {maps && <div className="card col"><h3>Google Maps results</h3>
        <div className="muted small">Open a Google Maps search (for example “freight forwarder Surabaya” or “kos putri Malang”) in a normal tab and wait until the places are listed. VierCRM scrolls the list to its end, reads every place and looks for contact details. It reads the page you are looking at – no Google API and no key.</div>
        <Field_ label="Open a place’s own page (full address, phone, opening hours, plus code)"><select value={maps.details} onChange={e => setCfg({ ...cfg, maps: { ...maps, details: e.target.value as typeof maps.details } })}>
          <option value="missing">Only when the list card shows no phone number or no address (recommended)</option><option value="always">Always (slowest, most complete)</option><option value="never">Never – the list cards only (fastest)</option></select></Field_>
        <label className="chk"><input type="checkbox" checked={maps.websiteEmails} onChange={e => setCfg({ ...cfg, maps: { ...maps, websiteEmails: e.target.checked } })} />Visit each business’s own website (and its contact page) to find an e-mail address, WhatsApp number and social links – Google Maps itself never shows an e-mail</label>
        <Field_ label="More searches after this one (optional – one per line)"><textarea rows={4} placeholder={'freight forwarder Semarang\nfreight forwarder Jakarta Utara'} value={(maps.queries || []).join('\n')} onChange={e => setCfg({ ...cfg, maps: { ...maps, queries: e.target.value.split('\n') } })} /></Field_>
        <div className="note">Google Maps lists at most about 120 places per search. For a larger area add searches – the same words with a city or district. A place found twice is saved once. Keep the delays polite: VierCRM stops at a consent page, a sign-in or a CAPTCHA and never tries to get past one.</div>
      </div>}
      {!maps && <>
      <div className="card col"><h3>1 · What is on the page?</h3>
        <div className="row"><label className="chk"><input type="radio" name="kind" checked={cfg.list.kind !== 'items'} onChange={() => setCfg({ ...cfg, list: { ...cfg.list, kind: 'people' } })} />People (staff, researchers, speakers …)</label>
          <label className="chk"><input type="radio" name="kind" checked={cfg.list.kind === 'items'} onChange={() => setCfg({ ...cfg, list: { ...cfg.list, kind: 'items' } })} />Companies, products or any other list</label></div>
        <label className="chk"><input type="checkbox" checked={cfg.list.auto} onChange={e => setCfg({ ...cfg, list: { ...cfg.list, auto: e.target.checked } })} />Detect automatically (finds repeated entries with a link – for people the text must look like a name; for “any other list” every repeated entry counts)</label>
        {!cfg.list.auto && <div className="grid2"><Field_ label="Card selector (one per entry)"><span className="row"><input className="grow" type="text" value={cfg.list.cardSelector ?? ''} onChange={e => setCfg({ ...cfg, list: { ...cfg.list, cardSelector: e.target.value } })} /><button className="sm" onClick={() => pick('card')}>{picking === 'card' ? '…' : '⌖ Pick'}</button></span></Field_>
          <Field_ label="Detail-page link inside the card (optional)"><span className="row"><input className="grow" type="text" placeholder="a" value={cfg.list.linkSelector ?? ''} onChange={e => setCfg({ ...cfg, list: { ...cfg.list, linkSelector: e.target.value } })} /><button className="sm" onClick={() => pick('link')}>{picking === 'link' ? '…' : '⌖ Pick'}</button></span></Field_></div>}
        {last && <div className="muted small">Last picked: <code>{last.selector}</code> ({last.matches} match{last.matches === 1 ? '' : 'es'}; similar elements: <code>{last.generic}</code> × {last.genericMatches}) — “{last.sample}”</div>}
      </div>
      <div className="card col"><h3>2 · What to read</h3>
        <div className="muted small">Everything that has the same meaning as a field of the chosen base is filled automatically (name, e-mail, phone, website, position, company …). A “Label: value” pair on the page also fills a field with the same <b>name</b> – so a field you add (e.g. “Industry” or “Revenue”) is filled without any set-up.</div>
        <div className="row small">{(['name', 'position', 'institution', 'email', 'phone', 'biography'] as const).filter(k => cfg.list.kind !== 'items' || !['position', 'institution'].includes(k)).map(k => <label key={k} className="chk"><input type="checkbox" checked={cfg.autoDetect[k]} onChange={e => setCfg({ ...cfg, autoDetect: { ...cfg.autoDetect, [k]: e.target.checked } })} />auto-detect {k}</label>)}</div>
        <div className="muted small">Your own mappings below always win over auto-detection. Anything not found stays empty – nothing is guessed.</div>
        {cfg.mappings.map((m, i) => <Mapping key={i} m={m} fields={writable} picking={picking === `map:${i}`} onPick={() => pick(`map:${i}`)} onChange={nm => setCfg({ ...cfg, mappings: cfg.mappings.map((x, j) => (j === i ? nm : x)) })} onRemove={() => setCfg({ ...cfg, mappings: cfg.mappings.filter((_, j) => j !== i) })} />)}
        <div><button className="sm" onClick={() => setCfg({ ...cfg, mappings: [...cfg.mappings, { fieldId: writable.find(f => f.primary)?.id ?? writable[0]?.id ?? '', selector: '', extract: 'text', from: 'profile' }] })}>+ Map an element to a field</button></div>
        <div className="muted small" style={{ marginTop: 4 }}>Constant values for this site (e.g. the company or country, when the page does not say):</div>
        {defaults.map(([k, v], i) => <div className="rule" key={i}><select value={k} onChange={e => { const d = { ...cfg.defaults }; delete d[k]; d[e.target.value] = v; setCfg({ ...cfg, defaults: d }); }}>{writable.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select><input type="text" value={v} onChange={e => setCfg({ ...cfg, defaults: { ...cfg.defaults, [k]: e.target.value } })} /><button className="ghost sm" onClick={() => { const d = { ...cfg.defaults }; delete d[k]; setCfg({ ...cfg, defaults: d }); }}>✕</button></div>)}
        <div><button className="sm" disabled={!writable.length} onClick={() => setCfg({ ...cfg, defaults: { ...cfg.defaults, [(writable.find(f => ['institution', 'country', 'industry'].includes(f.key ?? '')) ?? writable[1] ?? writable[0]).id]: '' } })}>+ Constant value</button></div>
      </div>
      <div className="card col"><h3>3 · Detail pages</h3>
        <label className="chk"><input type="checkbox" checked={cfg.visitProfiles} onChange={e => setCfg({ ...cfg, visitProfiles: e.target.checked })} />Open each entry’s own page and read it (otherwise only the list card is read)</label>
        <label className="chk"><input type="checkbox" checked={cfg.renderJsProfiles} onChange={e => setCfg({ ...cfg, renderJsProfiles: e.target.checked })} />If a detail page only appears after JavaScript runs (or lives on another domain), open it in a background tab and read it there</label>
        <label className="chk"><input type="checkbox" checked={cfg.returnToDirectory} onChange={e => setCfg({ ...cfg, returnToDirectory: e.target.checked })} />Keep the list page where it is (detail pages are read in the background, so the list never loses its place)</label>
      </div>
      </>}
      <div className="card col"><h3>{maps ? 'Limits and pace' : '4 · Pagination and limits'}</h3>
        {!maps && <>
        <label className="chk"><input type="checkbox" checked={pg.startFromFirst !== false} onChange={e => setPg({ startFromFirst: e.target.checked })} />Start from the first page – if the tab is on a later page of the list, open the first page before reading (a scrape only moves forward)</label>
        <div className="grid2"><Field_ label="How does the list continue?"><select value={pg.mode} onChange={e => setPg({ mode: e.target.value as typeof pg.mode })}><option value="auto">Detect automatically</option><option value="next">“Next” link or button</option><option value="numbered">Numbered pages</option><option value="url">URL pattern with {'{page}'} (any page number: the page you are on is read from the address)</option><option value="loadMore">“Load more” button</option><option value="infinite">Infinite scrolling</option><option value="none">Single page only</option></select></Field_>
          {pg.mode === 'next' && <Field_ label="Next link / button selector (optional)"><span className="row"><input className="grow" type="text" value={pg.nextSelector ?? ''} onChange={e => setPg({ nextSelector: e.target.value || undefined })} /><button className="sm" onClick={() => pick('next')}>{picking === 'next' ? '…' : '⌖ Pick'}</button></span></Field_>}
          {pg.mode === 'loadMore' && <Field_ label="Load-more button selector (optional)"><span className="row"><input className="grow" type="text" value={pg.loadMoreSelector ?? ''} onChange={e => setPg({ loadMoreSelector: e.target.value || undefined })} /><button className="sm" onClick={() => pick('more')}>{picking === 'more' ? '…' : '⌖ Pick'}</button></span></Field_>}
          {pg.mode === 'url' && <><Field_ label="URL pattern"><input type="text" placeholder="https://site.edu/people?page={page}" value={pg.urlTemplate ?? ''} onChange={e => setPg({ urlTemplate: e.target.value })} /></Field_><Field_ label="First page number"><input type="number" value={pg.startPage ?? 1} onChange={e => setPg({ startPage: num(e.target.value, 1) })} /></Field_></>}</div>
        </>}
        <div className="grid4">{!maps && <Field_ label="Max pages"><input type="number" min={1} value={pg.maxPages} onChange={e => setPg({ maxPages: Math.max(1, num(e.target.value, 50)) })} /></Field_>}<Field_ label={maps ? 'Max places (all searches together)' : 'Max records'}><input type="number" min={1} value={pg.maxRecords} onChange={e => setPg({ maxRecords: Math.max(1, num(e.target.value, 2000)) })} /></Field_><Field_ label="Max scroll / load-more rounds"><input type="number" min={1} value={pg.maxScrollRounds} onChange={e => setPg({ maxScrollRounds: Math.max(1, num(e.target.value, 15)) })} /></Field_><Field_ label="Stop after N pages with nobody new"><input type="number" min={1} value={pg.stopAfterEmptyPages} onChange={e => setPg({ stopAfterEmptyPages: Math.max(1, num(e.target.value, 2)) })} /></Field_>
          <Field_ label={maps ? 'Delay between places – min (ms)' : 'Delay between profiles – min (ms)'}><input type="number" min={0} value={pg.delayMinMs} onChange={e => setPg({ delayMinMs: num(e.target.value, 1500) })} /></Field_><Field_ label="… max (ms)"><input type="number" min={0} value={pg.delayMaxMs} onChange={e => setPg({ delayMaxMs: Math.max(pg.delayMinMs, num(e.target.value, 3200)) })} /></Field_></div>
        <div className="note">Only scrape sites whose terms allow it, keep the delays polite, and expect VierCRM to stop at a CAPTCHA or login wall – it never tries to get past one.</div>
      </div>
    </div>
  );
}

export function Scraper({ compact }: { compact?: boolean }) {
  const toast = useToast();
  const { tables, counts } = useBases(); const { data: cfgs, reload: reloadCfgs } = useAsync(() => DB.all<ScrapeConfig>('configs'), []);
  const [tableId, pickBase] = useBase('scrape', tables); const { data: fields } = useAsync(() => (tableId ? S.listFields(tableId) : Promise.resolve([])), [tableId]); const [newBase, setNewBase] = useState<string | false>(false);
  const base = tables.find(t => t.id === tableId);
  const [cfgId, setCfgId] = useState('cfg_university_directory'); const [cfg, setCfgState] = useState<ScrapeConfig>(); const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<chrome.tabs.Tab>(); const [preview, setPreview] = useState<any>(null); const [progress, setProgress] = useState<ScrapeProgress | null>(null); const [edit, setEdit] = useState(!compact);

  const readTab = async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); setTab(t && !t.url?.startsWith('chrome-extension://') ? t : tab); };
  useEffect(() => { void readTab(); const a = () => void readTab(); chrome.tabs.onActivated.addListener(a); chrome.tabs.onUpdated.addListener(a); return () => { chrome.tabs.onActivated.removeListener(a); chrome.tabs.onUpdated.removeListener(a); }; /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (cfgs && !cfg) { const c = cfgs.find(x => x.id === cfgId) ?? cfgs[0]; if (c) { setCfgState(structuredClone(c)); setCfgId(c.id); } } }, [cfgs, cfg, cfgId]);
  useEffect(() => { void send<any>({ type: 'scrape:status' }).then(r => r?.progress && setProgress(r.progress)).catch(() => {}); return onRuntime<{ progress: ScrapeProgress }>('scrape:progress', m => setProgress(m.progress)); }, []);

  // a Google Maps tab: the built-in "Google Maps results" configuration takes over from the people / company ones
  const isMaps = isMapsUrl(tab?.url || '');
  useEffect(() => { if (isMaps && cfg && cfg.builtin && !cfg.maps && cfgs) { const w = cfgs.find(x => x.id === 'cfg_google_maps'); if (w) { setCfgId(w.id); setCfgState(structuredClone(w)); setDirty(false); setPreview(null); } } }, [isMaps, cfg, cfgs]);
  const setCfg = (c: ScrapeConfig) => { setCfgState(c); setDirty(true); };
  // choosing another base: the field-specific parts of the configuration no longer apply; the built-in list type follows the base (companies → "any list")
  const chooseBase = (id: string) => { pickBase(id); const t = tables.find(x => x.id === id); setCfgState(c => { if (!c) return c; const next = { ...c, mappings: [], defaults: {} }; if (c.builtin && cfgs) { const want = t?.template === 'places' ? 'cfg_google_maps' : t?.template === 'companies' || t?.template === 'blank' ? 'cfg_company_listing' : 'cfg_university_directory'; const w = cfgs.find(x => x.id === want); if (w) { setCfgId(w.id); return structuredClone(w); } } return next; }); setPreview(null); };
  const choose = (id: string) => { const c = cfgs?.find(x => x.id === id); if (c) { setCfgId(id); setCfgState(structuredClone(c)); setDirty(false); setPreview(null); } };
  const save = async () => { if (!cfg) return; const c = { ...cfg, targetTableId: tableId }; await DB.put('configs', c); setDirty(false); await reloadCfgs(); toast('Configuration saved', 'good'); };
  const saveAs = async () => { if (!cfg) return; const name = prompt('Name for this configuration (e.g. the website)', cfg.builtin ? '' : cfg.name); if (!name) return; const c: ScrapeConfig = { ...structuredClone(cfg), id: S.uid('cfg'), name, builtin: false, createdAt: new Date().toISOString(), targetTableId: tableId }; await DB.put('configs', c); await reloadCfgs(); setCfgId(c.id); setCfgState(c); setDirty(false); toast('Saved as a new configuration', 'good'); };
  const remove = async () => { if (!cfg || cfg.builtin) return; if (!confirm(`Delete the configuration “${cfg.name}”?`)) return; await DB.del('configs', cfg.id); setCfgState(undefined); setCfgId('cfg_university_directory'); await reloadCfgs(); };
  const kindLabel = cfg?.list.kind === 'items' ? 'entries' : 'people';

  const scrapable = !!tab?.id && /^https?:/.test(tab.url || '');
  const doPreview = async () => { if (!cfg || !tab?.id) return; try { if (!(await ensureHostAccess())) return toast('VierCRM needs permission to read this website.', 'bad'); setPreview(await send({ type: 'scrape:preview', tabId: tab.id, config: cfg })); } catch (e: any) { toast(e.message, 'bad'); } };
  const start = async () => { if (!cfg || !tab?.id) return; try { if (!(await ensureHostAccess())) return toast('VierCRM needs permission to read the sites you scrape. You can revoke it any time in chrome://extensions.', 'bad'); setCfgState({ ...cfg, targetTableId: tableId }); await send({ type: 'scrape:start', tabId: tab.id, config: { ...cfg, targetTableId: tableId }, tableId }); toast('Scraping started – you can keep working; use the floating control on the page to pause or stop.', 'good'); } catch (e: any) { toast(e.message, 'bad'); } };
  const running = !!progress?.running;

  return (
    <div className="col">
      <div className="card col" style={{ borderColor: 'var(--blue)', borderWidth: 2 }}>
        <div className="row"><h3 style={{ margin: 0 }}>Save to base</h3><span className="muted small">where the scraped records are stored</span></div>
        <div className="row"><select aria-label="Save scraped records to" className="grow" style={{ fontWeight: 600 }} value={tableId} onChange={e => (e.target.value === '__new' ? setNewBase(isMaps ? 'places' : 'companies') : chooseBase(e.target.value))}>{tables.map(t => <option key={t.id} value={t.id}>{t.name} ({(counts[t.id] ?? 0).toLocaleString()} records)</option>)}<option value="__new">＋ New base…</option></select><button className="sm" onClick={() => setNewBase(isMaps ? 'places' : 'companies')}>＋ New base</button></div>
        {base && <div className="muted small">{templateById(base.template).description} Records that already exist in “{base.name}” (same e-mail, website or profile link …) are merged, never duplicated.</div>}
      </div>
      <div className="card col">
        <div className="row"><b>Current website</b>{tab ? <span className="chip">{tab.title?.slice(0, 40) || 'Untitled'}</span> : <span className="muted">no tab</span>}<button className="sm right" onClick={readTab}>↻</button></div>
        <div className="small muted" style={{ wordBreak: 'break-all' }}>{tab?.url || 'Open a list page (a staff directory, a company listing, search results …) in a normal tab, then come back here.'}</div>
        {tab && !scrapable && <div className="note warn">This kind of page (browser or extension page) cannot be scraped.</div>}
        {isMaps && <div className="note good small"><b>Google Maps search detected.</b> VierCRM will scroll the list to its end, read every place and look for an e-mail on each business’s website.{base?.template !== 'places' && <> A <b>Places</b> base also keeps the category, rating, opening hours and Maps link. <button className="sm" onClick={() => setNewBase('places')}>＋ New Places base</button></>}</div>}
        <Field_ label="Scraping configuration (what kind of list this is, and how to read it)"><select value={cfgId} onChange={e => choose(e.target.value)}>{(cfgs || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field_>
        <div className="row"><button onClick={doPreview} disabled={!scrapable || running || !tableId}>👁 Preview what will be found</button>
          {!running ? <button className="primary" onClick={start} disabled={!scrapable || !cfg || !tableId}>▶ Start → {base?.name ?? '…'}</button> : <>{progress?.paused ? <button className="primary" onClick={() => send({ type: 'scrape:resume' })}>▶ Resume</button> : <button onClick={() => send({ type: 'scrape:pause' })}>⏸ Pause</button>}<button className="danger" onClick={() => send({ type: 'scrape:stop' })}>⏹ Stop</button></>}
          <button className="sm right" onClick={() => setEdit(!edit)}>{edit ? 'Hide' : 'Edit'} configuration</button></div>
      </div>
      {progress && <div className="card col" aria-live="polite"><div className="row"><b>{running ? (progress.paused ? 'Paused' : 'Scraping…') : 'Last run'}</b><span className="muted small">{progress.phase}{progress.stopReason ? ` · ${progress.stopReason}` : ''}</span></div>
        <div className="bar"><i style={{ width: running ? `${Math.min(95, 8 + progress.page * 7)}%` : '100%' }} /></div>
        <div className="row small"><span className="chip">page {progress.page}</span><span className="chip">{progress.found} read</span><span className="chip good">{progress.saved} new</span><span className="chip warn">{progress.skipped} skipped / duplicates</span><span className={`chip ${progress.errors.length ? 'bad' : ''}`}>{progress.errors.length} errors</span></div>
        {progress.errors.length > 0 && <details><summary className="small">Show errors</summary>{progress.errors.slice(-20).map((e, i) => <div key={i} className="small">{e}</div>)}</details>}</div>}
      {preview?.maps && <div className="card col"><div><b>{preview.count} places loaded so far</b> <span className="muted small">for “{preview.query || preview.title}” – the list keeps growing while VierCRM scrolls it</span></div>
        <div className="row small"><span className="chip">{preview.withPhone} with phone</span><span className="chip">{preview.withAddress} with address</span><span className="chip">{preview.withWebsite} with website</span></div>
        {preview.count === 0 && <div className="note warn">No places were found. Wait until Google Maps has listed the results in the left-hand panel (a consent page, sign-in or CAPTCHA also blocks the read), then press Preview again.</div>}
        <table className="t"><thead><tr><th>Name</th><th>Category · rating</th><th>Address</th><th>Phone</th><th>Website</th></tr></thead><tbody>{preview.sample.map((p: any, i: number) => <tr key={i}><td>{p.name}</td><td className="small">{p.position || '—'}</td><td className="small">{p.department || '—'}</td><td className="small">{p.phone || '—'}</td><td className="small" style={{ wordBreak: 'break-all' }}>{p.website ? p.website.replace(/^https?:\/\/(www\.)?/, '') : '—'}</td></tr>)}</tbody></table></div>}
      {preview && !preview.maps && <div className="card"><b>{preview.count} {kindLabel} detected</b> <span className="muted small">on “{preview.title}”</span>{preview.first && <div className="note warn small"><b>This is not the first page of the list.</b> A scrape only moves forward; with “Start from the first page” (Edit configuration → Pagination, on by default) VierCRM opens <code style={{ wordBreak: 'break-all' }}>{preview.first}</code> first.</div>}{preview.next && (preview.next.url ? <div className="note good small">Next page: <code style={{ wordBreak: 'break-all' }}>{preview.next.url}</code> – found by {preview.next.how}.</div> : /^last page/.test(preview.next.how) ? <div className="note small">This looks like the last page ({preview.next.how}).</div> : <div className="note warn small"><b>No next page found.</b> {preview.next.pagerSeen ? 'A pager is on the page but VierCRM could not follow it' : 'No pager was found on this page'} – looked at: {(preview.next.evidence || []).join('; ')}. If the list has more pages, set “How does the list continue?” in Edit configuration → Pagination (or pick the Next button with ⌖).</div>)}{preview.count === 0 && <div className="note warn">Nothing was detected. Scroll the list into view, wait for it to finish loading, or switch to manual selectors (Edit configuration → pick a card).</div>}
        <table className="t"><thead><tr><th>Name</th><th>Detail</th><th>More</th></tr></thead><tbody>{preview.sample.map((p: any, i: number) => <tr key={i}><td>{p.name}</td><td className="small">{p.position || '—'}</td><td className="small">{p.department || '—'}</td></tr>)}</tbody></table></div>}
      {edit && cfg && fields && <>
        <div className="row"><button className="primary" disabled={!dirty || cfg.builtin} title={cfg.builtin ? 'The built-in configuration is read-only – use “Save as new”' : ''} onClick={save}>Save</button><button onClick={saveAs}>Save as new…</button><button disabled={!!cfg.builtin} onClick={remove}>Delete</button>{dirty && <span className="chip warn">unsaved changes (they are still used for the next run)</span>}</div>
        <ConfigEditor cfg={cfg} setCfg={setCfg} fields={fields} tabId={tab?.id} /></>}
      {newBase && <AddBaseModal initial={newBase} onClose={() => setNewBase(false)} onCreated={t => chooseBase(t.id)} />}
    </div>
  );
}

/** Full-page version with the explanations. */
export function ScraperPage() {
  return <div className="main"><div className="page-head"><div><h1>Scraper</h1><div className="muted">Read any list on a website into a base: people, companies, leads. Detail pages are read in the background, so the list keeps its place.</div></div></div>
    <Scraper />
    <details className="card" style={{ marginTop: 14 }}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Scraping company lists, Apollo or LinkedIn?</summary>
      <div className="col" style={{ marginTop: 8 }}>
        <div><b>Google Maps</b> – search on Google Maps (“freight forwarder Surabaya”, “kos putri Malang”), wait for the list, open this panel and press Start. The list is scrolled to its end, every place is saved (name, category, address, phone, website, rating, hours, Maps link) and each business’s own website is checked for an e-mail address, WhatsApp number and social links. Choose or create a <b>Places</b> base for the full set of fields. Maps shows about 120 places per search, so add more searches (other cities or districts) under Edit configuration.</div>
        <div><b>Company or product lists</b> – choose a base from the Companies template (or make one with <b>＋ Add base</b>), open the listing page, pick the configuration “Companies / any listing”. Name, website, e-mail, phone, industry, size and location are filled when the page shows them; anything labelled “Label: value” fills a field of that name.</div>
        <div><b>Apollo and LinkedIn</b> are logged-in single-page apps, and their terms limit automated collection. VierCRM only reads what your own logged-in tab already shows, at a human pace, and stops at any check or login wall – it never tries to get past one. For large lists use the site’s own export (CSV) and bring it in with <b>Import CSV</b> inside a base; columns are matched to fields by name.</div>
        <div><b>Something unusual?</b> Switch the configuration to manual: pick one card on the page with ⌖ and map elements to fields by CSS selector or XPath. Save it under a name to reuse it.</div>
      </div></details>
  </div>;
}
