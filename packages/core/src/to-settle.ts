/**
 * Food that has left the pass and has not been paid for.
 *
 * The kitchen board shows a ticket from the moment it arrives until somebody
 * presses Collected, and payment is taken at the last step of that journey —
 * "Collect & take payment", one button, food and money together. It works, and
 * it is the right shape for a counter where the two happen at once.
 *
 * It has one hole, and it is the expensive kind. The board only ever showed
 * PENDING through READY, so the instant an order is marked served it is gone
 * from the screen for good. An order that becomes unpaid AFTERWARDS therefore
 * has nowhere to appear:
 *
 *   - a payment recorded against the wrong method, voided so it can be redone;
 *   - a card that was declined after the plates went out;
 *   - a dine-in table served course by course and settling at the end, which
 *     is not an edge case at all, it is how a restaurant works.
 *
 * In every one of those the money is real, owed, and invisible. Nobody is
 * hiding it; there is simply no screen it belongs to, so it is found at the
 * end of the night, if it is found at all.
 *
 * So these bills get a place of their own. Not mixed into the cooking lanes —
 * a cook reading the board wants what is cooking, and a served ticket among
 * them is noise that gets learnt and then ignored — but on the same screen,
 * counted, with what is owed on the front of it.
 *
 * Pure. The caller does the reading; this decides what belongs there.
 */

/** The little of an order this needs to know. */
export interface SettleableOrder {
  $id: string;
  $createdAt: string;
  status: string;
  payment_status: string;
  total: number;
}

/**
 * Has this one left the pass still owing?
 *
 * `partial` counts, and deliberately. Half a bill paid is half a bill owed,
 * and the whole point of this list is that the remainder does not vanish
 * because something was recorded against it once.
 *
 * A refund is not a debt. Money that was taken and given back is a finished
 * story, and putting it on a list headed "still to pay" would send somebody to
 * ask a customer for money they have already been told they do not owe.
 */
export function awaitingPayment(order: SettleableOrder): boolean {
  if (order.status !== 'SERVED') return false;
  return order.payment_status === 'unpaid' || order.payment_status === 'partial';
}

/**
 * The bills, newest first.
 *
 * Newest first because the customer most likely to still be in the building —
 * and so most likely to be able to pay — is the one served last. The old ones
 * are not dropped: an unpaid bill from Tuesday is still money, and quietly
 * ageing it off the screen would be the system deciding to forget a debt on
 * the shop's behalf.
 */
export const billsToSettle = <T extends SettleableOrder>(orders: T[]): T[] =>
  orders.filter(awaitingPayment).sort((a, b) => b.$createdAt.localeCompare(a.$createdAt));

/** What is owed across the lot, before anything already taken is deducted. */
export const settleableTotal = (orders: SettleableOrder[]): number =>
  billsToSettle(orders).reduce((sum, o) => sum + o.total, 0);

/**
 * The heading, which has to say the number out loud.
 *
 * A section somebody has to count is a section nobody counts.
 */
export const billsToSettleLabel = (n: number): string =>
  n === 1 ? 'Served · 1 bill still to pay' : `Served · ${n} bills still to pay`;
