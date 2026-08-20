/**
 * A petty cash box run on the imprest system.
 *
 * The idea is older than any of this and is worth stating plainly, because the
 * whole file follows from it: a box is set at a FIXED amount, money is spent
 * out of it against receipts, and it is topped back up by exactly what was
 * spent. At any moment the cash in the box plus the receipts held should come
 * to the fixed amount. That one identity is what makes a petty cash box
 * checkable at all — an ordinary float has no such property, so a shortage in
 * it can only be noticed by somebody who happens to remember what was there.
 *
 * Two decisions here shape everything else.
 *
 * THE BALANCE IS THE SUM OF THE MOVEMENTS, never a stored figure that gets
 * adjusted. A running total kept as a field drifts the first time a write half
 * fails, and once it has drifted nothing in the system can tell you so. Summed
 * from the movements it cannot be wrong; it can only be incomplete, and an
 * incomplete list is visible.
 *
 * THE EXPECTED CASH IS NOT ASSUMED TO BE THE FIXED AMOUNT. In the textbook the
 * box is always restored to its level, so expected cash is "fixed minus
 * receipts". In a real kitchen somebody tops up half of it on a Friday because
 * that is what was in the safe. Deriving expected from what actually went in
 * and out describes both cases; assuming the textbook describes only one, and
 * reports a shortage every time reality differs from it.
 *
 * Pure. Nothing here reads or writes.
 */

/** What a movement in or out of the box was for. */
export type ImprestKind = 'top_up' | 'spend' | 'adjust' | 'return';

export const IMPREST_KIND_LABELS: Record<ImprestKind, string> = {
  top_up: 'Topped up',
  spend: 'Spent',
  adjust: 'Counted',
  return: 'Returned',
};

export interface ImprestMovement {
  /** Signed minor units. Positive into the box, negative out of it. */
  amount: number;
  kind: ImprestKind;
  occurred_at?: string;
}

export interface ImprestFloat {
  $id: string;
  name: string;
  /** What the box is meant to hold when it is full, in minor units. */
  fixed_amount: number;
  account_code?: string;
  custodian_id?: string;
  active?: boolean;
}

/**
 * What should be in the box, from what actually went in and out of it.
 *
 * Deliberately not `fixed_amount - spending`. See the note at the top: a box
 * topped up by half on a Friday is normal, and the textbook figure would call
 * it short by the other half every day until somebody found the money to
 * finish the job.
 */
export const boxBalance = (movements: ImprestMovement[]): number =>
  movements.reduce((sum, m) => sum + m.amount, 0);

/** What has been spent out of the box since a given moment. Always positive. */
export function spentSince(movements: ImprestMovement[], sinceIso?: string): number {
  return movements
    .filter((m) => m.kind === 'spend')
    .filter((m) => !sinceIso || (m.occurred_at ?? '') >= sinceIso)
    .reduce((sum, m) => sum + Math.abs(m.amount), 0);
}

/**
 * The gap between the box and its level, which is what a top-up is for.
 *
 * Never negative. A box holding more than its fixed amount does not need
 * topping up by a negative number; it needs money taking out of it, which is a
 * different act with a different name — see `overBy`.
 */
export const topUpNeeded = (fixedAmount: number, balance: number): number =>
  Math.max(0, fixedAmount - balance);

/** And the other direction: money sitting in a box that should not hold it. */
export const overBy = (fixedAmount: number, balance: number): number =>
  Math.max(0, balance - fixedAmount);

/**
 * How low a box may run before it is worth saying so, in basis points.
 *
 * A quarter left. Low enough not to nag at a box that is simply being used,
 * high enough that somebody hears about it before the morning a cook is sent
 * to the market and there is nothing to send them with.
 */
export const IMPREST_LOW_BP = 2_500;

export type ImprestHealth = 'ok' | 'low' | 'empty' | 'over';

export function healthOf(fixedAmount: number, balance: number): ImprestHealth {
  if (balance <= 0) return 'empty';
  if (balance > fixedAmount) return 'over';
  if (fixedAmount > 0 && balance * 10_000 <= fixedAmount * IMPREST_LOW_BP) return 'low';
  return 'ok';
}

export interface CountResult {
  /** What the movements say should be there. */
  expected: number;
  counted: number;
  /** Counted minus expected. Negative is short, which is the usual direction. */
  variance: number;
  /** What it would take to restore the box to its level, after the count. */
  toRestore: number;
}

