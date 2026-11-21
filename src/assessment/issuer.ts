// Assessment tokens for applicants. The applicant base keeps each person's full name; this module asks the
// assessment server for one access token per name and writes the token and its expiry into the same record.
// The server is the only place that decides who may take the assessment, how many tokens a day are allowed,
// and when a token expires. This code only carries the requests and results.
import type { CellValue, Field, FieldType, RecordRow } from '../core/types';

/** Fields created on demand in a base that has a "Full Name" field. */
export const TOKEN_FIELD_NAME = 'token';
export const EXPIRES_FIELD_NAME = 'token expires';
/** The server accepts at most this many names per request. */
export const ISSUE_BATCH = 20;

export interface IssuerConfig { baseUrl: string; issuerKey: string }
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Store functions the issuer needs. Passed in, so the logic can be tested without a browser. */
export interface IssuerIo {
  fetch: FetchLike;
  listFields(tableId: string): Promise<Field[]>;
  addField(tableId: string, spec: { name: string; type: FieldType }): Promise<Field>;
  getRecord(id: string): Promise<RecordRow | null | undefined>;
  updateRecord(id: string, cells: Record<string, CellValue>): Promise<RecordRow>;
}

export interface ServerResult {
  fullName: string;
  status: 'issued' | 'rejected';
  token?: string;
  expiresAt?: string;
  code?: string;
  message?: string;
  regenerated?: boolean;
  renamed?: boolean;
  contactEmail?: string | null;
}

/** One applicant as sent to the server. externalId is the record id: it keeps the same candidate through a rename. */
export interface IssuePerson { fullName: string; email?: string; externalId: string }

export interface ServerResponse { results: ServerResult[]; remainingToday: number; resetsAt: string; dailyCap?: number }

export interface IssueSummary {
  issued: number;
  skipped: { recordId: string; name: string; reason: string }[];
  remainingToday: number | null;
  resetsAt: string | null;
}

/** The base's name field: the field key "fullName" if set, otherwise a field called "Full Name". */
export function findNameField(fields: Field[]): Field | undefined {
  return fields.find((f) => f.key === 'fullName') ?? fields.find((f) => f.name.trim().toLowerCase() === 'full name');
}

/** The base's e-mail field, if it has one: the field key "email", otherwise a field called "Email". */
export function findEmailField(fields: Field[]): Field | undefined {
  return fields.find((f) => f.key === 'email') ?? fields.find((f) => f.name.trim().toLowerCase() === 'email');
}

/** Creates the "token" and "token expires" fields in the base if they are missing. Returns both. */
export async function ensureTokenFields(io: IssuerIo, tableId: string): Promise<{ token: Field; expires: Field }> {
  const fields = await io.listFields(tableId);
  const named = (name: string) => fields.find((f) => f.name.trim().toLowerCase() === name);
  const token = named(TOKEN_FIELD_NAME) ?? (await io.addField(tableId, { name: TOKEN_FIELD_NAME, type: 'text' }));
  const expires = named(EXPIRES_FIELD_NAME) ?? (await io.addField(tableId, { name: EXPIRES_FIELD_NAME, type: 'text' }));
  return { token, expires };
}

export function cellToText(value: CellValue): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

/** Maps the server's refusals to messages the person can act on. */
async function checkIssuerResponse(res: Response): Promise<void> {
  if (res.status === 401) throw new Error('The assessment server refused the issuer key. Check it in Settings → Assessment server.');
  if (res.status === 503) throw new Error('The assessment server has no issuer key configured (TOKEN_ISSUER_KEY).');
  if (!res.ok) {
    let msg = '';
    try { msg = ((await res.json()) as { message?: string }).message ?? ''; } catch { /* no body */ }
    throw new Error(`The assessment server returned ${res.status}${msg ? `: ${msg}` : ''}`);
  }
}

/** One request to the server for up to ISSUE_BATCH names. Errors carry a message suitable for the user. */
export async function requestTokens(io: Pick<IssuerIo, 'fetch'>, cfg: IssuerConfig, people: IssuePerson[], replace: boolean): Promise<ServerResponse> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/issuer/tokens`;
  const res = await io.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.issuerKey}` },
    body: JSON.stringify({ people, replace }),
  });
  await checkIssuerResponse(res);
  return (await res.json()) as ServerResponse;
}

