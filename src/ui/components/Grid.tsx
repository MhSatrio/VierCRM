// The spreadsheet: virtualised rows (thousands of contacts stay smooth), inline editing, sortable headers, row selection.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CellValue, Field, SortSpec } from '../../core/types';
import type { RowView } from '../../core/filters';
import { cellText, isAttachment } from '../../core/values';
import { AttachmentCell } from './attachments';
import { idOf } from '../../core/defaults';
import * as S from '../../core/store';
import { normRange, type CellRange } from '../../core/clipboard';

const ROW_H = 34; const SEL_W = 38; const OVERSCAN = 8;
const STATUS_CLASS: Record<string, string> = { Scraped: 'good', Partial: 'warn', Failed: 'bad', Found: 'good', 'PDF attached': 'good', 'Needs match': 'warn', 'Not found': 'bad', 'Full text unavailable': 'warn', Sent: '', Delivered: 'good', Opened: 'good', Clicked: 'good', Bounced: 'bad', Unsubscribed: 'bad', Contacted: 'warn', Replied: 'good', 'Do not contact': 'bad', 'Not interested': 'bad' };

export const isComputed = (f: Field) => ['formula', 'createdTime', 'lastModified'].includes(f.type);

function Display({ f, v, rowValues, errors, pubUrlId }: { f: Field; v: CellValue; rowValues: Record<string, CellValue>; errors?: string; pubUrlId?: string }) {
  if (f.type === 'formula' && errors) return <span className="chip bad" title={errors}>#ERROR</span>;
  if (f.type === 'attachment') return <AttachmentCell value={isAttachment(v) ? v : null} publicationUrl={(pubUrlId && cellText(rowValues[pubUrlId])) || undefined} />;
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
  if (f.type === 'checkbox') return <span aria-label={v ? 'checked' : 'unchecked'}>{v ? '☑' : '☐'}</span>;
  if (f.type === 'email') return <a href={`mailto:${cellText(v)}`} onClick={e => e.stopPropagation()}>{cellText(v)}</a>;
  if (f.type === 'url') return <a href={cellText(v)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{cellText(v).replace(/^https?:\/\/(www\.)?/, '')}</a>;
  if (f.type === 'multiSelect' && Array.isArray(v)) return <>{v.map(x => <span key={x} className="chip" style={{ marginRight: 4 }}>{x}</span>)}</>;
  if (f.type === 'singleSelect' || f.type === 'scrapingStatus' || f.type === 'emailStatus' || f.type === 'publicationStatus') return <span className={`chip ${STATUS_CLASS[cellText(v)] ?? ''}`}>{cellText(v)}</span>;
  if (f.type === 'createdTime' || f.type === 'lastModified') return <span className="muted">{cellText(v).slice(0, 16).replace('T', ' ')}</span>;
  return <>{cellText(v)}</>;
}

function Editor({ f, value, onCommit, onCancel }: { f: Field; value: CellValue; onCommit: (v: CellValue) => void; onCancel: () => void }) {
  const [v, setV] = useState<string>(cellText(value) === 'true' ? '' : Array.isArray(value) ? value.join(', ') : cellText(value));
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null); useEffect(() => { ref.current?.focus(); ref.current?.select?.(); }, []);
  const done = (raw = v) => {
    const s = raw.trim();
    if (f.type === 'number') onCommit(s === '' ? null : Number(s.replace(/,/g, '')));
    else if (f.type === 'multiSelect') onCommit(s ? s.split(/[;,]/).map(x => x.trim()).filter(Boolean) : []);
    else onCommit(s === '' ? null : s);
  };
  const keys = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); done(); } if (e.key === 'Escape') onCancel(); };
  const choices = f.options?.choices;
  if (choices?.length && ['singleSelect', 'scrapingStatus', 'emailStatus', 'publicationStatus'].includes(f.type)) return <select ref={ref} value={v} onChange={e => { setV(e.target.value); done(e.target.value); }} onBlur={onCancel} onKeyDown={keys}><option value="">—</option>{choices.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}</select>;
  return <input ref={ref} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text'} autoComplete="off" value={v} onChange={e => setV(e.target.value)} onBlur={() => done()} onKeyDown={keys} />;
}

export interface GridProps {
  fields: Field[]; rows: RowView[]; errors?: Record<string, Record<string, string>>;
  selected: Set<string>; onSelect(next: Set<string>): void;
  sort: SortSpec[]; onSort(fieldId: string): void;
  onEdit(recordId: string, fieldId: string, value: CellValue): void; onOpen(recordId: string): void;
  /** the tab-separated text of a range of cells (Ctrl+C) */
  copyText?(range: CellRange): string;
  /** text pasted with Ctrl+V: its top-left cell goes at `at`; `fill` is the selected range (one value fills all of it) */
  onPasteText?(text: string, at: { r: number; c: number }, fill: CellRange | null): void;
  /** Delete / Backspace on a range of cells */
  onClearRange?(range: CellRange): void;
}

