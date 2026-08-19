/**
 * Undoing a delivery that was recorded wrongly.
 *
 * A goods-received note is not one record. It creates the delivery, a product
 * row for every piece on it, the stock those pieces put on the shelf, and the
 * movement saying where that stock came from. Deleting the note alone leaves
 * all four of the others: the pieces still on the floor, the count still
 * counting them, and nothing left saying why they are there.
 *
 * So "delete this delivery" has to mean all of it, which needs one decision
 * made per piece.
 *
 * Pure. Imports nothing at runtime.
 */

export interface PieceLike {
  $id: string;
  name: string;
  on_hand?: number;
  active?: boolean;
}

/**
 * What happens to one piece when its delivery is undone.
 *
 * Sold is the only thing that saves a row. A sale points at the product, and
 * so does the maker's commission on it; deleting underneath those leaves a
 * statement that will not add up and a receipt naming something that no longer
 * exists.
 *
 * Note what is NOT a reason here: stock still on the shelf. That is exactly
 * what SHOULD go — the delivery is being undone because it did not happen, so
 * the pieces were never there and the count must stop saying they were. The
 * ordinary product-deletion rule protects stock on hand; this one must not, or
 * undoing a mistaken delivery would leave its stock behind for ever.
 */
export function pieceFate(hasSold: boolean): 'delete' | 'archive' {
  return hasSold ? 'archive' : 'delete';
}

export interface UnwindPlan {
  /** Pieces that can go entirely: nothing points at them. */
  remove: PieceLike[];
  /** Pieces that have sold, so the row stays and is taken off the floor. */
  keep: PieceLike[];
}

export function planUnwind(pieces: PieceLike[], hasSold: (id: string) => boolean): UnwindPlan {
  const remove: PieceLike[] = [];
  const keep: PieceLike[] = [];
  for (const p of pieces) (pieceFate(hasSold(p.$id)) === 'delete' ? remove : keep).push(p);
  return { remove, keep };
}

/** What is about to happen, before somebody agrees to it. */
export function describeUnwind(plan: UnwindPlan): string {
  const bits: string[] = [];
  if (plan.remove.length) {
    const stock = plan.remove.reduce((n, p) => n + (p.on_hand ?? 0), 0);
    bits.push(`${plan.remove.length} piece${plan.remove.length === 1 ? '' : 's'} deleted`
      + (stock ? `, taking ${stock} off the shelf` : ''));
  }
  if (plan.keep.length) {
    bits.push(`${plan.keep.length} ${plan.keep.length === 1 ? 'has' : 'have'} already sold, so `
      + `${plan.keep.length === 1 ? 'it stays' : 'they stay'} on the record and ${plan.keep.length === 1 ? 'is' : 'are'} taken off the floor`);
  }
  if (bits.length === 0) return 'This delivery has no pieces left on it.';
  return `${bits.join('; ')}.`;
}

/**
 * The stock correction when a piece's quantity is edited rather than undone.
 *
 * Returns what to ADD to the shelf, which is negative when the delivery is
 * being corrected downwards. Written as a movement of its own rather than by
 * setting the count: a count somebody typed over tells you what it is now and
 * never what happened, and "why is this three when the note says five" is the
 * question a stocktake asks.
 */
export const stockDelta = (was: number, now: number): number => now - was;

/** Is this edit worth writing anything for? */
export const changed = (was: number, now: number): boolean => stockDelta(was, now) !== 0;
