// UI plumbing: talking to the background worker, loading a table with live refresh, toasts, modals, host-permission helper.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as S from '../core/store';
import type { Field, RecordRow, Table, View } from '../core/types';
import type { BgRequest } from '../shared/messages';

export const send = <T = any,>(m: BgRequest | { type: string; [k: string]: any }): Promise<T> =>
  new Promise((resolve, reject) => { chrome.runtime.sendMessage(m, r => { const err = chrome.runtime.lastError; if (err) reject(new Error(err.message)); else if (r && r.ok === false && r.error) reject(new Error(r.error)); else resolve(r as T); }); });

export function onRuntime<T = any>(type: string, fn: (m: T) => void) {
  const h = (m: any) => { if (m?.type === type) fn(m); };
  chrome.runtime.onMessage.addListener(h); return () => chrome.runtime.onMessage.removeListener(h);
}

/** Pages forward their record changes to the background worker, which owns the automation engine. */
export function wireChanges() { S.setRemoteSink(change => { chrome.runtime.sendMessage({ type: 'record:changed', change }, () => void chrome.runtime.lastError); }); }

export const hasHostAccess = () => chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] });
/** Must be called from a click: asks once for permission to read the sites you scrape / download open-access PDFs from. */
export async function ensureHostAccess(): Promise<boolean> { if (await hasHostAccess()) return true; return chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] }); }

export interface TableData { table?: Table; fields: Field[]; views: View[]; records: RecordRow[]; loading: boolean; /** only the first records are loaded so far (the rest follows within moments) */ partial?: boolean; reload: () => Promise<void>; /** structure only (fields, views, table) – records stay as loaded */ reloadMeta: () => Promise<void>; /** put one changed record into the loaded table (no full reload) */ upsert: (rec: RecordRow) => void; remove: (ids: string[]) => void; refreshOne: (id: string) => Promise<void> }
export function useTable(tableId: string | undefined): TableData {
  const [state, setState] = useState<Omit<TableData, 'reload' | 'reloadMeta' | 'upsert' | 'remove' | 'refreshOne'>>({ fields: [], views: [], records: [], loading: true });
  const loadedOnce = useRef(false);
  const alive = useRef(true); useEffect(() => () => { alive.current = false; }, []);
  const reload = useCallback(async () => {
    if (!tableId) return;
    const meta = Promise.all([S.getTable(tableId), S.listFields(tableId), S.listViews(tableId)]);
    // first visit: read and paint the first rows BEFORE the big read starts (decoding 20 000 records blocks the page for a moment)
    if (!loadedOnce.current) { const [[table, fields, views], head] = await Promise.all([meta, S.listRecordsHead(tableId, 150)]); if (alive.current && !loadedOnce.current) { setState({ table, fields, views, records: head, loading: false, partial: true }); await new Promise(r => setTimeout(r, 30)); } }
    const [[table, fields, views], records] = await Promise.all([meta, S.listRecords(tableId)]); loadedOnce.current = true;
    if (alive.current) setState({ table, fields, views, records, loading: false, partial: false });
  }, [tableId]);
  const reloadMeta = useCallback(async () => { if (!tableId) return; const [table, fields, views] = await Promise.all([S.getTable(tableId), S.listFields(tableId), S.listViews(tableId)]); if (alive.current) setState(p => ({ ...p, table, fields, views })); }, [tableId]);
  useEffect(() => { loadedOnce.current = false; void reload(); }, [reload]);
  // patch records in place: unchanged records keep their identity, so cached row values and search text stay valid
  const patch = useCallback((upserts: RecordRow[], removed: string[] = []) => {
    if (!alive.current) return;
    setState(prev => {
      const gone = new Set(removed); const rep = new Map(upserts.map(r => [r.id, r])); const seen = new Set<string>();
      const records = prev.records.filter(r => !gone.has(r.id)).map(r => { const n = rep.get(r.id); if (n) seen.add(r.id); return n ?? r; });
      for (const r of upserts) if (!seen.has(r.id) && r.tableId === tableId) records.push(r);
      return { ...prev, records };
    });
  }, [tableId]);
  const upsert = useCallback((rec: RecordRow) => patch([rec]), [patch]);
  const remove = useCallback((ids: string[]) => patch([], ids), [patch]);
  const refreshOne = useCallback(async (id: string) => { const r = await S.getRecord(id); if (r) patch([r]); else patch([], [id]); }, [patch]);
  useEffect(() => {
    let t: any; const pending = new Map<string, string>(); let full = false;
    const flush = async () => {
      const p = [...pending]; pending.clear(); const doFull = full || p.length > 600; full = false;
      if (doFull) return reload();
      const got = await Promise.all(p.map(async ([id, kind]) => [id, kind, kind === 'deleted' ? null : await S.getRecord(id)] as const));
      patch(got.filter(g => g[2]).map(g => g[2]!), got.filter(g => !g[2]).map(g => g[0]));
    };
    const off = S.onRemoteRefresh((id, change) => { if (id !== tableId) return; if (change) pending.set(change.id, change.kind); else full = true; clearTimeout(t); t = setTimeout(() => void flush(), 250); });
    return () => { off(); clearTimeout(t); };
  }, [tableId, reload, patch]);
  return { ...state, reload, reloadMeta, upsert, remove, refreshOne };
}

