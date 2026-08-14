import { modulesForStaff } from '@snpos/core';
import type { Module, Settings, StaffProfile } from '@snpos/core';

export type Side = Module | 'all';

/**
 * Which side of the business a list is showing.
 *
 * Only rendered where there is a choice: a business running one side has
 * nothing to filter, and a row of buttons that never changes anything is a row
 * somebody learns to ignore, along with the next one, which does matter.
 *
 * "Both" leads because the question an owner asks first is what the whole
 * business did. The split is the second question, and it is one tap away.
 */
export function SideFilter({
  value, onChange, settings, profile,
}: {
  value: Side;
  onChange: (s: Side) => void;
  settings: Settings | null;
  /**
   * Whose screen this is.
   *
   * The choice is what the BUSINESS runs narrowed by what this person works
   * on, not the business alone. Somebody marked kitchen-only was still offered
   * a Craft shop tab, and pressing it showed them the shop's shifts — which is
   * not a filter doing nothing, it is a filter handing over the figures the
   * marking was meant to keep back.
   */
  profile?: StaffProfile | null;
}) {
  const mods = modulesForStaff(profile ?? null, settings);
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

/**
 * The side to actually filter by, once the person is taken into account.
 *
 * "Both" means both of THEIRS. Somebody who works one side has no second side
 * to be shown, and leaving the filter on "all" quietly gave them the other
 * one's rows — no tab pressed, nothing on screen to suggest it, just the
 * figures they were marked as not working on.
 *
 * Returns their single side when they have one, and whatever was chosen when
 * they have both.
 */
export function narrowSide(side: Side, profile: StaffProfile | null | undefined, settings: Settings | null): Side {
  const mods = modulesForStaff(profile ?? null, settings);
  if (mods.kitchen && mods.craft) return side;
  if (mods.craft) return 'craft';
  return 'kitchen';
}
