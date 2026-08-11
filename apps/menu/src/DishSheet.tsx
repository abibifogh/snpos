import { useState } from 'react';
import { Button, Modal, Textarea, FormError } from '@snpos/ui';
import { formatMoney, previewUrl } from '@snpos/core';
import type { MenuEntry, Settings, CartLine, CartAddon } from '@snpos/core';

/**
 * One dish, its options, and the quantity, the only screen where a customer
 * makes a decision that costs money, so the running price is always visible.
 */
export function DishSheet({
  entry,
  settings,
  onClose,
  onAdd,
}: {
  entry: MenuEntry;
  settings: Settings;
  onClose: () => void;
  onAdd: (line: CartLine) => void;
}) {
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string[]>>(() => {
    // Honour defaults so the common order is one tap away.
    const initial: Record<string, string[]> = {};
    for (const { group, options } of entry.groups) {
      initial[group.$id] = options.filter((o) => o.default_selected).map((o) => o.$id);
    }
    return initial;
  });

  const img = previewUrl(entry.item.image_id, 'menu', settings, 640, 420);

  const toggle = (groupId: string, optionId: string, maxSelect: number) => {
    setError(null);
    setChosen((c) => {
      const current = c[groupId] ?? [];
      if (current.includes(optionId)) return { ...c, [groupId]: current.filter((x) => x !== optionId) };
      // Picking a second when only one is allowed replaces rather than refuses:
      // refusing makes the customer deselect first, which reads as a bug.
      if (maxSelect <= 1) return { ...c, [groupId]: [optionId] };
      if (current.length >= maxSelect) return c;
      return { ...c, [groupId]: [...current, optionId] };
    });
  };

  const addons: CartAddon[] = entry.groups.flatMap(({ group, options }) =>
    (chosen[group.$id] ?? []).flatMap((id) => {
      const option = options.find((o) => o.$id === id);
      return option
        ? [{ option_id: option.$id, group_id: group.$id, name: option.name, price_delta: option.price_delta }]
        : [];
    }),
  );

  const unitPrice = entry.price + addons.reduce((s, a) => s + a.price_delta, 0);

  const add = () => {
    for (const { group } of entry.groups) {
      const picked = (chosen[group.$id] ?? []).length;
      if (group.required && picked < Math.max(1, group.min_select)) {
        setError(`Please choose ${group.name.toLowerCase()}.`);
        return;
      }
      if (!group.required && group.min_select > 0 && picked > 0 && picked < group.min_select) {
        setError(`Choose at least ${group.min_select} from ${group.name.toLowerCase()}.`);
        return;
      }
    }
    onAdd({
      key: `${entry.item.$id}-${Date.now()}`,
      menu_item_id: entry.item.$id,
      name: entry.item.name,
      unit_price: entry.price,
      qty,
      addons,
      notes: notes.trim() || undefined,
      station: entry.station,
      station_key: entry.stationKey,
    });
  };

  return (
    <Modal
      title={entry.item.name}
      onClose={onClose}
      footer={
        <div className="spread" style={{ width: '100%' }}>
          <div className="qty">
            <button onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Fewer">−</button>
            <span>{qty}</span>
            <button onClick={() => setQty((q) => q + 1)} aria-label="More">+</button>
          </div>
          <Button variant="primary" onClick={add}>
            Add · {formatMoney(unitPrice * qty, settings)}
          </Button>
        </div>
      }
    >
      <FormError message={error} />
      {img && (
        <img
          src={img}
          alt=""
          style={{ width: '100%', borderRadius: 'var(--radius-sm)', marginBottom: '1rem', display: 'block' }}
        />
      )}
      {entry.item.description && <p style={{ marginTop: 0 }}>{entry.item.description}</p>}

      {entry.groups.map(({ group, options }) => (
        <div key={group.$id} style={{ marginTop: '1.2rem' }}>
          <h3>
            {group.name}{' '}
            <span className="dim small" style={{ fontWeight: 400 }}>
              {group.required ? '· required' : group.max_select > 1 ? `· up to ${group.max_select}` : '· optional'}
            </span>
          </h3>
          {group.description && <p className="small dim" style={{ margin: '0.2rem 0 0.4rem' }}>{group.description}</p>}
          {options.map((o) => {
            const on = (chosen[group.$id] ?? []).includes(o.$id);
            return (
              <label className="opt-row" key={o.$id}>
                <span>
                  {o.name}
                  {o.price_delta > 0 && <span className="dim"> +{formatMoney(o.price_delta, settings)}</span>}
                </span>
                <input
                  type={group.max_select <= 1 ? 'radio' : 'checkbox'}
                  name={group.$id}
                  checked={on}
                  onChange={() => toggle(group.$id, o.$id, group.max_select)}
                />
              </label>
            );
          })}
        </div>
      ))}

      <div style={{ marginTop: '1.2rem' }}>
        <h3>Anything else?</h3>
        <Textarea
          placeholder="No onions, extra spicy…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ marginTop: '0.4rem' }}
        />
      </div>

    </Modal>
  );
}
