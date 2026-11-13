import React, { useMemo, useState } from 'react';
import * as S from '../../core/store';
import { idOf } from '../../core/defaults';
import type { Choice, Field, FieldType, LookupConfig, LookupOutput, RecordRow, SourceId } from '../../core/types';
import { dependencyEdges, validateDependencies, topologicalOrder } from '../../core/deps';
import { evaluateFormula, FORMULA_FUNCTIONS, formatFValue } from '../../core/formula';
import { byLowerName, cellText, computeRecord } from '../../core/values';
import { Field_, Modal, useToast } from '../bridge';

const TYPES: [FieldType, string][] = [['text', 'Single line text'], ['longText', 'Long text'], ['email', 'Email'], ['phone', 'Phone'], ['url', 'URL'], ['number', 'Number'], ['date', 'Date'], ['checkbox', 'Checkbox'], ['singleSelect', 'Single select'], ['multiSelect', 'Multiple select'], ['formula', 'Formula'], ['createdTime', 'Created time'], ['lastModified', 'Last modified time'], ['attachment', 'Attachment'], ['scrapingStatus', 'Scraping status'], ['emailStatus', 'Email status'], ['publicationStatus', 'Publication status']];
const SOURCE_LABEL: Record<string, string> = { openalex: 'OpenAlex', crossref: 'Crossref', semanticscholar: 'Semantic Scholar', pubmed: 'PubMed', googlescholar: 'Google Scholar (your tab)', researchgate: 'ResearchGate (your tab)' };
const OUTPUT_TYPE: Record<LookupOutput, FieldType> = { title: 'text', year: 'number', date: 'date', doi: 'text', url: 'url', authors: 'longText', venue: 'text', abstract: 'longText', fullTextUrl: 'url', access: 'text', keywords: 'text', pdf: 'attachment' };

export function FormulaEditor({ value, onChange, fields, sample }: { value: string; onChange(v: string): void; fields: Field[]; sample?: RecordRow }) {
  const result = useMemo(() => {
    if (!value.trim()) return null;
    const names = byLowerName(fields); const vals = sample ? computeRecord(fields, sample).values : {};
    return evaluateFormula(value, n => { const f = names.get(n.trim().toLowerCase()); if (!f) throw new Error(`Unknown field {${n}}`); const v = vals[f.id]; return Array.isArray(v) ? v.join(', ') : (v as any) ?? ''; });
  }, [value, fields, sample]);
  return (
    <div className="col">
      <textarea rows={4} spellCheck={false} aria-label="Formula" value={value} placeholder={'IF(IS_NOT_EMPTY({Email}), "Ready", "Missing Email")'} onChange={e => onChange(e.target.value)} style={{ fontFamily: 'Consolas, monospace' }} />
      {result && (result.error ? <div className="note bad">⚠ {result.error}</div> : <div className="note good">Preview{sample ? ' on the first record' : ''}: <b>{formatFValue(result.value) || '(empty)'}</b></div>)}
      <div className="muted small">Fields go in {'{braces}'}. Functions: {FORMULA_FUNCTIONS.join(', ')}. Formulas are evaluated by a safe parser – never executed as code.</div>
    </div>
  );
}

