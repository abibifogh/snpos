/**
 * Which orders share a run of numbers, and what the next one is.
 *
 * THE COUNTER BELONGS TO THE PREFIX, NOT TO THE SIDE OF THE BUSINESS.
 *
 * That sentence is the whole of this file, and getting it wrong stopped a bar
 * taking money. Order numbers are unique per venue — the database enforces it —
 * so the run of numbers is scoped exactly as far as the prefix is, and nothing
 * else may narrow it.
 *
 * What it was: the craft shop got a prefix of its own, and the next number was
 * worked out from THIS SIDE's last order. Two sides with different prefixes
 * counting separately is correct. The bar was added later and given no prefix
 * of its own, so it shared the kitchen's — while still counting only its own
 * orders. The kitchen reached ORD0222; the bar, on its sixth drink, asked for
 * ORD0006, which the kitchen had used months earlier. The database refused it,
 * the till retried five times, worked out the same number five times, and told
 * a bartender with a customer waiting that the document violated a unique
 * attribute constraint.
 *
 * Pure. Imports nothing, so the rule that decides whether a sale can be rung
 * up at all can be checked without a database.
 */

/** A number the server has not settled yet. See PROVISIONAL_MARK in orders. */
const PROVISIONAL = '~';

/**
 * Does this order number belong to the run this prefix names?
 *
 * The prefix is stripped and what is left has to be nothing but digits. That
 * is what separates ORD0222 from S0004 when the prefix is "ORD", and — the
 * case that needs care — what separates a plain 0006 from S0004 when the
 * prefix is empty, where "starts with the prefix" would be true of everything.
 */
export function inRun(orderNo: string | undefined, prefix: string): boolean {
  if (!orderNo || orderNo.startsWith(PROVISIONAL)) return false;
  if (prefix && !orderNo.startsWith(prefix)) return false;
  const rest = prefix ? orderNo.slice(prefix.length) : orderNo;
  return rest.length > 0 && /^\d+$/.test(rest);
}

/** The number part of an order number, or nought when there is not one. */
export function numberIn(orderNo: string | undefined, prefix: string): number {
  if (!inRun(orderNo, prefix)) return 0;
  const rest = prefix ? (orderNo as string).slice(prefix.length) : (orderNo as string);
  return Number(rest) || 0;
}

/**
 * The next number for a run, given the orders already in it.
 *
 * The HIGHEST rather than the newest. A run only ever goes up, and reading the
 * most recently created row assumes the clock and the counter agree about
 * order — which they do not when two tills ring up a sale in the same second,
 * or when a guest's order is settled by the server a moment after a later one
 * was typed at the counter.
 *
 * `startAt` is where an empty run begins, so a business moving over from a
 * paper book can carry on from where the book left off.
 *
 * `skip` steps past numbers a collision has already proved are taken. It is
 * how the retry gets anywhere: without it a second attempt works out the same
 * number as the first and fails in exactly the same way.
 */
export function nextInRun(
  orderNos: (string | undefined)[],
  prefix: string,
  startAt = 1,
  skip = 0,
): number {
  let highest = 0;
  for (const no of orderNos) {
    const n = numberIn(no, prefix);
    if (n > highest) highest = n;
  }
  const next = highest === 0 ? Math.max(1, startAt) : highest + 1;
  return next + Math.max(0, skip);
}

/** The whole thing, padded, as it is printed and read out. */
export const formatOrderNo = (prefix: string, n: number, padding: number): string =>
  `${prefix}${String(n).padStart(Math.max(1, padding), '0')}`;
