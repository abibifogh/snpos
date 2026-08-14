import { useState } from 'react';
import { Button, Modal, Notice } from '@snpos/ui';
import { formatMoney } from '@snpos/core';
import type { CartAddon, MenuEntry, Settings } from '@snpos/core';

/**
 * The choices on a dish, asked at the counter.
 *
 * The customer menu has asked this since the beginning; the till never did.
 * A dish set up with a spice level or a choice of side got neither when a
 * member of staff rang it up, so the kitchen ticket for a walk-in arrived
 * without the one thing that says how to cook it — not because the ticket was
 * hiding it, but because nobody had been asked.
 *
 * Deliberately not the customer's sheet reused. That one is a phone screen
 * built for somebody browsing: pictures, descriptions, room to think. This is
 * somebody standing at a counter with a queue behind them, so it is big
 * targets, every group on one screen, and no scrolling for the common case.
 * The rules about what may be picked are the same rules, because they are the
 * kitchen's rules and not the device's.
 */
export function OptionSheet({
  entry,
  settings,
  onCancel,
  onAdd,
}: {
  entry: MenuEntry;
  settings: Settings;
  onCancel: () => void;
  onAdd: (addons: CartAddon[]) => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string[]>>(() => {
    // Whatever the kitchen set as usual, already ticked. Most orders are the
    // usual, and starting from blank makes staff re-enter the default all day.
    const start: Record<string, string[]> = {};
    for (const { group, options } of entry.groups) {
      const defaults = options.filter((o) => o.active && o.default_selected).map((o) => o.$id);
      if (defaults.length) start[group.$id] = defaults.slice(0, Math.max(1, group.max_select || 1));
    }
    return start;
  });
  const [error, setError] = useState<string | null>(null);

  const toggle = (groupId: string, optionId: string, maxSelect: number) => {
    setError(null);
    setChosen((c) => {
      const current = c[groupId] ?? [];
      if (current.includes(optionId)) return { ...c, [groupId]: current.filter((x) => x !== optionId) };
      // Picking a second when only one is allowed replaces rather than
      // refuses, the same as the customer's sheet: refusing makes somebody
      // deselect first, which at a counter reads as the screen being stuck.
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

  const extra = addons.reduce((s, a) => s + a.price_delta, 0);

  const confirm = () => {
    for (const { group } of entry.groups) {
      const picked = (chosen[group.$id] ?? []).length;
      if (group.required && picked < Math.max(1, group.min_select)) {
        setError(`Choose ${group.name.toLowerCase()}.`);
        return;
      }
      if (!group.required && group.min_select > 0 && picked > 0 && picked < group.min_select) {
        setError(`Choose at least ${group.min_select} from ${group.name.toLowerCase()}.`);
        return;
      }
    }
    onAdd(addons);
  };

  return (
    <Modal
      title={entry.item.name}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={confirm}>
            Add{extra !== 0 ? ` · ${formatMoney(entry.price + extra, settings)}` : ''}
          </Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '0.8rem' }}><Notice>{error}</Notice></div>}

      {entry.groups.map(({ group, options }) => {
        const max = Math.max(1, group.max_select || 1);
        const picked = chosen[group.$id] ?? [];
        return (
          <div key={group.$id} style={{ marginBottom: '1rem' }}>
            <div className="spread" style={{ marginBottom: '0.4rem' }}>
              <strong>{group.name}</strong>
              <span className="small dim">
                {group.required ? 'Required' : 'Optional'}
                {max > 1 ? ` · up to ${max}` : ''}
              </span>
            </div>
            <div className="menu-grid">
              {options.filter((o) => o.active).map((o) => {
                const on = picked.includes(o.$id);
                return (
                  <button
                    key={o.$id}
                    type="button"
                    className="menu-card"
                    style={on ? { borderColor: 'var(--accent)', background: 'var(--accent-soft, #2b2415)' } : undefined}
                    onClick={() => toggle(group.$id, o.$id, max)}
                    aria-pressed={on}
                  >
                    <div className="n">{on ? '✓ ' : ''}{o.name}</div>
                    {o.price_delta !== 0 && (
                      <div className="p">
                        {o.price_delta > 0 ? '+' : '−'}{formatMoney(Math.abs(o.price_delta), settings)}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </Modal>
  );
}
