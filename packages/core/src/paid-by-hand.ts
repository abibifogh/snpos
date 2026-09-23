/**
 * An order marked paid by hand, with no record of the money.
 *
 * The Change screen lets an admin set an order's payment back and forth,
 * because sometimes that is the only honest option — a bill marked paid that
 * was not, a card that failed after the fact. Setting it TO paid writes one
 * word on the order and nothing else, and that word is where the trouble
 * starts.
 *
 * A payment row is what the rest of the system runs on. It carries the method,
 * so the shift knows whether the money is in a drawer or on a card machine; it
 * carries the shift, so the night it belongs to can be counted; and it is what
 * every total is built from. An order marked paid with no payment row is
 * therefore money the system SAYS arrived and cannot place anywhere:
 *
 *   - it is in no method, so nothing can be changed about how it was paid —
 *     which is what somebody discovers when they go looking for the button;
 *   - it is in no shift, so it never reaches the cash or card totals and the
 *     drawer that actually holds it counts as over;
 *   - and it is in no report, while the order sits there reading "paid".
 *
 * None of that announces itself. The order looks settled from every angle
 * except the one that matters.
 *
 * So the gap is named, measured, and fillable: an admin says how it was paid
 * and a real payment is recorded against the shift it belongs to. What was a
 * word becomes a record, and everything downstream starts agreeing again.
 *
 * Pure. Imports nothing at runtime.
 */

/** A payment, as far as this question is concerned. */
export interface RecordedPayment {
  amount: number;
  status?: string;
}

/** An order, as far as this question is concerned. */
export interface PaidOrder {
  total: number;
  payment_status: string;
  /** Set where the bill went onto a running account. Not a gap; see below. */
  tab_id?: string;
  /** The night it was rung up on. Where the money has to be counted. */
  shift_id?: string;
}

/**
 * What has actually been recorded against a bill.
 *
 * A voided or refunded payment is not money the business holds, so it does not
 * count towards explaining what the order claims. The same rule every other
 * total in this system uses.
 */
export const recordedTotal = (payments: RecordedPayment[]): number =>
  payments
    .filter((p) => p.status !== 'voided' && p.status !== 'refunded')
    .reduce((sum, p) => sum + p.amount, 0);

/**
 * How much of this order is claimed as paid with nothing behind it.
 *
 * Zero on the overwhelming majority of orders, which were settled at a till
 * and have the row to show for it.
 *
 * A bill on a TAB is not a gap. It is unpaid on purpose, the account carries
 * it, and nothing here should offer to invent a payment for money that has
 * genuinely not arrived — see tabs.ts.
 */
export function unrecordedPaid(order: PaidOrder, payments: RecordedPayment[]): number {
  if (order.tab_id) return 0;
  if (order.payment_status !== 'paid' && order.payment_status !== 'partial') return 0;
  // Only a bill claiming to be fully paid claims the whole total. A partial
  // one claims whatever has been recorded, so there is nothing missing unless
  // somebody set the word by hand with no row at all.
  const claimed = order.payment_status === 'paid' ? order.total : 0;
  return Math.max(0, claimed - recordedTotal(payments));
}

/**
 * What to say about the gap, and why it matters, without an accusation.
 *
 * Marking a bill paid by hand is usually the right call made in a hurry — the
 * money did arrive, somebody just could not reach a till. The message assumes
 * that and asks for the one missing fact.
 */
export function unrecordedWords(
  amount: number,
  format: (amount: number) => string,
): string {
  return `${format(amount)} on this bill is marked paid with no payment recorded behind it. Until there is one, `
    + 'the money is in no shift and no method — so it never reaches the cash or card totals, and the drawer '
    + 'that actually holds it reads as over. Say how it was paid and it will be recorded properly.';
}

/**
 * Whether an admin can be offered the fix here.
 *
 * A refund is not this. Neither is an unpaid bill: inventing a payment for one
 * would be marking it paid through a side door, which is the mistake this
 * exists to clean up rather than a second way to make it.
 */
export const canRecordMissing = (order: PaidOrder, payments: RecordedPayment[]): boolean =>
  unrecordedPaid(order, payments) > 0;

