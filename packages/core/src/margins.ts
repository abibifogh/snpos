/**
 * What a drink costs to make, and what is left after it.
 *
 * A price on its own says nothing about whether selling the thing is worth
 * doing. A cocktail at forty cedis made of thirty cedis of rum is a busy
 * evening that pays for the rum, and the only way anybody finds that out is by
 * putting the two figures side by side.
 *
 * The cost comes from the recipe, at what the ingredients are currently
 * carried at — not what they cost when the recipe was written. A bottle whose
 * price went up last week makes every drink poured from it thinner today, and
 * a costing that quotes last year's invoice is a costing that always looks
 * fine.
 *
 * Pure. The arithmetic behind a red margin can be checked without a database,
 * which matters because it is the number somebody will change a price over.
 */

export interface CostedRecipeLine {
  ingredientId: string;
  qtyPerUnit: number;
  wastageBp: number;
}

export interface CostedIngredient {
  $id: string;
  base_unit_cost: number;
}

/** The default line below which a margin is worth looking at. 30%. */
export const MARGIN_WARN_BP_DEFAULT = 3000;

/**
 * What one of these costs to make, in minor units.
 *
 * Wastage counts. The measure that misses the glass was still poured, and a
 * costing that ignores it flatters every drink by the same few percent —
 * which is exactly the size of the difference somebody is trying to see.
 */
export function itemCost(lines: CostedRecipeLine[], ingredients: CostedIngredient[]): number {
  const by = new Map(ingredients.map((i) => [i.$id, i]));
  let total = 0;
  for (const l of lines) {
    const ing = by.get(l.ingredientId);
    if (!ing) continue;
    total += l.qtyPerUnit * (1 + (l.wastageBp || 0) / 10_000) * ing.base_unit_cost;
  }
  return Math.round(total);
}

export interface Margin {
  /** What it costs to make. */
  cost: number;
  /** Price less cost, which can be negative and often is the point. */
  profit: number;
  /**
   * Profit as a share of the PRICE, in basis points.
   *
   * Of the price rather than of the cost, because that is what "margin" means
   * to everybody who reads a report: the part of the takings the business
   * keeps. The other answer — profit over cost — is a markup, is a bigger
   * number for the same drink, and quoting one while calling it the other is
   * how a bar convinces itself it is doing better than it is.
   */
  bp: number;
  /** No recipe, so nothing can be said. Not the same as a margin of nothing. */
  unknown: boolean;
}

export function marginOf(price: number, lines: CostedRecipeLine[], ingredients: CostedIngredient[]): Margin {
  if (lines.length === 0) return { cost: 0, profit: 0, bp: 0, unknown: true };
  const cost = itemCost(lines, ingredients);
  const profit = price - cost;
  // A free item has no margin to speak of rather than an infinite one.
  const bp = price > 0 ? Math.round((profit / price) * 10_000) : 0;
  return { cost, profit, bp, unknown: false };
}

/**
 * Worth flagging?
 *
 * A drink with no recipe is never flagged. It is not a thin margin, it is an
 * unanswered question, and colouring it red would train people to ignore the
 * colour on the ones that are real.
 */
export function marginIsThin(m: Margin, warnBp = MARGIN_WARN_BP_DEFAULT): boolean {
  if (m.unknown) return false;
  return m.bp < warnBp;
}

/** For a heading or a tooltip: 42% rather than 4200. */
export const bpAsPercent = (bp: number): string => `${(bp / 100).toFixed(0)}%`;
