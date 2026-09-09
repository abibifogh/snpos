/**
 * What a unit on the shelf is worth, once more of it has been bought.
 *
 * The shelf used to be valued at whatever the LAST delivery cost. One dear
 * bottle bought from a supplier of last resort at six in the evening
 * revalued the forty already on the shelf, and the night's cost of sales
 * jumped with it; the next ordinary delivery dropped it all back. A margin
 * that moves with the last receipt is a margin nobody can read.
 *
 * So the cost is the weighted average: what is on the shelf at what it was
 * worth, plus what arrived at what it cost, over the lot. A dear bottle moves
 * the average by one bottle's worth, which is what it did to the money.
 *
 * Pure. Imports nothing at runtime.
 */

export interface CostingInput {
  /** What is on the shelf before the delivery, in counting units. */
  onHand: number;
  /** What each of those is currently valued at, minor units. */
  currentCost: number;
  /** What arrived. */
  boughtQty: number;
  /** What each of those cost, minor units, in the same counting unit. */
  boughtCost: number;
}

/**
 * The new cost per unit after a delivery.
 *
 * A shelf with nothing on it, or an oversold one showing less than nothing,
 * takes the delivery's price outright: there is nothing to average against
 * and a negative weight would be nonsense. A delivery with no price leaves the
 * cost alone, as a gift or a stock adjustment should.
 */
export function weightedUnitCost(input: CostingInput): number {
  const bought = Math.max(0, input.boughtQty);
  const price = Math.max(0, Math.round(input.boughtCost));
  if (bought === 0 || price === 0) return Math.max(0, Math.round(input.currentCost));

  const held = Math.max(0, input.onHand);
  const current = Math.max(0, Math.round(input.currentCost));
  if (held === 0 || current === 0) return price;

  return Math.round((held * current + bought * price) / (held + bought));
}

/** The words under the cost box, so nobody types over an average by accident. */
export const AVERAGE_COST_WORDS =
  'The average of what you have paid, weighted by how much. Each delivery moves it a little; '
  + 'typing here overrides it until the next delivery.';
