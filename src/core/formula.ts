// Airtable-style formulas, evaluated by a small hand-written tokenizer + recursive-descent parser + interpreter.
// There is deliberately NO eval() / new Function(): a formula can only call the functions listed in FUNCTIONS.
//
//   IF(IS_NOT_EMPTY({Email}), "Ready", "Missing Email")
//   CONCATENATE({First Name}, " ", {Last Name})        {First Name} & " " & UPPER(LEFT({Last Name}, 3))

export class FormulaError extends Error {
  constructor(message: string, public pos = 0) { super(message); }
}

export type FValue = string | number | boolean | null | Date;

type Tok = { t: 'num' | 'str' | 'ref' | 'id' | 'op' | 'lp' | 'rp' | 'comma' | 'eof'; v: string; pos: number };
export type Node =
  | { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'ref'; name: string } | { k: 'bool'; v: boolean }
  | { k: 'un'; op: string; a: Node } | { k: 'bin'; op: string; a: Node; b: Node } | { k: 'call'; name: string; args: Node[]; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '{') { const j = src.indexOf('}', i); if (j < 0) throw new FormulaError('Missing closing } for a field name', i); out.push({ t: 'ref', v: src.slice(i + 1, j).trim(), pos: i }); i = j + 1; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; } else s += src[j++]; }
      if (j >= src.length) throw new FormulaError('Text is missing its closing quote', i);
      out.push({ t: 'str', v: s, pos: i }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) { let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++; out.push({ t: 'num', v: src.slice(i, j), pos: i }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++; out.push({ t: 'id', v: src.slice(i, j), pos: i }); i = j; continue; }
    if (c === '(') { out.push({ t: 'lp', v: c, pos: i }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp', v: c, pos: i }); i++; continue; }
    if (c === ',') { out.push({ t: 'comma', v: c, pos: i }); i++; continue; }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '!=', '<>'].includes(two)) { out.push({ t: 'op', v: two === '<>' ? '!=' : two, pos: i }); i += 2; continue; }
    if ('+-*/&=<>'.includes(c)) { out.push({ t: 'op', v: c, pos: i }); i++; continue; }
    throw new FormulaError(`Unexpected character “${c}”`, i);
  }
  out.push({ t: 'eof', v: '', pos: src.length });
  return out;
}

// precedence: comparison < concat(&) < additive < multiplicative < unary
export function parse(src: string): Node {
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p]; const next = () => toks[p++];
  const isOp = (...ops: string[]) => peek().t === 'op' && ops.includes(peek().v);
  function comparison(): Node { let a = concat(); while (isOp('=', '!=', '<', '>', '<=', '>=')) { const op = next().v; a = { k: 'bin', op, a, b: concat() }; } return a; }
  function concat(): Node { let a = additive(); while (isOp('&')) { next(); a = { k: 'bin', op: '&', a, b: additive() }; } return a; }
  function additive(): Node { let a = mult(); while (isOp('+', '-')) { const op = next().v; a = { k: 'bin', op, a, b: mult() }; } return a; }
  function mult(): Node { let a = unary(); while (isOp('*', '/')) { const op = next().v; a = { k: 'bin', op, a, b: unary() }; } return a; }
  function unary(): Node { if (isOp('-')) { next(); return { k: 'un', op: '-', a: unary() }; } return primary(); }
  function primary(): Node {
    const t = next();
    if (t.t === 'num') return { k: 'num', v: Number(t.v) };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'ref') return { k: 'ref', name: t.v };
    if (t.t === 'lp') { const e = comparison(); if (next().t !== 'rp') throw new FormulaError('Missing )', t.pos); return e; }
    if (t.t === 'id') {
      const up = t.v.toUpperCase();
      if (peek().t === 'lp') {
        next(); const args: Node[] = [];
        if (peek().t !== 'rp') { for (;;) { args.push(comparison()); if (peek().t === 'comma') { next(); continue; } break; } }
        if (next().t !== 'rp') throw new FormulaError(`Missing ) after ${up}(`, t.pos);
        return { k: 'call', name: up, args, pos: t.pos };
      }
      if (up === 'TRUE') return { k: 'bool', v: true };
      if (up === 'FALSE') return { k: 'bool', v: false };
      throw new FormulaError(`“${t.v}” is not a function or value. Field names go in {braces}.`, t.pos);
    }
    throw new FormulaError(t.t === 'eof' ? 'The formula ends too early' : `Unexpected “${t.v}”`, t.pos);
  }
  const ast = comparison();
  if (peek().t !== 'eof') throw new FormulaError(`Unexpected “${peek().v}”`, peek().pos);
  return ast;
}

/** Names of every {Field} the formula reads (for dependency tracking and validation). */
export function referencedFields(src: string): string[] {
  const names = new Set<string>();
  const walk = (n: Node) => { if (n.k === 'ref') names.add(n.name); else if (n.k === 'un') walk(n.a); else if (n.k === 'bin') { walk(n.a); walk(n.b); } else if (n.k === 'call') n.args.forEach(walk); };
  walk(parse(src)); return [...names];
}

