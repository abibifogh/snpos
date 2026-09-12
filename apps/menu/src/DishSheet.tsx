import { useState } from 'react';
import { Button, Modal, Textarea, FormError, Notice } from '@snpos/ui';
import {
  formatMoney, previewUrl, parseOmissions, omissionWords, tagsWithout,
  tagsWithOptions, dietLostWords, dietUnknownWords,
} from '@snpos/core';
import type { MenuEntry, Settings, CartLine, CartAddon } from '@snpos/core';
import { DietTags } from './DietTags';
import { QtyBox } from './QtyBox';

/**
 * One dish, its options, and the quantity, the only screen where a customer
 * makes a decision that costs money, so the running price is always visible.
 */
export function DishSheet({
  entry,
  settings,
  showDiet,
  onClose,
  onAdd,
}: {
  entry: MenuEntry;
  settings: Settings;
  /** Say what this dish is safe for. See DietTags. */
  showDiet?: boolean;
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

  /*
    What this dish can be made without, and what the guest has asked to leave out.

    An omission is not an add-on: it costs nothing and takes something away.
    It rides on the line as an add-on shaped entry all the same, because that
    is what already reaches the kitchen ticket, the bill and the order history
    — so "no momoni" prints beside the dish with nothing new plumbed for it.
  */
  const omissions = parseOmissions(entry.item.omissions);
  const [without, setWithout] = useState<string[]>([]);
  const withoutTags = tagsWithout(entry.item.tags, omissions, without);

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

  /*
    What the plate is once the choices are on it.

    A vegan bowl with cheese ticked is not a vegan bowl, and the pills above
    used to go on saying vegan the whole way to the pass. They change as the
    boxes are ticked now, and what a choice cost is said in words underneath —
    a guest who watches "Vegan" disappear has been told something; one who does
    not notice has been misled by a screen that knew.
  */
  const chosenOptions = entry.groups.flatMap(({ group, options }) =>
    (chosen[group.$id] ?? []).flatMap((id) => {
      const option = options.find((o) => o.$id === id);
      return option
        ? [{ name: option.name, tags: option.tags, diet_neutral: option.diet_neutral }]
        : [];
    }));
  const withOptions = tagsWithOptions(withoutTags, chosenOptions);
  const nowTags = withOptions.tags;
  const lost = dietLostWords(withoutTags, nowTags);
  const unsure = dietUnknownWords(withOptions.unknown);

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
      addons: [
        ...addons,
        // Priced at nothing, so the total is untouched, and named the way the
        // pass reads it out.
        ...omissions
          .filter((o) => without.includes(o.key))
          .map((o) => ({ option_id: `omit-${o.key}`, group_id: 'omit', name: `No ${o.name}`, price_delta: 0 })),
      ],
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
          <QtyBox qty={qty} onChange={setQty} label={entry.item.name} />
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
      {/* The tags follow the switches below: tick "leave out the momoni" and
          the dish says vegetarian there and then, which is the confirmation
          the guest came for. */}
      {showDiet && <DietTags tags={nowTags} />}
      {/* Said where the choice was made, not discovered at the table. */}
      {showDiet && lost && <Notice tone="warn">{lost}</Notice>}
      {showDiet && unsure && <Notice tone="warn">{unsure}</Notice>}

      {omissions.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <h3>Can be made without</h3>
          {omissions.map((o) => (
            <label className="opt-row" key={o.key}>
              <span>{omissionWords(o)}</span>
              <input
                type="checkbox"
                checked={without.includes(o.key)}
                onChange={() => setWithout((w) => (
                  w.includes(o.key) ? w.filter((k) => k !== o.key) : [...w, o.key]
                ))}
              />
            </label>
          ))}
        </div>
      )}

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
