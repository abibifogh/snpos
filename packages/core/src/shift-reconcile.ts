/**
 * Making a shift panel's two figures agree, or say why they do not.
 *
 * The panel a cashier counts a drawer against shows money in at the top and
 * the orders it came from underneath. Those are read from two different
 * places: the money is every live payment stamped with this shift, and the
 * orders are whatever `belongsToShift` accepts. Nothing checked that the two
 * described the same thing.
 *
 * So when they disagreed, they disagreed silently. A craft shift showed
 * GH₵1,260 in over two orders totalling GH₵1,004, and there was nowhere on
 * the screen to find the missing GH₵256 — not a rounding error, not a tip, and
 * no way for the person counting to tell which. That is the worst possible
 * failure for this particular screen, because its whole job is to be the
 * number somebody's cash is checked against, and a figure that cannot be
 * accounted for turns into a person being asked where the money went.
 *
 * The figures are ALLOWED to differ. There are real reasons: a bill settled at
 * one counter for a sale rung up at another, an order moved to a different
 * shift after its money was taken, a sale since cancelled. Money belongs to
 * the drawer it was physically put in, and the sale belongs to the trade that
 * made it, and those are genuinely two different questions.
 *
 * What is not allowed is the difference being invisible. So every payment is
 * matched to an order on the list, and whatever does not match is shown with
 * its reason and its amount, in the same way a payment against a method the
 * venue no longer lists is shown rather than quietly folded into a total.
 *
 * Pure. Nothing here reads or writes anything.
 */

export interface CountedPayment {
  $id: string;
  order_id?: string;
  amount?: number;
  tip?: number;
  status?: string;
}

export interface ListedOrder {
  $id: string;
  order_no?: string;
  status?: string;
  module?: string;
  shift_id?: string;
}

/** One payment on this shift with no order on this shift's list. */
export interface Loose {
  payment: CountedPayment;
  /** The sale it was taken against, where it could be found at all. */
  order: ListedOrder | null;
  amount: number;
  why: string;
}

/**
 * What the orders on the list come to.
 *
 * The figure the eye adds up, so the screen can compare against the same
 * number a person would.
 */
export const listedTotal = (orders: { total?: number }[]): number =>
  orders.reduce((s, o) => s + (o.total ?? 0), 0);

/**
 * Why this payment's sale is not in the list, in words.
 *
 * Each answer is a real thing that happens in a shop, and each is worth
 * different action — which is the whole reason for naming them rather than
 * printing one catch-all. A cancelled sale whose money was never handed back
 * is somebody's mistake to put right today; a bill settled at the other
 * counter is simply true and needs no action at all.
 */
export function whyLoose(
  order: ListedOrder | null,
  shift: { $id: string; module?: string },
): string {
  if (!order) return 'the sale it was taken against is no longer on file';
  if (order.status === 'CANCELLED') {
    return 'that sale was cancelled and this money was not handed back — worth checking the drawer';
  }
  const side = order.module ?? 'kitchen';
  const here = shift.module ?? 'kitchen';
  if (side !== here) {
    const trade = side === 'craft' ? 'shop' : side === 'bar' ? 'bar' : 'bistro';
    return `a ${trade} bill settled at this counter, so the money is in this drawer and the sale counts on the ${trade}`;
  }
  if (order.shift_id && order.shift_id !== shift.$id) {
    return 'that sale has since been moved to another shift, and its money stayed here';
  }
  return 'that sale is not on this shift';
}

/**
 * Every live payment whose sale is not on the list, and what that comes to.
 *
 * A payment with NO order at all is included rather than skipped. It is the
 * rarest case and the one most worth seeing: money recorded against nothing is
 * either a mistake being made repeatedly or a sale that was deleted, and both
 * are things somebody should be told about the first time rather than the
 * twentieth.
 */
export function looseTakings(opts: {
  payments: CountedPayment[];
  orders: ListedOrder[];
  /** Sales looked up because they were not on the list. Keyed by id. */
  found?: Map<string, ListedOrder>;
  shift: { $id: string; module?: string };
  live: (p: { status?: string }) => boolean;
}): { rows: Loose[]; amount: number } {
  const onList = new Set(opts.orders.map((o) => o.$id));
  const rows: Loose[] = [];

  for (const p of opts.payments) {
    if (!opts.live(p)) continue;
    if (p.order_id && onList.has(p.order_id)) continue;
    const order = (p.order_id ? opts.found?.get(p.order_id) : null) ?? null;
    rows.push({
      payment: p,
      order,
      amount: (p.amount ?? 0) + (p.tip ?? 0),
      why: p.order_id ? whyLoose(order, opts.shift) : 'it is not attached to any sale',
    });
  }

  return { rows, amount: rows.reduce((s, r) => s + r.amount, 0) };
}

/**
 * The ids this shift needs to look up before it can explain itself.
 *
 * Only the ones that are actually missing, so the ordinary shift — where every
 * payment matches a listed sale — reads nothing extra at all. A screen that
 * paid for an explanation it never needs is a screen that costs a read on
 * every shift in the building, all day.
 */
export function missingOrderIds(payments: CountedPayment[], orders: { $id: string }[]): string[] {
  const onList = new Set(orders.map((o) => o.$id));
  return [...new Set(
    payments
      .map((p) => p.order_id ?? '')
      .filter((id) => id && !onList.has(id)),
  )];
}

/**
 * The line that makes the two figures add up, in one sentence.
 *
 * Written as arithmetic somebody can follow with their eyes, because the
 * person reading it is holding a pile of cash and comparing it to a number.
 */
export function looseWords(
  listed: number,
  loose: number,
  money: (n: number) => string,
): string {
  return `The ${money(listed)} of sales below, plus ${money(loose)} taken here for sales counted `
    + `elsewhere, is the ${money(listed + loose)} in the drawer.`;
}
