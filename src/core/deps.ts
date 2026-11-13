// Field dependencies. A lookup field can read other fields (name, institution, an upstream publication field …); formulas read fields too.
// This module builds the graph, orders the work so upstream fields run first, and explains why a downstream field was skipped.
import type { Field } from './types';
import { referencedFields } from './formula';

export interface Edge { from: string; to: string; why: string }   // `to` depends on `from`

export function dependenciesOf(f: Field, fields: Field[]): { fieldId: string; why: string }[] {
  const out: { fieldId: string; why: string }[] = [];
  const add = (id: string | undefined, why: string) => { if (id && id !== f.id && fields.some(x => x.id === id)) out.push({ fieldId: id, why }); };
  const l = f.lookup;
  if (l) {
    add(l.nameFieldId, 'author name'); add(l.institutionFieldId, 'institution'); add(l.profileUrlFieldId, 'profile URL'); add(l.keywordsFieldId, 'keywords');
    add(l.fromFieldId, 'upstream publication');
    for (const d of l.dependsOn || []) add(d, 'must not be empty');
  }
  if (f.type === 'formula' && f.options?.formula) {
    const byName = new Map(fields.map(x => [x.name.trim().toLowerCase(), x.id]));
    try { for (const n of referencedFields(f.options.formula)) add(byName.get(n.trim().toLowerCase()), 'formula reference'); } catch { /* invalid formulas are reported elsewhere */ }
  }
  return out;
}

export function dependencyEdges(fields: Field[]): Edge[] {
  return fields.flatMap(f => dependenciesOf(f, fields).map(d => ({ from: d.fieldId, to: f.id, why: d.why })));
}

export class CycleError extends Error { constructor(public path: string[]) { super(`Circular dependency: ${path.join(' → ')}`); } }

/** Ids of the fields that need work (`only`), upstream first. Throws CycleError on a loop. */
export function topologicalOrder(fields: Field[], only?: (f: Field) => boolean): string[] {
  const byId = new Map(fields.map(f => [f.id, f]));
  const state = new Map<string, 0 | 1 | 2>(); const order: string[] = [];
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const visit = (id: string, stack: string[]) => {
    const st = state.get(id);
    if (st === 2) return;
    if (st === 1) throw new CycleError([...stack.slice(stack.indexOf(id)), id].map(nameOf));
    state.set(id, 1);
    const f = byId.get(id)!;
    for (const d of dependenciesOf(f, fields)) visit(d.fieldId, [...stack, id]);
    state.set(id, 2);
    if (!only || only(f)) order.push(id);
  };
  for (const f of fields) visit(f.id, []);
  return order;
}

/** Validation messages for the field manager (missing upstream, cycles, formula syntax is checked elsewhere). */
export function validateDependencies(fields: Field[]): string[] {
  const msgs: string[] = [];
  try { topologicalOrder(fields); } catch (e) { if (e instanceof CycleError) msgs.push(e.message); }
  for (const f of fields) {
    const l = f.lookup; if (!l) continue;
    if (l.kind === 'search' && !l.nameFieldId) msgs.push(`“${f.name}” needs a name field to search with.`);
    if (l.kind !== 'search' && !l.fromFieldId) msgs.push(`“${f.name}” needs an upstream publication field.`);
    if (l.fromFieldId) { const up = fields.find(x => x.id === l.fromFieldId); if (!up) msgs.push(`“${f.name}” points at a field that no longer exists.`); else if (up.lookup?.kind !== 'search') msgs.push(`“${f.name}” must read from a publication search field, but “${up.name}” is not one.`); }
  }
  return msgs;
}
