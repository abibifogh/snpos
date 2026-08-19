/**
 * A menu running on a screen that stays put.
 *
 * A phone belongs to one customer: they order, they watch the status, they put
 * it in their pocket. A screen on a counter belongs to whoever is standing in
 * front of it, and the person after them finds the last customer's order still
 * on it — with no way back to the menu, because the way back is a button that
 * only appears when an order has gone missing.
 *
 * So the screen takes itself back to the menu, and a phone never does. Getting
 * that the wrong way round would snatch the status away from somebody watching
 * their own food being cooked, which is worse than the problem.
 *
 * Opt-in through the address, so it is a property of the SCREEN rather than of
 * the venue: the same walk-in link works on a counter display and on a
 * customer's phone, and only the display is bookmarked with the flag.
 *
 * Pure. Imports nothing at runtime.
 */

/** Long enough to read "sent to the kitchen" and the order number, and no longer. */
export const SCREEN_RETURN_SECONDS = 20;

/**
 * Is this a shared screen?
 *
 * `?screen=1` on the address. Anything else, including its absence, is
 * somebody's own phone — the safe answer, because the cost of being wrong
 * that way is a screen that needs a tap, and the cost of being wrong the
 * other way is a customer losing sight of their order.
 */
export function isScreenMode(search: string): boolean {
  const value = new URLSearchParams(search).get('screen');
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * How long is left before it goes back, given when the wait started.
 *
 * Counted from a fixed start rather than ticked down, so a screen whose timer
 * was throttled while the tab was in the background does not sit on "3
 * seconds" for a minute and a half.
 */
export function secondsLeft(startedAt: number, now: number, total = SCREEN_RETURN_SECONDS): number {
  const gone = Math.floor((now - startedAt) / 1000);
  return Math.max(0, total - gone);
}

/**
 * The line under the order, counting down.
 *
 * Said out loud rather than left as a silent timer. A screen that changes on
 * its own with no warning reads as a fault, and the customer who was still
 * reading their order number has no idea what happened to it.
 */
export function returningLine(left: number): string {
  if (left <= 0) return 'Returning to the menu…';
  return `Returning to the menu in ${left} second${left === 1 ? '' : 's'}. Touch the screen to stay.`;
}
