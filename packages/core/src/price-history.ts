/**
 * What an ingredient has cost, over time.
 *
 * A restaurant's margin is eaten quietly. Nobody announces that rice has gone
 * up eleven percent since March; it arrives one delivery at a time, each one
 * unremarkable next to the last, and the first anybody knows is a bad month
 * with no single cause to point at. Every purchase is already recorded with
 * what was paid for it — this is the reading of it.
 *
 * Pure, so the arithmetic behind "up 18% since you started buying it" can be
 * checked without a database. Deliberately plain arithmetic, too: no smoothing
 * and no trend line, because the honest answer to "what is happening to the
 * price of rice" is the list of what was actually paid, and a fitted curve
 * over nine data points is a decoration that invites more confidence than the
 * data earns.
 */

export interface PurchaseRow {
  /** When it was bought. ISO, as the movement was stamped. */
  at: string;
  /** How much came in. Negative or zero rows are not purchases. */
  qty: number;
  /** Price per unit, in minor units. */
  unitCost: number;
  /** Which expense or delivery it came from, for drilling back. */
  refType?: string;
  refId?: string;
  note?: string;
}

export interface PricePoint extends PurchaseRow {
  /** What this line came to. */
  total: number;
  /** Change from the purchase before it, in minor units. Null for the first. */
  changeFromPrevious: number | null;
  /** The same, in basis points. Null for the first, or when the last was free. */
  changeBp: number | null;
}

export interface PriceHistory {
  points: PricePoint[];
  /** Oldest and newest prices actually paid. */
  first: number | null;
  latest: number | null;
  cheapest: number | null;
  dearest: number | null;
  /** Latest against first, in basis points. Null when there is nothing to compare. */
  moveBp: number | null;
  /** What a unit has cost on average, weighted by how much was bought. */
  averageUnitCost: number | null;
  /** Total quantity and total spent across the window. */
  totalQty: number;
  totalSpent: number;
}

/** Only rows that are actually a purchase at a price. */
const usable = (r: PurchaseRow): boolean =>
  r.qty > 0 && r.unitCost > 0 && Number.isFinite(Date.parse(r.at));

/**
 * The history, oldest first.
 *
 * Oldest first because that is the direction a price moves in, and reading a
 * column of numbers to see whether they are climbing is much harder upside
 * down. The screen can reverse it for display; the arithmetic should not have
 * to think about which way round it is.
 *
 * Rows with no price are dropped rather than counted as free. A stock movement
 * can carry a zero cost — a count correction, an adjustment, an ingredient
 * added before anybody knew what it cost — and averaging those in would report
 * that rice is getting cheaper every time somebody recounts the shelf.
 */
export function priceHistory(rows: PurchaseRow[]): PriceHistory {
  const sorted = rows.filter(usable).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const points: PricePoint[] = sorted.map((r, i) => {
    const previous = i > 0 ? sorted[i - 1].unitCost : null;
    return {
      ...r,
      total: Math.round(r.unitCost * r.qty),
      changeFromPrevious: previous === null ? null : r.unitCost - previous,
      changeBp: previous === null || previous === 0
        ? null
        : Math.round(((r.unitCost - previous) / previous) * 10_000),
    };
  });

  if (points.length === 0) {
    return {
      points, first: null, latest: null, cheapest: null, dearest: null,
      moveBp: null, averageUnitCost: null, totalQty: 0, totalSpent: 0,
    };
  }

  const first = points[0].unitCost;
  const latest = points[points.length - 1].unitCost;
  const totalQty = points.reduce((s, p) => s + p.qty, 0);
  const totalSpent = points.reduce((s, p) => s + p.total, 0);

  return {
    points,
    first,
    latest,
    cheapest: Math.min(...points.map((p) => p.unitCost)),
    dearest: Math.max(...points.map((p) => p.unitCost)),
    // Only meaningful once there are two of them. One purchase has not moved.
    moveBp: points.length > 1 && first > 0 ? Math.round(((latest - first) / first) * 10_000) : null,
    /**
     * Weighted by quantity, not a mean of the prices.
     *
     * Five sacks at 100 and one at 200 is not an average of 150. A plain mean
     * of the prices lets a single small emergency purchase at a corner shop
     * drag the figure a recipe is costed against.
     */
    averageUnitCost: totalQty > 0 ? Math.round(totalSpent / totalQty) : null,
    totalQty,
    totalSpent,
  };
}

/**
 * A short sentence about which way the price has gone.
 *
 * Written rather than left as a percentage, because "up 18%" needs a reader to
 * remember what it is 18% of, and the point of the line is to be understood at
 * a glance by somebody who came here about something else.
 *
 * Silent below a percent either way. Prices wobble by rounding and by which
 * market somebody went to; calling half a percent a rise would make this line
 * cry wolf until nobody read it.
 */
export function priceMoveNote(history: PriceHistory): string | null {
  if (history.moveBp === null || history.points.length < 2) return null;
  const pct = Math.abs(history.moveBp) / 100;
  if (pct < 1) return 'The price has held steady.';
  const times = history.points.length;
  const direction = history.moveBp > 0 ? 'up' : 'down';
  return `${direction === 'up' ? 'Up' : 'Down'} ${pct.toFixed(0)}% since the first of ${times} purchases.`;
}