/** All bases with their record counts; refreshes when a base is added / removed or its records change. */
export const BASES_CHANGED = 'vier-bases-changed';
export const announceBases = () => window.dispatchEvent(new Event(BASES_CHANGED));
export function useBases(): { tables: Table[]; counts: Record<string, number>; ready: boolean; reload: () => Promise<void> } {
  const [st, setSt] = useState<{ tables: Table[]; counts: Record<string, number>; ready: boolean }>({ tables: [], counts: {}, ready: false });
  const alive = useRef(true); useEffect(() => () => { alive.current = false; }, []);
  const reload = useCallback(async () => { const tables = await S.listTables(); const counts: Record<string, number> = {}; await Promise.all(tables.map(async t => { counts[t.id] = await S.countRecords(t.id); })); if (alive.current) setSt({ tables, counts, ready: true }); }, []);
  useEffect(() => { void reload(); let t: any; const bump = () => { clearTimeout(t); t = setTimeout(reload, 400); }; window.addEventListener(BASES_CHANGED, bump); const off = S.onRemoteRefresh(bump); return () => { window.removeEventListener(BASES_CHANGED, bump); off(); clearTimeout(t); }; }, [reload]);
  return { ...st, reload };
}
/** The base a page works on (scrape target, research, e-mail …), remembered per page in this browser; falls back to a sensible base. */
export function useBase(slot: string, tables: Table[], prefer?: (t: Table) => boolean): [string, (id: string) => void] {
  const key = `vier.base.${slot}`;
  const [id, setId] = useState<string>(() => { try { return localStorage.getItem(key) || ''; } catch { return ''; } });
  const valid = tables.some(t => t.id === id) ? id : (tables.find(prefer ?? (() => true)) ?? tables[0])?.id ?? '';
  const set = useCallback((v: string) => { setId(v); try { localStorage.setItem(key, v); } catch { /* private mode */ } }, [key]);
  return [valid, set];
}
export const hasResearch = (fields: Field[]) => fields.some(f => f.lookup?.kind === 'search');

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T>(); const [n, setN] = useState(0); const [loading, setLoading] = useState(true);
  useEffect(() => { let ok = true; setLoading(true); fn().then(d => { if (ok) { setData(d); setLoading(false); } }); return () => { ok = false; }; /* eslint-disable-next-line */ }, [...deps, n]);
  return { data, reload: () => setN(x => x + 1), loading };
}

// ------------------------------------------------------------------ toasts
type ToastKind = '' | 'good' | 'bad';
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
  const push = useCallback((msg: string, kind: ToastKind = '') => { const id = Date.now() + Math.random(); setItems(x => [...x, { id, msg, kind }]); setTimeout(() => setItems(x => x.filter(i => i.id !== id)), kind === 'bad' ? 8000 : 3800); }, []);
  return <ToastCtx.Provider value={push}>{children}<div className="toasts" role="status" aria-live="polite">{items.map(i => <div key={i.id} className={`toast ${i.kind}`}>{i.msg}</div>)}</div></ToastCtx.Provider>;
}

// ------------------------------------------------------------------ primitives
export function Modal({ title, onClose, children, footer, size = '' }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; size?: '' | 'wide' | 'narrow' }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className={`modal ${size}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-h"><h2 className="grow">{title}</h2><button className="ghost" aria-label="Close" onClick={onClose}>✕</button></div><div className="modal-b">{children}</div>{footer && <div className="modal-f">{footer}</div>}</div></div>;
}

export function Confirm({ message, confirmLabel = 'Confirm', danger, onYes, onNo, children }: { message: string; confirmLabel?: string; danger?: boolean; onYes: () => void; onNo: () => void; children?: React.ReactNode }) {
  return <Modal title="Please confirm" size="narrow" onClose={onNo} footer={<><button onClick={onNo}>Cancel</button><button className={danger ? 'danger' : 'primary'} onClick={onYes}>{confirmLabel}</button></>}><p style={{ marginTop: 0 }}>{message}</p>{children}</Modal>;
}

export const Field_ = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => <label className="f"><span>{label}</span>{children}{hint && <span className="muted small">{hint}</span>}</label>;

export const download = (name: string, data: BlobPart, mime = 'application/octet-stream') => { const url = URL.createObjectURL(new Blob([data], { type: mime })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); };
export const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** A page that throws must not blank the whole app: show what happened and let the user carry on. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode; resetKey?: string }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('VierCRM page error', error, info.componentStack); }
  componentDidUpdate(prev: { resetKey?: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined }); }
  render() { return this.state.error ? <div className="main"><div className="note bad"><b>This page hit a problem.</b> {String(this.state.error.message || this.state.error)}<div style={{ marginTop: 8 }}><button onClick={() => this.setState({ error: undefined })}>Try again</button> <button onClick={() => location.reload()}>Reload</button></div></div></div> : this.props.children; }
}
