// Small shared HTTP layer for every research source: base-URL overrides (tests), retry with back-off on 429/5xx, and a politeness delay.
import type { Secrets, Settings } from '../core/settings';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface Ctx {
  fetch: Fetcher;
  settings: Settings;
  secrets: Secrets;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Sources that need a rendered page (Google Scholar, ResearchGate) call this; the background worker opens a tab, tests inject a stub. */
  renderPage?: (url: string, extractor: 'scholar' | 'researchgate') => Promise<unknown>;
  log?: (msg: string) => void;
}

export class HttpError extends Error { constructor(public status: number, public url: string, msg?: string) { super(msg || `HTTP ${status} from ${new URL(url).host}`); } }

export const apiBase = (ctx: Ctx, id: keyof Settings['apiBases'], fallback: string) => (ctx.settings.apiBases[id] || fallback).replace(/\/+$/, '');

export async function getJson<T = any>(ctx: Ctx, url: string, init: RequestInit = {}, { retries = 3 }: { retries?: number } = {}): Promise<T> {
  let attempt = 0;
  for (;;) {
    let res: Response;
    try { res = await ctx.fetch(url, { ...init, headers: { accept: 'application/json', ...(init.headers || {}) } }); }
    catch (e: any) { if (attempt++ < retries) { await ctx.sleep(600 * 2 ** attempt); continue; } throw new Error(`Network error talking to ${new URL(url).host}: ${e?.message || e}`); }
    if (res.ok) return (await res.json()) as T;
    if ((res.status === 429 || res.status >= 500) && attempt++ < retries) {
      const ra = Number(res.headers.get('retry-after')); await ctx.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 20) * 1000 : 700 * 2 ** attempt); continue;
    }
    throw new HttpError(res.status, url);
  }
}

export async function getText(ctx: Ctx, url: string, init: RequestInit = {}): Promise<string> {
  const res = await ctx.fetch(url, init);
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

export const enc = encodeURIComponent;
export const year = (d?: string) => { const m = String(d || '').match(/\b(19|20)\d{2}\b/); return m ? Number(m[0]) : undefined; };
export const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
export const cleanDoi = (d?: string | null) => (d ? d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim().toLowerCase() : undefined) || undefined;
