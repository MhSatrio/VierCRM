import React from 'react';
import type { AttachmentFile, AttachmentValue } from '../../core/types';
import { getFile } from '../../research/lookup';
import { download, fmtBytes, useToast } from '../bridge';

async function blobOf(f: AttachmentFile): Promise<Blob | null> {
  const row = await getFile(f.id); return row ? new Blob([row.data], { type: f.mime || 'application/pdf' }) : null;
}

export function AttachmentCard({ file, full }: { file: AttachmentFile; full?: boolean }) {
  const toast = useToast();
  const open = async () => { const b = await blobOf(file); if (!b) return toast('The stored file is missing.', 'bad'); window.open(URL.createObjectURL(b), '_blank'); };
  const save = async () => { const b = await blobOf(file); if (!b) return toast('The stored file is missing.', 'bad'); download(file.name, b, file.mime); };
  return (
    <span className={`pdfcard ${full ? 'full' : ''}`} title={`${file.name} · ${fmtBytes(file.size)}${file.access ? ` · ${file.access}` : ''}`}>
      <span aria-hidden>📄</span>
      <span className="col" style={{ gap: 0, minWidth: 0 }}>
        <span className="nm">{full && file.title ? file.title : file.name}</span>
        {full && <span className="muted small">{[file.year, file.venue].filter(Boolean).join(' · ')}{file.year || file.venue ? ' · ' : ''}{file.name} · {fmtBytes(file.size)}{file.access ? ` · ${file.access}` : ''}</span>}
      </span>
      <button className="sm" aria-label={`Download ${file.name}`} title="Download" onClick={save}>⬇</button>
      <button className="sm" aria-label={`Open ${file.name}`} title="Open" onClick={open}>↗</button>
    </span>
  );
}

export function AttachmentCell({ value, full, publicationUrl }: { value: AttachmentValue | null | undefined; full?: boolean; publicationUrl?: string }) {
  if (!value) return <span className="muted">—</span>;
  if (!value.files.length) return value.unavailable ? <span className="chip warn" title="No legally accessible PDF was found. The publication metadata is saved.">{value.unavailable}{publicationUrl && <> · <a href={publicationUrl} target="_blank" rel="noreferrer">page ↗</a></>}</span> : <span className="muted">—</span>;
  return <span className={full ? 'col' : 'row'} style={{ gap: 6, flexWrap: 'nowrap' }}>{value.files.map(f => <AttachmentCard key={f.id || f.name} file={f} full={full} />)}</span>;
}
