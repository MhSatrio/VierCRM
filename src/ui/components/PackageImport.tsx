// Import a Vier package (a .vierpkg.json written by another Vier app, for example Job Search) into this base.
import React, { useMemo, useState } from 'react';
import * as S from '../../core/store';
import { planImport, validatePackage, type VierPackage } from '../../core/vierpkg';
import { importPackage } from '../../core/vierpkgImport';
import { Modal, useTable, useToast } from '../bridge';

const HOW: Record<string, string> = { key: 'by meaning', name: 'by name', new: 'new field', none: 'not imported' };

export function PackageImportModal({ tableId, onClose, onDone }: { tableId: string; onClose(): void; onDone(): void }) {
  const toast = useToast(); const { fields } = useTable(tableId);
  const [pkg, setPkg] = useState<VierPackage | null>(null); const [errors, setErrors] = useState<string[]>([]);
  const [existing, setExisting] = useState<Set<string>>(new Set()); const [createMissing, setCreateMissing] = useState(true); const [busy, setBusy] = useState(false);
  const pick = async (f: File) => {
    setPkg(null); setErrors([]);
    let json: unknown;
    try { json = JSON.parse(await f.text()); } catch { setErrors(['That file is not valid JSON.']); return; }
    const v = validatePackage(json);
    if (!v.ok) { setErrors(v.errors); return; }
    const recs = await S.listRecords(tableId);
    setExisting(new Set(recs.flatMap(r => r.meta?.external ?? []))); setPkg(json as VierPackage);
  };
  const plan = useMemo(() => (pkg ? planImport(pkg, fields, existing, { createMissing }) : null), [pkg, fields, existing, createMissing]);
  const importNow = async () => {
    if (!pkg) return; setBusy(true);
    try {
      const r = await importPackage(tableId, pkg, { createMissing });
      toast(`Imported ${r.created} record(s) from ${pkg.source.app}; ${r.alreadyImported} already imported, ${r.duplicates} duplicate(s) skipped${r.newFields ? `; ${r.newFields} field(s) created` : ''}.`, 'good'); onDone(); onClose();
    } catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Import a Vier package" size="wide" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!pkg || !plan || busy || plan.rows.length === 0} onClick={importNow}>{busy ? 'Importing…' : `Import ${plan ? plan.rows.length.toLocaleString() : ''} record(s)`}</button></>}>
      <input type="file" accept=".json,application/json" aria-label="Vier package file" onChange={e => e.target.files?.[0] && void pick(e.target.files[0])} />
      <div className="note">A package is a file another Vier app saved for VierCRM, for example the "To VierCRM" button of Job Search. Records you imported before are skipped. Automations do not run for imported records. Nothing is sent anywhere.</div>
      {errors.length > 0 && <div className="note warn" role="alert"><b>This file cannot be imported:</b><ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
      {pkg && plan && <>
        <div><b>{pkg.records.length.toLocaleString()}</b> record(s) from <b>{pkg.source.app}</b>{pkg.source.exportedAt ? ` (saved ${pkg.source.exportedAt.slice(0, 10)})` : ''}. {plan.skippedExisting ? `${plan.skippedExisting.toLocaleString()} already imported before, so they are skipped. ` : ''}</div>
        <label className="chk"><input type="checkbox" checked={createMissing} onChange={e => setCreateMissing(e.target.checked)} />Create the fields this base does not have yet</label>
        <table className="t"><thead><tr><th>Package field</th><th>Goes into</th><th>How</th></tr></thead><tbody>
          {plan.map.map(m => <tr key={m.pkgName}><td><b>{m.pkgName}</b></td><td>{m.fieldId ? fields.find(f => f.id === m.fieldId)?.name : m.create ? `${m.create.name} (new)` : '—'}</td><td className="muted small">{HOW[m.how]}</td></tr>)}
        </tbody></table>
      </>}
    </Modal>
  );
}