/**
 * A count of the box, worked out.
 *
 * The variance is measured against the movements rather than against the fixed
 * amount, and the restore figure against the fixed amount rather than the
 * movements. Those are two different questions — "is any money missing" and
 * "how much do I put back in" — and answering both with one number is what
 * makes petty cash arguments unresolvable.
 */
export function countBox(opts: {
  fixedAmount: number;
  balance: number;
  counted: number;
}): CountResult {
  const variance = opts.counted - opts.balance;
  return {
    expected: opts.balance,
    counted: opts.counted,
    variance,
    // From what is actually there once the count is believed, not from what
    // the book said a moment ago.
    toRestore: Math.max(0, opts.fixedAmount - opts.counted),
  };
}

/**
 * Why this count cannot be saved, or nothing.
 *
 * A blank is not a nought, the same rule the shelf counts follow. Saving one
 * would write the box down to empty and post the whole float to cash short,
 * which is a serious accusation to make out of an unanswered box.
 */
export function countProblem(countedText: string): string | null {
  const raw = (countedText ?? '').trim();
  if (raw === '') return 'Count the box and enter what is in it. A blank is not the same as nothing.';
  /*
    The minus is read before the digits are cleaned, not after.

    Stripping everything that is not a digit turns "-5" into "5" — it does not
    reject the entry, it silently records the opposite of what somebody typed.
    A box cannot hold less than nothing, so a minus here is always a slip, and
    a slip that saves quietly is worse than one that is refused.
  */
  if (raw.startsWith('-')) return 'A box cannot hold less than nothing.';
  const n = Number(raw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return 'That is not an amount.';
  if (n < 0) return 'A box cannot hold less than nothing.';
  return null;
}

/**
 * Whether a difference is big enough to need saying out loud.
 *
 * Petty cash is petty: a box is out by small change all the time, somebody
 * rounds a taxi fare, a coin goes down the back of a drawer. A threshold that
 * fires on any difference fires every week and teaches people to type anything
 * in the box to make it stop.
 */
export const IMPREST_TOLERANCE = 1_000;

export function needsExplaining(variance: number, tolerance = IMPREST_TOLERANCE): boolean {
  return Math.abs(variance) > tolerance;
}

/** Why this spend cannot be recorded, or nothing. */
export function spendProblem(opts: {
  amount: number;
  balance: number;
  categoryKey?: string;
  /** Allowed by an admin who would rather record the truth than balance. */
  allowOverdraw?: boolean;
}): string | null {
  if (!opts.amount || opts.amount <= 0) return 'Enter what was spent.';
  if (!opts.categoryKey) return 'Say what it was for, so it lands in the right account.';
  if (opts.amount > opts.balance && !opts.allowOverdraw) {
    /*
      Refused by default, and only by default.

      A box cannot pay out money it does not hold, so this is nearly always a
      spend recorded against the wrong box or a top-up nobody entered. But it
      IS possible for somebody to have made up the difference from their own
      pocket and be owed it back, and a system that cannot record what really
      happened gets worked around rather than corrected.
    */
    return 'That is more than the box holds. Record the top-up first, or tick the box below if it really was paid out anyway.';
  }
  return null;
}

/**
 * Spends out of the box with nothing to show for them.
 *
 * The question somebody asks when reconciling, and the reason a box is run on
 * receipts at all: the count says the money is gone, and only the paper says
 * what for. A box that balances perfectly with no receipts behind it has
 * proved nothing except that somebody can subtract.
 *
 * Only spends. A top-up is a transfer between two places the business already
 * owns — there is no third party to have issued a receipt for it, and counting
 * those as missing would report every funded box as half undocumented.
 */
export function withoutReceipt<T extends { kind: ImprestKind; ref_type?: string; ref_id?: string }>(
  movements: T[],
  receiptFor: Record<string, string>,
): T[] {
  return movements.filter(
    (m) => m.kind === 'spend' && (!m.ref_id || m.ref_type !== 'expense' || !receiptFor[m.ref_id]),
  );
}

/** The movement in one sentence, for a list and for the audit log alike. */
export function describeMovement(m: ImprestMovement & { note?: string }): string {
  const label = IMPREST_KIND_LABELS[m.kind] ?? 'Moved';
  const sign = m.amount >= 0 ? 'in' : 'out';
  return `${label}, ${sign}${m.note ? `: ${m.note}` : ''}`;
}
