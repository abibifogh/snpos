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
    /*
      Said as a statement of what WILL happen, not a warning about what will
      not. The accounts used to be left behind here, which meant a shift that
      lost a sale went on crediting revenue it never made and went on carrying
      a cash shortage with somebody's name against it. They are now reposted —
      see repostShiftAccounts — and the one case that still cannot be is a
      period the books have been closed off through.
    */
    warnings.push(
      `The accounting entries for ${names} are posted again from the corrected figures, on their own dates, `
      + 'with the old ones reversed so both halves stay readable. The cost of goods sold is left where it is. '
      + 'If the books for that period have been closed off, nothing there can be touched and you will be told '
      + 'so.',
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


/* --------------------------------------- which shift an order belongs to */

/**
 * Does this order belong to this shift?
 *
 * A STAMP WINS OUTRIGHT. An order carrying a shift id belongs to that shift
 * and to no other, whatever the clock says about when it was rung up.
 *
 * The clock is the fallback, and only that: orders written before shifts were
 * stamped, and guest orders that arrive with no shift on them at all, are
 * caught by the window they fall inside. That fallback is what made moving an
 * order between shifts a half-measure — the order appeared under its new shift
 * because of the stamp AND under its old one because of the clock, so a sale
 * moved to the right night was counted on both, and the two shifts disagreed
 * with each other for ever afterwards.
 *
 * The side is checked either way. A window catches everything sold in the
 * building during it, including the other trade's.
 */
export function belongsToShift(
  order: { shift_id?: string; module?: string; $createdAt?: string },
  shift: { $id: string; module?: string; opened_at?: string; closed_at?: string },
  now: string = new Date().toISOString(),
): boolean {
  if ((order.module ?? 'kitchen') !== (shift.module ?? 'kitchen')) return false;
  if (order.shift_id) return order.shift_id === shift.$id;

  const at = order.$createdAt ?? '';
  if (!at || !shift.opened_at) return false;
  return at >= shift.opened_at && at <= (shift.closed_at ?? now);
}


/**
 * Which shift an order should be filed under once it has been paid for.
 *
 * Settling a bill files the sale under the shift whose drawer took the money.
 * That is right, and it is why an order rung up before a handover and paid
 * after it counts on the shift that actually holds the cash.
 *
 * It is right ONLY WITHIN ONE SIDE. A bar bill settled at the craft counter —
 * which happens whenever one tablet is switched between the two — was being
 * restamped onto the craft shop's shift, and that orphaned the sale outright:
 * `belongsToShift` refuses it on the craft shift because it is a bar sale, and
 * refuses it on the bar shift because a stamp wins over the clock and the
 * stamp now says craft. The order appeared on neither shift's list, while its
 * money sat in the craft shop's takings — so the shop's "money in" was larger
 * than the orders under it by exactly that bill, with nothing anywhere saying
 * why.
 *
 * The money still belongs to the drawer it was put in; the payment keeps the
 * shift it was taken on, and the panel reconciles the two and says so. What
 * must not happen is the SALE moving to another trade's books.
 *
 * Returns the shift to stamp, or null to leave the order's own stamp alone.
 */
export function shiftStampForPayment(opts: {
  order: { shift_id?: string; module?: string };
  shiftId: string;
  /** The side whose till is taking the money. Unknown leaves it to the order. */
  shiftModule?: string;
}): string | null {
  const { order, shiftId } = opts;
  if (!shiftId) return null;
  // Nothing to lose. A guest order, or one taken before shifts were stamped,
  // is filed under whichever shift settled it — which is the only shift that
  // has any claim on it at all.
  if (!order.shift_id) return shiftId;
  if (order.shift_id === shiftId) return null;

  // Unknown side is treated as the same side, which is what it was before
  // this existed. A caller that does not say cannot have its handovers
  // silently stop working.
  const side = opts.shiftModule ?? order.module ?? 'kitchen';
  return side === (order.module ?? 'kitchen') ? shiftId : null;
}


/* ---------------------------------------------- moving an order by date */

/**
 * The day a shift is reported under: the day it OPENED.
 *
 * Not the day it closed. A bar that opens at six and closes at two in the
 * morning did one night's trading, and filing it under the following day
 * would put every late night in the wrong month twice a year — once when it
 * happens and again when somebody tries to reconcile it.
 *
 * Local, not UTC. A shift that opened at eight in the evening in Accra is
 * that evening's, and reading the ISO date off the timestamp would agree
 * only for as long as the venue sits on the meridian.
 */
export function shiftDay(shift: { opened_at?: string }): string {
  const at = shift.opened_at ? new Date(shift.opened_at) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-CA');
}

/**
 * The shifts on a given day, for one side of the business.
 *
 * Several is normal rather than exceptional: a bar can be handed over at
 * eight and closed at two, which is two shifts and one night. So this returns
 * a list and the admin says which, rather than the code guessing and being
 * quietly wrong on the busiest days.
 */
export function shiftsOnDay<T extends MovableShift & { opened_at?: string; module?: string }>(
  shifts: T[],
  day: string,
  module?: string,
): T[] {
  return shifts
    .filter((s) => (s.module ?? 'kitchen') === (module ?? 'kitchen') && shiftDay(s) === day)
    .sort((a, b) => (a.opened_at ?? '').localeCompare(b.opened_at ?? ''));
}

/**
 * Why this order cannot be moved to this day, or nothing.
 *
 * The day itself, before any shift is chosen. A future date is the one worth
 * refusing outright: a sale cannot have happened on a day that has not
 * arrived, and letting one be filed there puts money into a period nobody
 * will look at until it is far too late to notice.
 */
export function dayMoveProblem(
  order: MovableOrder & { $createdAt?: string },
  day: string,
  today: string = new Date().toLocaleDateString('en-CA'),
): string | null {
  if (!day) return 'Pick the day this sale belongs to.';
  if (day > today) return 'That day has not happened yet. A sale cannot be filed under a future date.';
  if (order.$createdAt && shiftDay({ opened_at: order.$createdAt }) === day) {
    return 'That is the day it is already filed under.';
  }
  return null;
}

/**
 * The times a shift opened for a past day would carry.
 *
 * A back-dated shift is a container for trading that has already happened and
 * been accounted for, so it is created CLOSED. An open shift on a past day
 * would be found by every till in the building as "the shift to sell against",
 * and tomorrow's drinks would land on last Tuesday.
 *
 * The whole of that local day, so anything moved onto it falls inside its
 * window however late it was rung up.
 */
export function backdatedWindow(day: string): { openedAt: string; closedAt: string } {
  return {
    openedAt: new Date(`${day}T00:00:00`).toISOString(),
    closedAt: new Date(`${day}T23:59:59.999`).toISOString(),
  };
}