const isEmptyV = (v: FValue) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const str = (v: FValue): string => (v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
const num = (v: FValue): number => { if (typeof v === 'number') return v; if (typeof v === 'boolean') return v ? 1 : 0; const n = Number(String(v ?? '').trim()); if (Number.isNaN(n)) throw new FormulaError(`“${str(v)}” is not a number`); return n; };
const truthy = (v: FValue) => (typeof v === 'string' ? v !== '' && v.toLowerCase() !== 'false' : !!v);
const dateOf = (v: FValue) => (v instanceof Date ? v : new Date(str(v)));

type Ctx = { now: Date };
const FUNCTIONS: Record<string, { min: number; max: number; lazy?: boolean; fn: (a: any[], ctx: Ctx) => FValue }> = {
  IF: { min: 2, max: 3, lazy: true, fn: () => null },   // handled in evaluate (lazy branches)
  AND: { min: 1, max: 99, fn: a => a.every(truthy) },
  OR: { min: 1, max: 99, fn: a => a.some(truthy) },
  NOT: { min: 1, max: 1, fn: a => !truthy(a[0]) },
  CONCATENATE: { min: 1, max: 99, fn: a => a.map(str).join('') },
  CONCAT: { min: 1, max: 99, fn: a => a.map(str).join('') },
  LOWER: { min: 1, max: 1, fn: a => str(a[0]).toLowerCase() },
  UPPER: { min: 1, max: 1, fn: a => str(a[0]).toUpperCase() },
  TRIM: { min: 1, max: 1, fn: a => str(a[0]).trim().replace(/\s+/g, ' ') },
  LEFT: { min: 2, max: 2, fn: a => str(a[0]).slice(0, Math.max(0, num(a[1]))) },
  RIGHT: { min: 2, max: 2, fn: a => { const s = str(a[0]); const n = Math.max(0, num(a[1])); return n === 0 ? '' : s.slice(-n); } },
  MID: { min: 3, max: 3, fn: a => str(a[0]).substr(Math.max(0, num(a[1]) - 1), Math.max(0, num(a[2]))) },
  LEN: { min: 1, max: 1, fn: a => str(a[0]).length },
  FIND: { min: 2, max: 3, fn: a => { const start = a[2] != null ? Math.max(0, num(a[2]) - 1) : 0; const i = str(a[1]).indexOf(str(a[0]), start); return i < 0 ? 0 : i + 1; } },
  SUBSTITUTE: { min: 3, max: 3, fn: a => (str(a[1]) === '' ? str(a[0]) : str(a[0]).split(str(a[1])).join(str(a[2]))) },
  IS_EMPTY: { min: 1, max: 1, fn: a => isEmptyV(a[0]) },
  IS_NOT_EMPTY: { min: 1, max: 1, fn: a => !isEmptyV(a[0]) },
  TODAY: { min: 0, max: 0, fn: (_a, c) => new Date(Date.UTC(c.now.getFullYear(), c.now.getMonth(), c.now.getDate())) },
  NOW: { min: 0, max: 0, fn: (_a, c) => c.now },
  // a few conveniences beyond the required list
  ROUND: { min: 1, max: 2, fn: a => { const d = a[1] != null ? num(a[1]) : 0; const f = 10 ** d; return Math.round(num(a[0]) * f) / f; } },
  ABS: { min: 1, max: 1, fn: a => Math.abs(num(a[0])) },
  VALUE: { min: 1, max: 1, fn: a => num(a[0]) },
  YEAR: { min: 1, max: 1, fn: a => dateOf(a[0]).getUTCFullYear() },
  DATETIME_DIFF_DAYS: { min: 2, max: 2, fn: a => Math.round((dateOf(a[0]).getTime() - dateOf(a[1]).getTime()) / 86400000) },
  BLANK: { min: 0, max: 0, fn: () => '' },
};
export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS).filter(n => n !== 'IF').concat('IF').sort();

function evaluateNode(n: Node, resolve: (name: string) => FValue, ctx: Ctx): FValue {
  switch (n.k) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'bool': return n.v;
    case 'ref': return resolve(n.name);
    case 'un': return -num(evaluateNode(n.a, resolve, ctx));
    case 'bin': {
      const a = evaluateNode(n.a, resolve, ctx); const b = evaluateNode(n.b, resolve, ctx);
      switch (n.op) {
        case '+': return num(a) + num(b);
        case '-': return num(a) - num(b);
        case '*': return num(a) * num(b);
        case '/': { const d = num(b); if (d === 0) throw new FormulaError('Division by zero'); return num(a) / d; }
        case '&': return str(a) + str(b);
        case '=': return str(a) === str(b);
        case '!=': return str(a) !== str(b);
        default: { const bothNum = !Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) && a !== '' && b !== ''; const x = bothNum ? Number(a) : str(a); const y = bothNum ? Number(b) : str(b); return n.op === '<' ? x < y : n.op === '>' ? x > y : n.op === '<=' ? x <= y : x >= y; }
      }
    }
    case 'call': {
      const f = FUNCTIONS[n.name];
      if (!f) throw new FormulaError(`Unknown function ${n.name}()`, n.pos);
      if (n.args.length < f.min || n.args.length > f.max) throw new FormulaError(`${n.name}() takes ${f.min === f.max ? f.min : `${f.min}–${f.max}`} argument(s), not ${n.args.length}`, n.pos);
      if (n.name === 'IF') { const c = evaluateNode(n.args[0], resolve, ctx); return truthy(c) ? evaluateNode(n.args[1], resolve, ctx) : n.args[2] ? evaluateNode(n.args[2], resolve, ctx) : ''; }
      return f.fn(n.args.map(a => evaluateNode(a, resolve, ctx)), ctx);
    }
  }
}

export interface FormulaResult { value: FValue; error?: string }

/** Evaluate a formula. Never throws: errors come back as { value: null, error }. `resolve` maps a field name to its value. */
export function evaluateFormula(src: string, resolve: (name: string) => FValue, now = new Date()): FormulaResult {
  try { return { value: evaluateNode(parse(src), resolve, { now }) }; }
  catch (e: any) { return { value: null, error: e instanceof FormulaError ? e.message : String(e?.message || e) }; }
}

export const formatFValue = (v: FValue): string => (v instanceof Date ? v.toISOString().slice(0, v.getUTCHours() + v.getUTCMinutes() === 0 ? 10 : 16).replace('T', ' ') : str(v));
