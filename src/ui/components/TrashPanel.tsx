// Settings → Data → Recently deleted: the last deletions can be put back (the same ids and values; no automation runs for them).
import React, { useEffect, useState } from 'react';
import * as S from '../../core/store';
import { fmtTime, useToast } from '../bridge';

export function TrashPanel() {
  const toast = useToast();
  const [list, setList] = useState<S.TrashBatch[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const load = async () => {
    setList((await S.listTrash()).slice().reverse());
    setNames(Object.fromEntries((await S.listTables()).map(t => [t.id, t.name])));
  };
  useEffect(() => { void load(); }, []);
  if (!list.length) return <div className="muted small">Recently deleted: nothing. Records you delete can be put back from here.</div>;
  return (
    <div className="col">
      <h3>Recently deleted</h3>
      <div className="muted small">The last {S.TRASH_MAX_BATCHES} deletions (up to {S.TRASH_MAX_RECORDS.toLocaleString()} records) are kept so they can be put back.</div>
      {list.map(b => (
        <div className="row" key={b.id}>
          <span>{b.records.length.toLocaleString()} record(s) from {names[b.tableId] ?? 'a deleted base'} · {fmtTime(b.at)}</span>
          <button className="sm" disabled={!names[b.tableId]} onClick={async () => {
            try { const n = await S.restoreTrash(b.id); toast(`Restored ${n.toLocaleString()}`, 'good'); await load(); } catch (e: any) { toast(e.message, 'bad'); }
          }}>Put back</button>
        </div>
      ))}
    </div>
  );
}