/** Today's token count against the server's daily cap. */
export interface QuotaStatus { dailyCap: number; usedToday: number; remainingToday: number; resetsAt: string; lastResetAt: string | null }

/**
 * Reads today's count from the assessment server. With `reset`, the count starts again from now: tokens issued
 * before the reset stop counting toward the cap, but the server keeps the record of every token issued.
 */
export async function requestQuota(io: Pick<IssuerIo, 'fetch'>, cfg: IssuerConfig, reset: boolean): Promise<QuotaStatus> {
  if (!cfg.baseUrl.trim()) throw new Error('Set the assessment server address in Settings → Assessment server first.');
  if (!cfg.issuerKey.trim()) throw new Error('Set the token issuer key in Settings → Assessment server first.');
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/issuer/quota${reset ? '/reset' : ''}`;
  const res = await io.fetch(url, { method: reset ? 'POST' : 'GET', headers: { Authorization: `Bearer ${cfg.issuerKey}` } });
  await checkIssuerResponse(res);
  return (await res.json()) as QuotaStatus;
}

/**
 * Issues one token per selected record and writes it into the record. Records without a name, or whose
 * name the server refuses, are listed in `skipped` with the reason. Once the daily limit is reached, the
 * remaining records are skipped without further requests.
 */
export async function issueTokensForRecords(
  io: IssuerIo,
  cfg: IssuerConfig,
  tableId: string,
  recordIds: string[],
  opts: { replace?: boolean } = {},
): Promise<IssueSummary> {
  if (!cfg.baseUrl.trim()) throw new Error('Set the assessment server address in Settings → Assessment server first.');
  if (!cfg.issuerKey.trim()) throw new Error('Set the token issuer key in Settings → Assessment server first.');
  const fields = await io.listFields(tableId);
  const nameField = findNameField(fields);
  if (!nameField) throw new Error('This base has no "Full Name" field, so there are no names to issue tokens for.');
  const emailField = findEmailField(fields);

  const { token: tokenField, expires: expiresField } = await ensureTokenFields(io, tableId);
  const summary: IssueSummary = { issued: 0, skipped: [], remainingToday: null, resetsAt: null };

  // The record id travels with the name: the server keeps one candidate per record, so a corrected name is the same person.
  const items: { recordId: string; name: string; email: string }[] = [];
  for (const recordId of recordIds) {
    const record = await io.getRecord(recordId);
    if (!record) { summary.skipped.push({ recordId, name: '', reason: 'record not found' }); continue; }
    const name = cellToText(record.cells[nameField.id]);
    if (!name) { summary.skipped.push({ recordId, name: '', reason: 'no full name' }); continue; }
    const email = emailField ? cellToText(record.cells[emailField.id]) : '';
    items.push({ recordId, name, email });
  }

  let capReached = false;
  const pending: { recordId: string; token: string; expiresAt: string }[] = [];
  for (let i = 0; i < items.length; i += ISSUE_BATCH) {
    const batch = items.slice(i, i + ISSUE_BATCH);
    if (capReached) {
      for (const item of batch) summary.skipped.push({ recordId: item.recordId, name: item.name, reason: 'daily limit reached; issue these tomorrow' });
      continue;
    }
    const people: IssuePerson[] = batch.map((b) => ({ fullName: b.name, externalId: b.recordId, ...(b.email ? { email: b.email } : {}) }));
    const response = await requestTokens(io, cfg, people, opts.replace === true);
    summary.remainingToday = response.remainingToday;
    summary.resetsAt = response.resetsAt;
    batch.forEach((item, j) => {
      const result = response.results[j];
      if (result?.status === 'issued' && result.token && result.expiresAt) {
        summary.issued++;
        pending.push({ recordId: item.recordId, token: result.token, expiresAt: result.expiresAt });
      } else {
        summary.skipped.push({ recordId: item.recordId, name: item.name, reason: result?.message ?? 'not issued' });
        if (result?.code === 'daily_cap') capReached = true;
      }
    });
    while (pending.length) {
      const next = pending.shift()!;
      await io.updateRecord(next.recordId, { [tokenField.id]: next.token, [expiresField.id]: next.expiresAt });
    }
  }
  return summary;
}