function LookupEditor({ lookup, onChange, fields, selfId }: { lookup: LookupConfig; onChange(l: LookupConfig): void; fields: Field[]; selfId?: string }) {
  const others = fields.filter(f => f.id !== selfId); const searchFields = others.filter(f => f.lookup?.kind === 'search');
  const sel = (label: string, key: keyof LookupConfig, list: Field[], optional = true) => <Field_ label={label}><select value={(lookup[key] as string) || ''} onChange={e => onChange({ ...lookup, [key]: e.target.value || undefined })}>{optional && <option value="">— none —</option>}{list.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field_>;
  return (
    <div className="card col" style={{ background: 'var(--light-2)' }}>
      <b>Research lookup</b>
      <Field_ label="What does this field do?"><select value={lookup.kind} onChange={e => { const kind = e.target.value as LookupConfig['kind']; onChange({ ...lookup, kind, output: kind === 'pdf' ? 'pdf' : kind === 'keywords' ? 'keywords' : kind === 'abstract' ? 'abstract' : kind === 'search' ? 'title' : lookup.output === 'pdf' ? 'doi' : lookup.output }); }}>
        <option value="search">Search publications for this person (latest publication)</option><option value="derive">Read a detail of the publication found above (DOI, date, URL, venue…)</option><option value="pdf">Find a legal full-text PDF of that publication</option><option value="abstract">Get the abstract of that publication</option><option value="keywords">Derive research keywords from that publication</option></select></Field_>
      {lookup.kind === 'search' ? <>
        <div><div className="muted small" style={{ marginBottom: 4 }}>Sources, tried in this order until the author is identified with enough confidence:</div>
          <div className="row">{Object.keys(SOURCE_LABEL).map(s => { const on = lookup.sources?.includes(s as SourceId); return <label key={s} className="chk"><input type="checkbox" checked={!!on} onChange={e => onChange({ ...lookup, sources: e.target.checked ? [...(lookup.sources || []), s as SourceId] : (lookup.sources || []).filter(x => x !== s) })} />{SOURCE_LABEL[s]}</label>; })}</div></div>
        <div className="grid2">{sel('Search with this name field', 'nameFieldId', others, false)}{sel('Institution (helps tell people apart)', 'institutionFieldId', others)}{sel('Profile URL (an ORCID / Scholar id in it identifies the author)', 'profileUrlFieldId', others)}{sel('Research keywords (optional)', 'keywordsFieldId', others)}</div>
        <div className="grid2"><Field_ label="Only publications from year"><input type="number" value={lookup.yearFrom ?? ''} onChange={e => onChange({ ...lookup, yearFrom: e.target.value ? Number(e.target.value) : undefined })} /></Field_><Field_ label="… to year"><input type="number" value={lookup.yearTo ?? ''} onChange={e => onChange({ ...lookup, yearTo: e.target.value ? Number(e.target.value) : undefined })} /></Field_></div>
        <Field_ label="Only publications mentioning (comma = or)"><input type="text" value={lookup.mustContain ?? ''} onChange={e => onChange({ ...lookup, mustContain: e.target.value || undefined })} /></Field_>
      </> : <>
        {sel('Reads from this publication field', 'fromFieldId', searchFields, false)}
        {lookup.kind === 'derive' && <Field_ label="Which detail?"><select value={lookup.output} onChange={e => onChange({ ...lookup, output: e.target.value as LookupOutput })}>{(['title', 'year', 'date', 'doi', 'url', 'authors', 'venue', 'abstract', 'fullTextUrl', 'access', 'keywords'] as LookupOutput[]).map(o => <option key={o} value={o}>{o}</option>)}</select></Field_>}
        {lookup.kind === 'pdf' && <div className="note">Looks in Unpaywall, OpenAlex, Europe PMC, arXiv and the publication's own page for a lawful open-access PDF. Paywalled papers are never bypassed; Sci-Hub and similar sites are never used.</div>}
      </>}
      <div className="muted small">Runs only when this field is empty and every field it depends on has a value. {fields.length ? '' : ''}</div>
    </div>
  );
}

export function DependencyFlow({ fields }: { fields: Field[] }) {
  const edges = dependencyEdges(fields).filter(e => fields.find(f => f.id === e.to)?.lookup);
  const msgs = validateDependencies(fields); const name = (id: string) => fields.find(f => f.id === id)?.name ?? id;
  let order: string[] = []; try { order = topologicalOrder(fields, f => !!f.lookup); } catch { /* reported in msgs */ }
  return (
    <div className="col">
      {msgs.map(m => <div key={m} className="note bad">⚠ {m}</div>)}
      {order.length > 0 && <div><div className="muted small" style={{ marginBottom: 4 }}>Run order (upstream first):</div><div className="flow">{order.map((id, i) => <React.Fragment key={id}>{i > 0 && <span className="arrow">→</span>}<span className="chip">{name(id)}</span></React.Fragment>)}</div></div>}
      {edges.length > 0 && <table className="t"><thead><tr><th>Field</th><th>depends on</th><th>because</th></tr></thead><tbody>{edges.map((e, i) => <tr key={i}><td>{name(e.to)}</td><td>{name(e.from)}</td><td className="muted">{e.why}</td></tr>)}</tbody></table>}
      {!edges.length && !msgs.length && <div className="muted">No research fields yet. Add “Latest Publication” and its follow-ups to build a chain such as Full Name → Latest Publication → DOI → PDF.</div>}
      <div className="muted small">If an upstream field is empty, the fields below it are skipped and the run log says which one is missing.</div>
    </div>
  );
}

function EditField({ field, fields, tableId, sample, onClose, onSaved }: { field?: Field; fields: Field[]; tableId: string; sample?: RecordRow; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const [name, setName] = useState(field?.name ?? ''); const [type, setType] = useState<FieldType>(field?.type ?? 'text');
  const [choices, setChoices] = useState((field?.options?.choices || []).map(c => c.name).join('\n')); const [formula, setFormula] = useState(field?.options?.formula ?? '');
  const [lookup, setLookup] = useState<LookupConfig | undefined>(field?.lookup); const [desc, setDesc] = useState(field?.description ?? '');
  const hasChoices = ['singleSelect', 'multiSelect'].includes(type);
  const startResearch = (kind: LookupConfig['kind']) => {
    const nameF = fields.find(f => f.id === idOf(fields, 'fullName')) ?? fields.find(f => f.primary) ?? fields[0];
    const search = fields.find(f => f.lookup?.kind === 'search');
    const l: LookupConfig = kind === 'search' ? { kind, output: 'title', sources: ['openalex', 'crossref', 'semanticscholar', 'pubmed'], nameFieldId: nameF?.id, institutionFieldId: idOf(fields, 'institution') ?? fields.find(f => /institution|company|university/i.test(f.name))?.id, profileUrlFieldId: idOf(fields, 'profileUrl') ?? fields.find(f => /profile/i.test(f.name))?.id } : { kind, output: kind === 'pdf' ? 'pdf' : kind === 'abstract' ? 'abstract' : kind === 'keywords' ? 'keywords' : 'doi', fromFieldId: search?.id };
    setLookup(l); if (kind === 'pdf') setType('attachment'); else if (kind === 'abstract') setType('longText'); else if (kind === 'derive') setType('text');
  };
  const save = async () => {
    try {
      if (!name.trim()) throw new Error('Give the field a name.');
      if (fields.some(f => f.id !== field?.id && f.name.trim().toLowerCase() === name.trim().toLowerCase())) throw new Error('Another field already has that name.');
      const options: Field['options'] = { ...(field?.options || {}) };
      if (hasChoices || ['scrapingStatus', 'emailStatus', 'publicationStatus'].includes(type)) options.choices = choices.split('\n').map(s => s.trim()).filter(Boolean).map((n, i): Choice => ({ id: `c${i}`, name: n }));
      if (type === 'formula') { if (!formula.trim()) throw new Error('Write a formula.'); options.formula = formula; }
      let l = lookup; if (l && l.kind !== 'search' && l.output !== 'pdf' && type === 'attachment') l = { ...l, output: 'pdf' };
      const spec: Partial<Field> = { name: name.trim(), type: l?.kind === 'pdf' ? 'attachment' : l?.kind === 'derive' && type === 'text' ? OUTPUT_TYPE[l.output] : type, options, lookup: l, description: desc || undefined };
      if (field) await S.updateField(field.id, spec); else await S.addField(tableId, spec as any);
      toast('Field saved', 'good'); onSaved(); onClose();
    } catch (e: any) { toast(e.message, 'bad'); }
  };
  return (
    <Modal title={field ? `Edit “${field.name}”` : 'Add a field'} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save field</button></>}>
      <div className="col">
        <div className="grid2"><Field_ label="Name"><input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field_>
          <Field_ label="Type"><select value={type} onChange={e => setType(e.target.value as FieldType)} disabled={!!field?.primary}>{TYPES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}</select></Field_></div>
        <Field_ label="Description (optional)"><input type="text" value={desc} onChange={e => setDesc(e.target.value)} /></Field_>
        {hasChoices && <Field_ label="Options (one per line)"><textarea rows={5} value={choices} onChange={e => setChoices(e.target.value)} /></Field_>}
        {type === 'formula' && <FormulaEditor value={formula} onChange={setFormula} fields={fields.filter(f => f.id !== field?.id)} sample={sample} />}
        {!field && !lookup && type !== 'formula' && <div className="row"><span className="muted small">Or make it a research field:</span><button className="sm" onClick={() => startResearch('search')}>Latest publication</button><button className="sm" onClick={() => startResearch('derive')}>Publication DOI / date / URL…</button><button className="sm" onClick={() => startResearch('pdf')}>Publication PDF</button><button className="sm" onClick={() => startResearch('abstract')}>Abstract</button><button className="sm" onClick={() => startResearch('keywords')}>Keywords</button></div>}
        {lookup && <><LookupEditor lookup={lookup} onChange={setLookup} fields={fields} selfId={field?.id} /><button className="sm" style={{ alignSelf: 'flex-start' }} onClick={() => setLookup(undefined)}>Remove the research behaviour (keep a plain field)</button></>}
      </div>
    </Modal>
  );
}

export function FieldManager({ tableId, fields, sample, onClose, onChanged }: { tableId: string; fields: Field[]; sample?: RecordRow; onClose(): void; onChanged(): void }) {
  const toast = useToast(); const [edit, setEdit] = useState<Field | 'new' | null>(null); const [tab, setTab] = useState<'fields' | 'deps'>('fields'); const canAddResearch = !!idOf(fields, 'fullName') || fields.some(f => f.primary); const hasSearch = fields.some(f => f.lookup?.kind === 'search');
  const addResearch = async () => { const added = await S.addResearchFields(tableId); onChanged(); toast(added.length ? `Added ${added.length} research fields. Records with a name will be researched automatically.` : 'This base already has the research fields.', 'good'); };
  const move = async (i: number, d: -1 | 1) => { const ids = fields.map(f => f.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; await S.reorderFields(tableId, ids); onChanged(); };
  const del = async (f: Field) => { if (!confirm(`Delete the field “${f.name}” and its values in every record? This cannot be undone.`)) return; try { await S.deleteField(f.id); onChanged(); } catch (e: any) { toast(e.message, 'bad'); } };
  return (
    <Modal title="Fields" size="wide" onClose={onClose} footer={<button onClick={onClose}>Done</button>}>
      <div className="tabs"><button className={tab === 'fields' ? 'on' : ''} onClick={() => setTab('fields')}>Fields</button><button className={tab === 'deps' ? 'on' : ''} onClick={() => setTab('deps')}>Dependencies</button></div>
      {tab === 'fields' ? <>
        <table className="t"><thead><tr><th></th><th>Name</th><th>Type</th><th>Visible</th><th></th></tr></thead><tbody>
          {fields.map((f, i) => <tr key={f.id}>
            <td className="nowrap"><button className="ghost sm" aria-label={`Move ${f.name} up`} onClick={() => move(i, -1)}>↑</button><button className="ghost sm" aria-label={`Move ${f.name} down`} onClick={() => move(i, 1)}>↓</button></td>
            <td><b>{f.name}</b>{f.primary && <span className="chip dark" style={{ marginLeft: 6 }}>primary</span>}{f.lookup && <span className="chip" style={{ marginLeft: 6 }}>research · {f.lookup.kind}</span>}{f.description && <div className="muted small">{f.description}</div>}</td>
            <td className="muted">{TYPES.find(t => t[0] === f.type)?.[1]}</td>
            <td><input type="checkbox" aria-label={`Show ${f.name}`} checked={!f.hidden} onChange={async e => { await S.updateField(f.id, { hidden: !e.target.checked }); onChanged(); }} /></td>
            <td className="nowrap"><button className="sm" onClick={() => setEdit(f)}>Edit</button> <button className="sm" disabled={f.primary} onClick={() => del(f)}>Delete</button></td></tr>)}
        </tbody></table>
        <div className="row" style={{ marginTop: 10 }}><button className="primary" onClick={() => setEdit('new')}>+ Add field</button>{canAddResearch && !hasSearch && <button onClick={addResearch} title="Latest publication, date, DOI, URL, PDF, keywords – filled automatically for records with a name">✦ Add research fields</button>}<span className="muted small">Research fields work in any base. A field named like a “Label: value” on a page is filled when you scrape.</span></div>
      </> : <DependencyFlow fields={fields} />}
      {edit && <EditField field={edit === 'new' ? undefined : edit} fields={fields} tableId={tableId} sample={sample} onClose={() => setEdit(null)} onSaved={onChanged} />}
    </Modal>
  );
}
void cellText;
