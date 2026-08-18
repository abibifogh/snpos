import { modulesForStaff, MODULE_LABELS } from '@snpos/core';
import { Segmented } from '@snpos/ui';
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
  const theirs = (['kitchen', 'bar', 'craft'] as Module[]).filter((m) => mods[m]);
  // One side is not a choice. A filter with a single option in it is a control
  // that cannot change anything, sitting where somebody expects one that can.
  if (theirs.length < 2) return null;

  return (
    <Segmented<Side>
      value={value}
      onChange={onChange}
      ariaLabel="Which side of the business"
      options={[
        { value: 'all', label: 'All' },
        ...theirs.map((m) => ({ value: m as Side, label: MODULE_LABELS[m] })),
      ]}
    />
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
  const theirs = (['kitchen', 'bar', 'craft'] as Module[]).filter((m) => mods[m]);
  if (theirs.length > 1) return side;
  return (theirs[0] ?? 'kitchen') as Side;
}