/* --------------------------------------------- asking at the moment of marking */

/**
 * ASKED WHERE THE GAP IS MADE, rather than found afterwards.
 *
 * Everything above is a cleanup: it finds a bill already marked paid with
 * nothing behind it and offers to fill in the missing fact. That is the right
 * shape for the ones already in the system and the wrong shape for the next
 * one, because it relies on somebody coming back — the screen that made the
 * gap said "open this order afterwards and say how it was paid", and an
 * instruction to do a second thing later is a second thing that does not
 * happen.
 *
 * So the one question is asked at the moment the word is written, and the
 * payment is recorded in the same breath. Nothing about the answer changes:
 * the same method, the same reference rule, the same shift, the same row.
 * Only when it is asked.
 */
export interface HandPlacement {
  /**
   * What a payment row here would be for. Zero means there is nothing to
   * write — either this change does not claim money, or rows already cover it.
   */
  amount: number;
  /** The shift the money belongs to: the SALE's, never today's. */
  shiftId: string;
  /**
   * Why it cannot be placed, when it cannot. Not a refusal of the status
   * change — an admin may still mark a bill paid, because sometimes that is
   * the only honest option. It is the sentence that says what is left over.
   */
  problem: string | null;
}

/**
 * What writing the money down would mean, given the change being made.
 *
 * The shift is the sale's own. The money arrived on the night the order was
 * rung up, and putting it into whichever shift happens to be open now would
 * make tonight's drawer read over and that night's still read short — two
 * wrong figures where there was one.
 */
export function placeByHand(input: {
  order: PaidOrder;
  payments: RecordedPayment[];
  /** What the payment status is being set to. */
  nextStatus: string;
}): HandPlacement {
  const none: HandPlacement = { amount: 0, shiftId: '', problem: null };
  // Only the moment a bill starts claiming to be settled in full. Going the
  // other way takes money back out, which is a void and has its own screen.
  if (input.nextStatus !== 'paid' || input.order.payment_status === 'paid') return none;

  const amount = Math.max(0, input.order.total - recordedTotal(input.payments));
  // Already explained by rows somebody has taken. Nothing missing, so nothing
  // to ask — writing a second row would be charging the bill twice.
  if (amount <= 0) return none;

  /*
    A BILL ON A TAB IS NOT THIS. It is unpaid on purpose, the account carries
    it, and settling it is the tab's job — inventing a payment here would take
    the bill off the account with money nobody handed over. See tabs.ts.
  */
  if (input.order.tab_id) {
    return {
      amount: 0,
      shiftId: '',
      problem: 'This bill is on a tab, so the account carries it. Settle the tab to record the money — a '
        + 'payment written here would clear the bill without anybody having paid it.',
    };
  }

  const shiftId = input.order.shift_id ?? '';
  /*
    The one case with nowhere honest to put it. Said rather than guessed: a
    payment has to be counted in some night, and choosing one for it would put
    real money into a drawer that never held it.
  */
  if (!shiftId) {
    return {
      amount,
      shiftId: '',
      problem: 'This order is not on any shift, so there is no night to count the money in. It will be marked '
        + 'paid with nothing behind it. Move it onto a shift from its details, then say how it was paid.',
    };
  }

  return { amount, shiftId, problem: null };
}

/** Whether the question can actually be asked here. */
export const canPlaceByHand = (p: HandPlacement): boolean => p.amount > 0 && !p.problem;

/** What to say above the picker, so the figure is not a surprise. */
export const placeByHandWords = (
  amount: number,
  format: (amount: number) => string,
): string =>
  `${format(amount)} is about to be marked paid. Say where the money went and it is recorded properly in the `
  + 'same step — into the shift this order was sold on, not today\'s, so the night it belongs to is the night '
  + 'that counts it.';

/** The refusal when no method was picked. */
export const methodProblem = (methodId: string | undefined): string | null =>
  (methodId ? null : 'Say where the money went. A payment with no method is in no drawer and on no card '
    + 'machine, which is the gap this is here to close.');
