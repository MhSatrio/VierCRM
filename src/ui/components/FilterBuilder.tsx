// Edits a ConditionGroup (AND / OR / NOT with nested groups) – used by views and by automation conditions.
import React from 'react';
import type { Condition, ConditionGroup, Field, Op } from '../../core/types';
import { NO_VALUE, OP_LABEL, opsForType, cond } from '../../core/filters';

const isGroup = (x: Condition | ConditionGroup): x is ConditionGroup => x.kind === 'group';

function ConditionRow({ c, fields, onChange, onRemove }: { c: Condition; fields: Field[]; onChange(c: Condition): void; onRemove(): void }) {
  const f = fields.find(x => x.id === c.fieldId) ?? fields[0];
  if (!f) return null;
  const ops = opsForType(f.type); const choices = f.options?.choices;
  return (
    <div className="rule">
      <select aria-label="Field" value={f.id} onChange={e => { const nf = fields.find(x => x.id === e.target.value)!; onChange({ ...c, fieldId: nf.id, op: opsForType(nf.type)[0], value: '' }); }}>{fields.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      <select aria-label="Condition" value={c.op} onChange={e => onChange({ ...c, op: e.target.value as Op })}>{ops.map(o => <option key={o} value={o}>{OP_LABEL[o]}</option>)}</select>
      {!NO_VALUE.includes(c.op) && (choices?.length && (c.op === 'is' || c.op === 'isNot')
        ? <select aria-label="Value" value={String(c.value ?? '')} onChange={e => onChange({ ...c, value: e.target.value })}><option value="">—</option>{choices.map(x => <option key={x.id} value={x.name}>{x.name}</option>)}</select>
        : <input aria-label="Value" type={f.type === 'number' ? 'number' : f.type === 'date' ? 'text' : 'text'} placeholder={f.type === 'date' ? 'YYYY-MM-DD or today' : 'value'} value={String(c.value ?? '')} onChange={e => onChange({ ...c, value: e.target.value })} />)}
      <button className="ghost sm" aria-label="Remove condition" onClick={onRemove}>✕</button>
    </div>
  );
}

export function FilterBuilder({ group, fields, onChange, depth = 0 }: { group: ConditionGroup; fields: Field[]; onChange(g: ConditionGroup): void; depth?: number }) {
  const set = (items: ConditionGroup['items']) => onChange({ ...group, items });
  const firstField = fields.find(f => f.type !== 'attachment') ?? fields[0];
  if (!firstField) return <div className="muted small">Loading fields…</div>;
  return (
    <div style={depth ? { borderLeft: '3px solid var(--light)', paddingLeft: 10, margin: '6px 0' } : undefined}>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="muted small">{group.not ? 'NOT ' : ''}Show records where</span>
        <select aria-label="Match" value={group.match} onChange={e => onChange({ ...group, match: e.target.value as 'and' | 'or' })}><option value="and">ALL conditions are true (AND)</option><option value="or">ANY condition is true (OR)</option></select>
        <label className="chk small"><input type="checkbox" checked={!!group.not} onChange={e => onChange({ ...group, not: e.target.checked })} />NOT</label>
        {depth > 0 && <span className="muted small">(group)</span>}
      </div>
      {group.items.map((it, i) => isGroup(it)
        ? <div key={i} className="row" style={{ alignItems: 'flex-start' }}><div className="grow"><FilterBuilder group={it} fields={fields} depth={depth + 1} onChange={g => set(group.items.map((x, j) => (j === i ? g : x)))} /></div><button className="ghost sm" aria-label="Remove group" onClick={() => set(group.items.filter((_, j) => j !== i))}>✕</button></div>
        : <ConditionRow key={i} c={it} fields={fields} onChange={c => set(group.items.map((x, j) => (j === i ? c : x)))} onRemove={() => set(group.items.filter((_, j) => j !== i))} />)}
      <div className="row"><button className="sm" onClick={() => set([...group.items, cond(firstField.id, 'isNotEmpty')])}>+ Condition</button>{depth < 2 && <button className="sm" onClick={() => set([...group.items, { kind: 'group', match: 'or', items: [cond(firstField.id, 'isNotEmpty')] }])}>+ Group</button>}</div>
    </div>
  );
}
