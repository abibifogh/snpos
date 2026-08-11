import { modulesOf } from '@snpos/core';
import type { Module, Settings } from '@snpos/core';

export type Side = Module | 'all';

/**
 * Which side of the business a list is showing.
 *
 * Only rendered where there is a choice: a business running one side has
 * nothing to filter, and a row of buttons that never changes anything is a row
 * somebody learns to ignore — along with the next one, which does matter.
 *
 * "Both" leads because the question an owner asks first is what the whole
 * business did. The split is the second question, and it is one tap away.
 */
export function SideFilter({
  value, onChange, settings,
}: {
  value: Side;
  onChange: (s: Side) => void;
  settings: Settings | null;
}) {
  const mods = modulesOf(settings);
  if (!(mods.kitchen && mods.craft)) return null;

  const options: { v: Side; l: string }[] = [
    { v: 'all', l: 'Both' },
    { v: 'kitchen', l: 'Kitchen' },
    { v: 'craft', l: 'Craft shop' },
  ];

  return (
    <div className="side-filter" role="group" aria-label="Which side of the business">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          className={value === o.v ? 'on' : ''}
          onClick={() => onChange(o.v)}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

/** Does this row belong to the side being shown? Absent means kitchen. */
export const onSide = (row: { module?: string }, side: Side): boolean =>
  side === 'all' || (row.module ?? 'kitchen') === side;