export function Grid({ fields, rows, selected, onSelect, sort, onSort, onEdit, onOpen, errors, copyText, onPasteText, onClearRange }: GridProps) {
  const pubUrlId = useMemo(() => idOf(fields, 'publicationUrl'), [fields]);
  const wrap = useRef<HTMLDivElement>(null); const [scroll, setScroll] = useState({ top: 0, h: 600 });
  const [editing, setEditing] = useState<{ rec: string; field: string } | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  // the cell cursor and the range of cells (anchor to cursor): click, Shift+click, drag, or the arrow keys
  const [cur, setCur] = useState<{ r: number; c: number } | null>(null);
  const [anc, setAnc] = useState<{ r: number; c: number } | null>(null);
  const range = cur && anc ? normRange(anc, cur) : null;
  const dragging = useRef(false);
  useEffect(() => { const up = () => { dragging.current = false; }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up); }, []);
  useEffect(() => { if (cur && (cur.r >= rows.length || cur.c >= fields.length)) { setCur(null); setAnc(null); } }, [rows.length, fields.length, cur]);
  const reveal = (r: number) => {
    const el = wrap.current; if (!el) return; const top = r * ROW_H + 34;
    if (top < el.scrollTop + 34) el.scrollTop = top - 34; else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };
  const inField = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input:not([type=checkbox]),select,textarea');
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || inField(e.target) || rows.length === 0) return;
    const mod = e.ctrlKey || e.metaKey; const k = e.key;
    const go = (dr: number, dc: number) => {
      e.preventDefault();
      const base = cur ?? { r: 0, c: 0 };
      const n = cur ? { r: Math.max(0, Math.min(rows.length - 1, base.r + dr)), c: Math.max(0, Math.min(fields.length - 1, base.c + dc)) } : base;
      setCur(n); if (!e.shiftKey || !anc) setAnc(n); reveal(n.r);
    };
    if (k === 'ArrowDown') go(1, 0); else if (k === 'ArrowUp') go(-1, 0); else if (k === 'ArrowRight') go(0, 1); else if (k === 'ArrowLeft') go(0, -1);
    else if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); setAnc({ r: 0, c: 0 }); setCur({ r: rows.length - 1, c: fields.length - 1 }); }
    else if (k === 'Escape') { setCur(null); setAnc(null); }
    else if ((k === 'Enter' || k === 'F2') && cur) { const f = fields[cur.c]; if (f && !isComputed(f) && f.type !== 'attachment' && f.type !== 'checkbox') { e.preventDefault(); setEditing({ rec: rows[cur.r].rec.id, field: f.id }); } }
    else if ((k === 'Delete' || k === 'Backspace') && range && onClearRange) { e.preventDefault(); onClearRange(range); }
  };
  const onCopy = (e: React.ClipboardEvent) => { if (editing || inField(e.target) || !range || !copyText) return; e.clipboardData.setData('text/plain', copyText(range)); e.preventDefault(); };
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing || inField(e.target) || !cur || !onPasteText) return;
    const t = e.clipboardData.getData('text/plain'); if (!t) return;
    e.preventDefault(); onPasteText(t, range ? { r: range.r1, c: range.c1 } : cur, range);
  };
  useEffect(() => { const el = wrap.current; if (!el) return; const ro = new ResizeObserver(() => setScroll(s => ({ ...s, h: el.clientHeight }))); ro.observe(el); setScroll(s => ({ ...s, h: el.clientHeight })); return () => ro.disconnect(); }, []);
  // column widths: the field's saved width, or the width while it is being dragged
  const [over, setOver] = useState<Record<string, number>>({});
  const widths = useMemo(() => fields.map(f => over[f.id] ?? f.width ?? 160), [fields, over]);
  const startResize = (e: React.PointerEvent, fieldId: string, startW: number) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX; let last = startW;
    const move = (ev: PointerEvent) => { last = Math.min(800, Math.max(60, startW + ev.clientX - x0)); setOver(p => ({ ...p, [fieldId]: last })); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); void S.updateField(fieldId, { width: last }).catch(() => {}); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }; const total = SEL_W + widths.reduce((a, b) => a + b, 0);
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN); const last = Math.min(rows.length, Math.ceil((scroll.top + scroll.h) / ROW_H) + OVERSCAN);
  const allSelected = rows.length > 0 && selected.size >= rows.length;
  const toggle = (i: number, e: React.MouseEvent | React.ChangeEvent) => {
    const id = rows[i].rec.id; const next = new Set(selected); const shift = (e.nativeEvent as MouseEvent).shiftKey;
    if (shift && anchor != null) { const [a, b] = [anchor, i].sort((x, y) => x - y); for (let k = a; k <= b; k++) next.add(rows[k].rec.id); } else { next.has(id) ? next.delete(id) : next.add(id); setAnchor(i); }
    onSelect(next);
  };
  return (
    <div className="grid-wrap" ref={wrap} tabIndex={0} aria-label="Records. Arrow keys move between cells, Ctrl+C copies, Ctrl+V pastes, Enter edits." onKeyDown={onKeyDown} onCopy={onCopy} onPaste={onPaste} onScroll={e => setScroll(s => ({ ...s, top: (e.target as HTMLElement).scrollTop }))} role="grid" aria-rowcount={rows.length}>
      <div className="g-head" style={{ width: total }} role="row">
        <div className="g-sel" role="columnheader" aria-label="Select" style={{ height: 34 }}><input type="checkbox" aria-label="Select all rows in this view" checked={allSelected} onChange={e => onSelect(e.target.checked ? new Set(rows.map(r => r.rec.id)) : new Set())} /></div>
        {fields.map((f, i) => { const s = sort.find(x => x.fieldId === f.id); return <div key={f.id} className="g-hc" role="columnheader" tabIndex={0} aria-sort={s ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none'} style={{ width: widths[i], position: 'relative' }} title={f.description || f.name} onClick={() => onSort(f.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(f.id); } }}>{f.name}{f.lookup ? ' ✦' : ''}{s ? (s.dir === 'asc' ? ' ▲' : ' ▼') : ''}<span className="g-rz" title="Drag to make this column wider or narrower" onPointerDown={e => startResize(e, f.id, widths[i])} onClick={e => e.stopPropagation()} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 8, cursor: 'col-resize', zIndex: 2 }} /></div>; })}
      </div>
      <div role="rowgroup" style={{ height: rows.length * ROW_H, width: total, position: 'relative' }}>
        {rows.slice(first, last).map((r, k) => {
          const i = first + k; const sel = selected.has(r.rec.id);
          return (
            <div key={r.rec.id} className={`g-row ${sel ? 'sel' : ''}`} style={{ top: i * ROW_H, height: ROW_H, width: total }} role="row" aria-selected={sel}>
              <div className="g-sel" role="gridcell"><input type="checkbox" aria-label={`Select row ${i + 1}`} checked={sel} onChange={e => toggle(i, e)} /></div>
              {fields.map((f, c) => {
                const isEd = editing?.rec === r.rec.id && editing.field === f.id; const canEdit = !isComputed(f) && f.type !== 'attachment';
                const toggleBox = f.type === 'checkbox' && canEdit;
                return (
                  <div key={f.id} role="gridcell" aria-selected={!!range && i >= range.r1 && i <= range.r2 && c >= range.c1 && c <= range.c2} className={`g-c ${isEd ? 'ed' : ''}${range && i >= range.r1 && i <= range.r2 && c >= range.c1 && c <= range.c2 ? ' rng' : ''}${cur && cur.r === i && cur.c === c ? ' cur' : ''}`} style={{ width: widths[c] }}
                    onMouseDown={e => { if (e.button !== 0 || isEd) return; const pos = { r: i, c }; if (e.shiftKey && anc) setCur(pos); else { setCur(pos); setAnc(pos); } dragging.current = true; wrap.current?.focus({ preventScroll: true }); }}
                    onMouseEnter={() => { if (dragging.current) setCur({ r: i, c }); }}
                    onDoubleClick={() => { if (canEdit && !toggleBox) setEditing({ rec: r.rec.id, field: f.id }); else if (f.type === 'attachment') onOpen(r.rec.id); }}
                    onClick={() => { if (toggleBox) onEdit(r.rec.id, f.id, !r.values[f.id]); }}>
                    {isEd ? <Editor f={f} value={r.rec.cells[f.id]} onCancel={() => setEditing(null)} onCommit={v => { setEditing(null); if (JSON.stringify(v ?? null) !== JSON.stringify(r.rec.cells[f.id] ?? null)) onEdit(r.rec.id, f.id, v); }} />
                      : <>{f.primary ? <a href="#open" className="nowrap" style={{ color: 'inherit', fontWeight: 500, textDecoration: 'none' }} onClick={e => { e.preventDefault(); onOpen(r.rec.id); }}><Display pubUrlId={pubUrlId} f={f} v={r.values[f.id]} rowValues={r.values} errors={errors?.[r.rec.id]?.[f.id]} /></a> : <Display pubUrlId={pubUrlId} f={f} v={r.values[f.id]} rowValues={r.values} errors={errors?.[r.rec.id]?.[f.id]} />}</>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {!rows.length && <div className="muted" style={{ padding: 24 }}>No records match this view.</div>}
    </div>
  );
}
