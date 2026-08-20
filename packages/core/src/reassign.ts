/**
 * The same product, from a different supplier.
 *
 * A shop buys "Luggage strap" from Ama for a year, then starts buying it from
 * Kofi. It is the same thing on the same shelf under the same name, and the
 * only question is who gets paid for what — which is not one question but
 * four, and getting the wrong one leaves a maker paid for somebody else's
 * work, or unpaid for their own.
 *
 * The four differ along two axes, and it is worth being able to see them:
 *
 *                     stock on the shelf now      sales already made
 *   From now on       moves to the new owner      stay with the old
 *   Split             stays with the old owner    stay with the old
 *   All time          moves                       move
 *   A period          moves                       move, if inside the dates
 *
 * "Split" is the odd one, and the only one that cannot be done by changing a
 * field: a product row has one owner, so leaving the old stock with the old
 * maker means the shelf has to become two products. That is a real cost — two
 * rows called the same thing — and it is the honest shape of what was asked
 * for, because the alternative is telling somebody their remaining baskets now
 * belong to a supplier who never brought them.
 *
 * Pure. Imports nothing at runtime.
 */

export type ReassignMode = 'future_and_stock' | 'split' | 'all_time' | 'period';

export interface ModeChoice {
  value: ReassignMode;
  label: string;
  help: string;
}

export const REASSIGN_MODES: ModeChoice[] = [
  {
    value: 'future_and_stock',
    label: 'From now on, and move what is on the shelf',
    help: 'Everything sold from today belongs to the new supplier, and so does the stock still here. '
      + 'Sales already made stay with the old supplier, and their statement does not change.',
  },
  {
    value: 'split',
    label: 'From now on, and leave what is on the shelf where it is',
    help: 'The stock still here stays the old supplier’s, and they are paid when it sells. Only stock '
      + 'delivered from now on belongs to the new one. The shelf ends up with two products of the same '
      + 'name, one for each supplier — which is the only way both can be paid correctly.',
  },
  {
    value: 'all_time',
    label: 'Everything, from the beginning',
    help: 'Every sale, payment and stock movement of this product ever recorded moves to the new '
      + 'supplier. Use this when the wrong supplier was picked from the start.',
  },
  {
    value: 'period',
    label: 'Everything between two dates',
    help: 'Only what happened inside the dates you choose moves. Use this when the supplier changed on '
      + 'a known day and the products were filed under the wrong one for a while.',
  },
];

/** Does the stock currently on the shelf change hands? */
export const movesStock = (mode: ReassignMode): boolean => mode !== 'split';

/** Does anything already recorded change hands? */
export const movesHistory = (mode: ReassignMode): boolean => mode === 'all_time' || mode === 'period';

/** Does this need a new product row, so both suppliers can hold stock at once? */
export const needsSplit = (mode: ReassignMode): boolean => mode === 'split';

/**
 * Is this record inside the window being moved?
 *
 * Everything, for the modes that take everything. For a period, both ends are
 * included: somebody typing the day the supplier changed means that whole day,
 * and a window that silently stopped at midnight the night before would leave
 * one day's sales behind with no sign of it.
 */
export function inWindow(
  mode: ReassignMode,
  at: string | undefined,
  fromIso?: string,
  toIso?: string,
): boolean {
  if (mode !== 'period') return true;
  if (!at) return false;
  if (fromIso && at < fromIso) return false;
  if (toIso && at > toIso) return false;
  return true;
}

/**
 * What stops this being done at all.
 *
 * Refused rather than half-done. Every one of these leaves somebody's
 * statement wrong in a way that is hard to see and harder to undo.
 */
export function reassignProblem(opts: {
  fromId?: string;
  toId?: string;
  mode: ReassignMode;
  from?: string;
  to?: string;
}): string | null {
  if (!opts.toId) return 'Choose the supplier it should belong to.';
  if (opts.toId === opts.fromId) return 'That is already the supplier for this product.';
  if (opts.mode === 'period') {
    if (!opts.from || !opts.to) return 'Choose both dates.';
    if (opts.from > opts.to) return 'The first date is after the second one.';
  }
  return null;
}

export interface ReassignCounts {
  /** Ledger entries that would move. */
  entries: number;
  /** Ledger entries that cannot move because the maker has been paid for them. */
  paidOut: number;
  /** Stock movements that would move. */
  moves: number;
  /** Pieces on the shelf right now. */
  onHand: number;
}

/**
 * What is about to happen, in words, before anybody agrees to it.
 *
 * Spelled out per mode rather than as one sentence with holes in it, because
 * the four differ in what they leave behind, and "23 records will be updated"
 * tells nobody whether their supplier is about to be paid for a year of
 * somebody else's baskets.
 */
export function describeReassign(
  mode: ReassignMode,
  names: { from: string; to: string },
  counts: ReassignCounts,
): string {
  const bits: string[] = [];

  if (needsSplit(mode)) {
    bits.push(`A second "${names.to}" product is created, empty.`);
    bits.push(`${counts.onHand} on the shelf stay${counts.onHand === 1 ? 's' : ''} with ${names.from}, and ${names.from} is still paid when ${counts.onHand === 1 ? 'it sells' : 'they sell'}.`);
  } else {
    bits.push(`The product becomes ${names.to}'s.`);
    if (counts.onHand > 0) {
      bits.push(`${counts.onHand} on the shelf move${counts.onHand === 1 ? 's' : ''} to ${names.to}.`);
    }
  }

  if (movesHistory(mode)) {
    bits.push(`${counts.entries} statement entr${counts.entries === 1 ? 'y' : 'ies'} and ${counts.moves} stock movement${counts.moves === 1 ? '' : 's'} move from ${names.from} to ${names.to}.`);
    if (counts.paidOut > 0) {
      // A payout points at the entry. Moving it would leave real money sitting
      // against a sale that is no longer on the statement it was paid from.
      bits.push(`${counts.paidOut} cannot move because ${names.from} has already been paid for ${counts.paidOut === 1 ? 'it' : 'them'}; ${counts.paidOut === 1 ? 'it stays' : 'they stay'} where ${counts.paidOut === 1 ? 'it is' : 'they are'}.`);
    }
  } else {
    bits.push(`Sales already made stay with ${names.from}.`);
  }

  return bits.join(' ');
}
