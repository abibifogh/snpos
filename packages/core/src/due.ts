/**
 * What a customer standing at the counter actually owes.
 *
 * There are two piles in front of a cashier and only one of them is a bill.
 * The ORDERS are things that have been rung up: they exist as records, they
 * have order numbers, their lines have come off the shelf and been credited to
 * whoever made them. The CART is things on the counter that nobody has rung up
 * yet — no record, no number, no stock movement, nobody credited.
 *
 * The till was adding the two together and calling it the amount due. Press
 * "Take payment" with a bracelet rung up at GH₵20 and a lip balm still sitting
 * in the cart at GH₵10, and it asked for GH₵30 — then filed all thirty against
 * the bracelet, because the payment can only ever be spread across bills that
 * exist.
 *
 * Which produces, in one movement:
 *
 *   - A sale showing GH₵30 paid against a GH₵20 total, which is what got
 *     noticed.
 *   - A shift whose money in is larger than the sales beneath it, for ever.
 *   - AND THE PART THAT MATTERS MOST: the lip balm leaves the shop. It was
 *     never rung up, so it never came off the shelf, it is not on the count
 *     sheet as sold, and its maker is never paid for it. The count will find
 *     it missing weeks later and somebody will be asked where it went.
 *
 * So money is only ever taken against bills that exist. Anything still on the
 * counter has to be rung up first — which is one button, and the button the
 * cashier was reaching for anyway.
 *
 * Pure. Nothing here reads or writes.
 */

export interface PayableOrder {
  $id: string;
  total: number;
}

export interface TakenPayment {
  order_id?: string;
  amount?: number;
  /** A tip is money taken, but it is not owed on the bill. */
  tip?: number;
  status?: string;
}

/**
 * What the bills that exist still come to.
 *
 * The cart is not a parameter, deliberately. Somewhere to pass it would be
 * somewhere to pass it by mistake, and this function's whole reason for
 * existing is that those two things were added together once.
 *
 * Payments already taken come off, so a bill half-settled by one person asks
 * the next for the half that is left rather than for all of it again. Voided
 * and refunded rows are money that went back out and do not count as paid.
 */
export function amountDueOn(
  orders: PayableOrder[],
  payments: TakenPayment[] = [],
  live: (p: { status?: string }) => boolean = (p) => p.status !== 'voided' && p.status !== 'refunded',
): number {
  const owed = orders.reduce((sum, o) => sum + (o.total ?? 0), 0);
  const ids = new Set(orders.map((o) => o.$id));
  const paid = payments
    .filter((p) => p.order_id && ids.has(p.order_id))
    .filter(live)
    // The tip is deliberately not subtracted. It was never owed, so counting
    // it against the bill would leave the bill short by the tip and ask the
    // next person to pay it a second time.
    .reduce((sum, p) => sum + (p.amount ?? 0), 0);
  return Math.max(0, owed - paid);
}

/**
 * Why payment cannot be taken yet, or nothing.
 *
 * Said as what to do rather than as a refusal, because the thing to do is one
 * tap away and the cashier has a customer in front of them. The count of items
 * is in it so somebody can see at a glance whether it means the whole basket
 * or one thing they forgot.
 */
export function unrungProblem(cartItems: number, cartTotal: number, money: (n: number) => string): string | null {
  if (cartItems <= 0) return null;
  return `${cartItems} item${cartItems === 1 ? '' : 's'} on the counter ${cartItems === 1 ? 'has' : 'have'} not `
    + `been rung up yet, worth ${money(cartTotal)}. Charge ${cartItems === 1 ? 'it' : 'them'} first — otherwise `
    + `the money is taken but ${cartItems === 1 ? 'the item' : 'they'} never leave${cartItems === 1 ? 's' : ''} `
    + 'the shelf, and nobody is paid for it.';
}

/**
 * Is this payment about to put more against a bill than the bill comes to?
 *
 * The last line of defence, checked where the money is written rather than
 * where it is typed. The screen that produced the overpayment was capping the
 * figure against a number that already had the cart folded into it, so the cap
 * agreed with it and let it through — a check on the way in has to be against
 * the bills themselves.
 *
 * A tip is not an overpayment. It is money handed over on purpose and it has
 * its own box; only what is put against the BILL is measured here.
 */
export function overpaying(due: number, taking: number): number {
  return Math.max(0, taking - due);
}
