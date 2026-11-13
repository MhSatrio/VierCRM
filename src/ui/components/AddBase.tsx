// "+ Add base": a base is one table of records (people, companies, anything). Start from a template and change it freely afterwards.
import React, { useState } from 'react';
import * as S from '../../core/store';
import { TEMPLATES } from '../../core/defaults';
import type { Table } from '../../core/types';
import { announceBases, Modal, useToast } from '../bridge';

export function AddBaseModal({ onClose, onCreated, initial = 'contacts' }: { onClose(): void; onCreated(t: Table): void; initial?: string }) {
  const toast = useToast(); const [tpl, setTpl] = useState(initial); const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  const chosen = TEMPLATES.find(t => t.id === tpl)!;
  const create = async () => {
    setBusy(true);
    try { const t = await S.createBase(name.trim() || chosen.name, tpl); announceBases(); toast(`Base “${t.name}” created`, 'good'); onCreated(t); onClose(); }
    catch (e: any) { toast(e.message, 'bad'); setBusy(false); }
  };
  return (
    <Modal title="Add a base" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={create}>Create base</button></>}>
      <div className="col">
        <div className="muted">A base is one list of records – people, companies, leads, anything. Pick the closest starting point; you can add, rename and remove fields afterwards.</div>
        <div className="tpls" role="radiogroup" aria-label="Starting point">{TEMPLATES.map(t => <button key={t.id} role="radio" aria-checked={tpl === t.id} className={`tpl ${tpl === t.id ? 'on' : ''}`} onClick={() => setTpl(t.id)}><span className="ico" aria-hidden>{t.icon}</span><b>{t.name}</b><span className="small muted">{t.description}</span></button>)}</div>
        <label className="f"><span>Name of the base</span><input type="text" autoFocus value={name} placeholder={chosen.name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} /></label>
        <div className="note">Research fields (latest publication, DOI, PDF …) can be added to <b>any</b> base later: open the base → <b>Fields</b> → <b>Add research fields</b>.</div>
      </div>
    </Modal>
  );
}
