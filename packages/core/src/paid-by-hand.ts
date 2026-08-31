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
