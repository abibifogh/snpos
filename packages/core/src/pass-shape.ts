/**
 * What the kitchen screen is, this week.
 *
 * TWO QUESTIONS THAT WERE ONE SWITCH, and separating them is the whole of this
 * file.
 *
 *   Does this pass take money?   — combined mode. The cook takes the order,
 *                                  cooks it and settles the bill from one
 *                                  screen. A large decision about how the
 *                                  floor is run.
 *
 *   Does this pass hold cash?    — a much smaller one. A kitchen that sells
 *                                  anything has a drawer: the change for a
 *                                  takeaway, the gas money, what somebody
 *                                  handed over at the hatch.
 *
 * The second was only ever reachable through the first. So a kitchen that
 * wanted to count its own float had to turn its pass into a till, and one that
 * did not was left with its drawer counted on the TILL — by whoever happened to
 * be standing there, for money they had not touched all night, while the cooks
 * who did hold it had no way to say what was in it.
 *
 * Named here rather than read as two booleans at each screen, because that is
 * how they came to be tied together in the first place: a condition written
 * once in a component, meaning one thing, and read later as though it meant the
 * other.
 *
 * Pure. Parameters are described by the fields they read, so this file imports
 * nothing at runtime.
 */

/** As much of a resolved feature map as these questions need. */
export type FlagStates = Record<string, { enabled?: boolean } | undefined>;

const on = (flags: FlagStates, key: string): boolean => flags[key]?.enabled === true;

/**
 * May a bill be settled at the pass?
 *
 * Combined mode and nothing else. Holding cash does not make a kitchen screen
 * a till: a drawer with the gas money in it settles no bills.
 */
export const passTakesPayment = (flags: FlagStates): boolean => on(flags, 'combined_mode');

/**
 * Does the kitchen have a drawer of its own to open, count and close?
 *
 * True under combined mode as well, because a pass that takes money
 * necessarily holds some — turning the second switch off must not take the
 * float away from a screen that is ringing up sales.
 */
export const passHoldsCash = (flags: FlagStates): boolean =>
  on(flags, 'kitchen_cash') || on(flags, 'combined_mode');
