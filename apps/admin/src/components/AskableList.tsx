import { useMemo, useState } from 'react';
import { Button, Input, Modal, Notice, Badge } from '@snpos/ui';
import { saveDropping, isRunningLow, MODULE_LABELS } from '@snpos/core';
import type { Ingredient, Module } from '@snpos/core';
import { humanError } from '../lib';

/**
 * Which stock items the kitchen or the bar may ask for, from its Need stock
 * button, chosen in one go.
 *
 * Nothing is on that list until somebody ticks it here (or on the item's
 * own form): the stock list carries gas, cleaning cloths and the owner's
 * coffee as well as rice and oil, and the pass should be offered what it is
 * meant to ask for. See stock-requests.ts.
 */
export function AskableList({ items, module, lowBp, onClose, onSaved }: {
  items: Ingredient[];
  module: Module;
  lowBp: number;
  onClose: () => void;
  onSaved: (changed: number) => void;
}) {
  const mine = useMemo(
    () => items.filter((i) => i.active !== false && (i.module ?? 'kitchen') === module).sort((a, b) => a.name.localeCompare(b.name)),
    [items, module],
  );
  const [on, setOn] = useState<Set<string>>(() => new Set(mine.filter((i) => i.requestable === true).map((i) => i.$id)));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const shown = mine.filter((i) => !q || i.name.toLowerCase().includes(q));
  const changed = mine.filter((i) => (i.requestable === true) !== on.has(i.$id));
  const side = MODULE_LABELS[module].toLowerCase();

  const set = (ids: string[], value: boolean) => setOn((cur) => {
    const next = new Set(cur);
    for (const id of ids) { if (value) next.add(id); else next.delete(id); }
    return next;
  });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const i of changed) {
        const { dropped } = await saveDropping('ingredients', i.$id, { requestable: on.has(i.$id) });
        if (dropped.includes('requestable')) {
          throw new Error('The database does not have this setting yet. Run "Provision Appwrite" from the Actions tab on GitHub, then try again.');
        }
      }
      onSaved(changed.length);
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`What the ${side} can ask for`}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={changed.length === 0} onClick={() => void save()}>
            {changed.length === 0 ? 'Nothing changed' : `Save ${changed.length} change${changed.length === 1 ? '' : 's'}`}
          </Button>
        </>
      )}
    >
      <p className="small dim" style={{ marginTop: 0 }}>
        Ticked items appear on the {side}&apos;s Need stock list: when they run low they are offered first, and the rest
        can be searched and added. Nothing else can be asked for, except in the note.
      </p>
      {error && <Notice>{error}</Notice>}
      <div className="row" style={{ gap: '0.5rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 14rem' }}>
          <Input type="search" value={query} placeholder="Search" aria-label="Search the stock list" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Button size="sm" onClick={() => set(shown.map((i) => i.$id), true)}>Tick {q ? 'these' : 'all'}</Button>
        <Button size="sm" variant="ghost" onClick={() => set(shown.map((i) => i.$id), false)}>Untick {q ? 'these' : 'all'}</Button>
      </div>
      <div className="small dim" style={{ marginBottom: '0.4rem' }}>{on.size} of {mine.length} ticked</div>
      <div style={{ display: 'grid', gap: '0.15rem', maxHeight: '50vh', overflowY: 'auto' }}>
        {shown.map((i) => (
          <label key={i.$id} className="row" style={{ gap: '0.6rem', padding: '0.4rem 0.2rem', cursor: 'pointer', alignItems: 'center' }}>
            <input type="checkbox" checked={on.has(i.$id)} onChange={(e) => set([i.$id], e.target.checked)} />
            <span style={{ flex: 1 }}>{i.name}</span>
            {isRunningLow(i as never, lowBp) && <Badge tone="warn">Low now</Badge>}
          </label>
        ))}
        {shown.length === 0 && <p className="small dim">Nothing matches.</p>}
      </div>
    </Modal>
  );
}
