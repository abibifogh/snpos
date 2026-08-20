/**
 * Filing an order under a different shift.
 *
 * An order lands on whichever shift was open when it was rung up, and now and
 * then that is the wrong one: a bill started before midnight and settled after
 * the handover, a till left open from the afternoon, a sale taken while the
 * evening shift had already begun. The food was cooked, the money came in, the
 * customer has gone — the only thing wrong is which night it counts towards.
 *
 * Which is worth being able to fix, because the alternatives are both bad:
 * cancel a real sale and re-ring it, or leave one shift permanently over and
 * the next permanently short with no explanation on either.
 *
 * The rules that decide whether a move makes sense live here, away from the
 * screen and away from the database, so they can be argued with directly.
 *
 * Pure. Nothing here writes anything.
 */

export interface MovableShift {
  $id: string;
  code: string;
  status: string;
  venue_id: string;
  module?: string;
  opened_at: string;
  closed_at?: string;
}

export interface MovableOrder {
  $id: string;
  order_no: string;
  venue_id: string;
  shift_id?: string;
  module?: string;
  status: string;
}

const sideOf = (x: { module?: string }): string => x.module ?? 'kitchen';

/** Closed, and therefore already counted, reported and posted. */
export const isSettled = (shift: MovableShift): boolean => shift.status === 'closed';

/**
 * The shifts this order could sensibly be filed under.
 *
 * Two narrowings, both of them about not creating a mess that is harder to
 * unpick than the one being fixed.
 *
 * ONE SIDE ONLY. A bar sale filed under a kitchen shift would put drink
 * takings into the bistro's drawer figures and its books; the two sides keep
 * separate shifts precisely so that the money never mixes, and a screen that
 * offered the other side's shifts would undo that with one wrong tap.
 *
 * ONE VENUE ONLY, for the same reason and more obviously.
 *
 * Closed shifts are deliberately IN the list. Almost every wrong filing is
 * noticed after the fact — that is what makes it noticeable — so a list of
 * only open shifts would answer the question nobody has.
 *
 * Newest first: the shift somebody means is nearly always one of the last few.
 */
export function shiftChoices(order: MovableOrder, shifts: MovableShift[]): MovableShift[] {
  return shifts
    .filter((s) => s.venue_id === order.venue_id)
    .filter((s) => sideOf(s) === sideOf(order))
    .filter((s) => s.$id !== (order.shift_id ?? ''))
    .sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? ''));
}

/**
 * Why this move cannot be made, or nothing.
 *
 * Refusals only where the result would be wrong, not where it would merely be
 * unusual. Moving a sale onto a shift that closed last week is unusual and
 * completely legitimate; moving a bar sale onto a kitchen shift is neither.
 */
export function moveProblem(order: MovableOrder, to: MovableShift | null | undefined): string | null {
  if (!to) return 'Pick the shift this should be counted under.';
  if (to.$id === (order.shift_id ?? '')) return `${order.order_no} is already counted under ${to.code}.`;
  if (to.venue_id !== order.venue_id) return 'That shift belongs to another venue.';
  if (sideOf(to) !== sideOf(order)) {
    return `${order.order_no} is a ${sideOf(order) === 'craft' ? 'shop' : sideOf(order)} sale and ${to.code} is a `
      + `${sideOf(to) === 'craft' ? 'shop' : sideOf(to)} shift. Each side keeps its own takings, so a sale cannot `
      + 'be counted under the other one.';
  }
  return null;
}

export interface MoveEffects {
  /** Whether money moves with the order, and how much. */
  amount: number;
  payments: number;
  /**
   * Things that will still be wrong afterwards, or that this does not touch.
   *
   * Said before the move rather than discovered afterwards. Every one of these
   * is a thing somebody would otherwise find out about from an accountant.
   */
  warnings: string[];
}

/**
 * What moving this will and will not do.
 *
 * The honest part of this feature. Moving an order is easy; what is hard is
 * that a closed shift is not a live figure, it is a night that was counted by
 * a person and signed off, and no amount of correcting rows afterwards puts
 * the cash back in the right drawer.
 *
 * So the three things that do NOT follow the order are named out loud:
 *
 *   - What was physically counted. A person counted that drawer. Nothing found
 *     later changes what was in it, and rewriting it would destroy the only
 *     number in the whole system that was never derived from another one.
 *   - The over-or-short that came out of that count. It moves, because what
 *     the drawer SHOULD have held moves — which means a shift that balanced
 *     may not any more, and that is the truth rather than a side effect.
 *   - Anything already posted to the accounts for that shift.
 */
export function moveEffects(opts: {
  from?: MovableShift | null;
  to: MovableShift;
  payments: { amount: number; tip?: number }[];
}): MoveEffects {
  const { from, to, payments } = opts;
  const amount = payments.reduce((a, p) => a + p.amount + (p.tip ?? 0), 0);
  const warnings: string[] = [];

  const settled = [from, to].filter((s): s is MovableShift => !!s && isSettled(s));
  if (settled.length > 0) {
    const names = settled.map((s) => s.code).join(' and ');
    warnings.push(
      `${names} ${settled.length === 1 ? 'has' : 'have'} already been closed and counted. What was physically `
      + 'in the drawer that night does not change — only what it should have held, and the over-or-short with '
      + 'it. A shift that balanced may not any more.',
    );
    warnings.push(
      `Anything already posted to the accounts for ${names} is not changed. If the books for that period have `
      + 'been closed off, correct them under Accounting as well.',
    );
  }

  if (amount > 0 && !from) {
    warnings.push(
      'This order was not counted under any shift, so its money has not been part of anybody\'s takings. '
      + `Moving it onto ${to.code} makes that drawer expected to hold it.`,
    );
  }

  return { amount, payments: payments.length, warnings };
}

/**
 * The move in one sentence, for the button and the record.
 *
 * Written so it reads the same in a confirmation as it does in the audit log a
 * year later, when the question is "who moved this and what did they think
 * they were doing".
 */
export function describeMove(order: MovableOrder, from: MovableShift | null | undefined, to: MovableShift): string {
  return from
    ? `${order.order_no} moves from ${from.code} to ${to.code}.`
    : `${order.order_no} is filed under ${to.code}.`;
}
