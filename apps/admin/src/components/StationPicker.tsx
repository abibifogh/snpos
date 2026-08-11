import { useEffect, useState } from 'react';
import { Field, Select } from '@snpos/ui';
import { listAll } from '../lib';
import type { StationDoc } from '@snpos/core';

/**
 * Load the stations the restaurant actually defined.
 *
 * Every screen that asks "where is this cooked?" reads from here, so there is
 * one list and it is the admin's list. Nothing is invented on their behalf.
 */
export function useStations() {
  const [stations, setStations] = useState<StationDoc[] | null>(null);

  useEffect(() => {
    listAll<StationDoc>('stations')
      .then((r) => setStations(r.sort((a, b) => a.sort - b.sort)))
      .catch(() => setStations([]));
  }, []);

  return stations;
}

/**
 * The four stations the system was born with. Only ever shown for a dish that
 * still points at one of them and whose restaurant has since defined its own, 
 * otherwise the old value would silently vanish from the dropdown and get
 * overwritten on the next save.
 */
const LEGACY = ['hot', 'cold', 'bar', 'dessert'];
const legacyLabel: Record<string, string> = {
  hot: 'Hot line (built-in)',
  cold: 'Cold (built-in)',
  bar: 'Bar (built-in)',
  dessert: 'Desserts (built-in)',
};

/** The legacy enum value to store alongside a chosen key, for old readers. */
export const legacyStationFor = (key: string): 'hot' | 'cold' | 'bar' | 'dessert' =>
  (LEGACY.includes(key) ? key : 'hot') as 'hot' | 'cold' | 'bar' | 'dessert';

export function StationPicker({
  stations,
  value,
  onChange,
  inheritLabel,
  label = 'Kitchen station',
  hint,
}: {
  stations: StationDoc[] | null;
  /** The chosen station key. Empty string means "no station of its own". */
  value: string;
  onChange: (key: string) => void;
  /** Text for the empty option. Omit to make choosing a station compulsory. */
  inheritLabel?: string;
  label?: string;
  hint?: string;
}) {
  const defined = stations ?? [];
  // Keep an old value selectable even if the restaurant never defined it, so
  // opening a dish to change its price does not quietly move it to another
  // station.
  const orphan = value && !defined.some((s) => s.key === value) ? value : null;

  if (stations && defined.length === 0) {
    return (
      <Field
        label={label}
        hint="No stations set up yet. Add them under Kitchen → Stations, then come back and choose one. Until then everything goes to one queue."
      >
        <Select value="" disabled>
          <option value="">The whole kitchen</option>
        </Select>
      </Field>
    );
  }

  return (
    <Field
      label={label}
      hint={
        orphan
          ? 'This is still on one of the built-in stations from before you set up your own. Pick one of yours and save.'
          : hint
      }
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {inheritLabel && <option value="">{inheritLabel}</option>}
        {defined.map((s) => (
          <option key={s.key} value={s.key}>
            {s.name}
          </option>
        ))}
        {orphan && <option value={orphan}>{legacyLabel[orphan] ?? orphan}</option>}
      </Select>
    </Field>
  );
}
