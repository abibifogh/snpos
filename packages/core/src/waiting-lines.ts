/**
 * What is actually in the thing you are about to approve.
 *
 * The Waiting page could say "436 pieces missing, worth forty thousand cedis"
 * and give you two buttons. That is a decision nobody can make. Forty
 * thousand is either a shop that has been robbed or a count somebody typed
 * into the wrong column, and the two look identical from a summary line.
 *
 * So a row opens and shows its lines: what the shelf said, what was found,
 * what each difference is worth. Reading them is how "approve" stops being a
 * guess. Same for a spend: the market run is four bags of rice and a taxi,
 * and the person approving should see the four bags.
 *
 * Pure. Imports nothing at runtime. The reading is in waiting-detail.ts.
 */

export interface ReviewLine {
  /**
   * The stored row, so this one line can be approved or refused on its own.
   * Absent on a spend's lines, which are decided together.
   */
  id?: string;
  /** What it is. */
  name: string;
  /** A size, a maker, a reason: anything that belongs under the name. */
  note?: string;
  /** For a count: what the shelf believed, what was found, and the gap. */
  expected?: number;
  counted?: number;
  delta?: number;
  /** For a spend: how many, and what one costs. */
  qty?: number;
  unitCost?: number;
  /** What this line is worth, in minor units. Negative is money or stock lost. */
  worth: number;
  /** For a bar count: the shelf item, so it can be priced to charge to somebody. */
  ingredientId?: string;
  /** What one sells for — or, where nothing on the menu sells it, what one cost. */
  unitPrice?: number;
  /** Which of the two the worth is at. Selling, unless nothing sells it. */
  valuedAt?: 'selling' | 'cost';
}

/** Rows sorted so the ones worth arguing about are read first. */
export const worstFirst = (lines: ReviewLine[]): ReviewLine[] =>
  [...lines].sort((a, b) => Math.abs(b.worth) - Math.abs(a.worth));

/* ------------------------------------------------------------ bar counts */

export interface BarCheckRow {
  $id?: string;
  ingredient_id: string;
  counted_qty?: number;
  theoretical_qty?: number;
  variance_qty?: number;
  variance_value?: number;
}

/**
 * A bar count's lines.
 *
 * The value stored on the row is what the line is worth, and its sign already
 * says which way: a bottle short is negative. Kept as it is rather than made
 * positive, because "worth GH₵48" reads the same for a shortage and a
 * surplus, and those are not the same news.
 */
export function barReviewLines(
  checks: BarCheckRow[],
  nameOf: (ingredientId: string) => string,
  /**
   * What one of each sells for. A difference is valued at what the business
   * would have taken for it, not at what it paid; the stored cost is used
   * only where nothing on the menu sells the item.
   */
  sellingOf?: (ingredientId: string) => number | undefined,
): ReviewLine[] {
  return worstFirst(checks.map((c) => {
    const delta = c.variance_qty ?? 0;
    const selling = sellingOf?.(c.ingredient_id);
    const atSelling = typeof selling === 'number';
    return {
      id: c.$id,
      ingredientId: c.ingredient_id,
      name: nameOf(c.ingredient_id) || 'Something no longer on the list',
      expected: c.theoretical_qty ?? 0,
      counted: c.counted_qty ?? 0,
      delta,
      worth: atSelling ? Math.round(delta * selling) : (c.variance_value ?? 0),
      unitPrice: atSelling ? selling : (delta ? Math.abs(Math.round((c.variance_value ?? 0) / delta)) : undefined),
      valuedAt: atSelling ? 'selling' as const : 'cost' as const,
    };
  }));
}

/**
 * Bar count rows with their differences valued at selling price, for the
 * totals on a list. Rows nothing sells keep their stored (cost) value.
 */
export function atSellingPrice<T extends BarCheckRow>(checks: T[], selling: Record<string, { price: number }>): T[] {
  return checks.map((c) => {
    const price = selling[c.ingredient_id]?.price;
    return typeof price === 'number' ? { ...c, variance_value: Math.round((c.variance_qty ?? 0) * price) } : c;
  });
}

/* ----------------------------------------------------------- shop counts */

export interface ShopCountRow {
  $id?: string;
  name_snapshot: string;
  variant_label?: string;
  consignor_name?: string;
  expected: number;
  counted: number;
  delta: number;
  reason?: string;
  unit_price: number;
}

/** What each reason is called on a page somebody reads rather than types into. */
export const REASON_WORDS: Record<string, string> = {
  counted: 'a miscount',
  damaged: 'broken or damaged',
  lost: 'missing',
  returned: 'gone back to the maker',
};

export function shopReviewLines(rows: ShopCountRow[]): ReviewLine[] {
  return worstFirst(rows.map((r) => ({
    id: r.$id,
    name: r.name_snapshot,
    note: [
      r.variant_label,
      r.consignor_name,
      // Only where it says something. "A miscount" is the default and adds
      // nothing to a line whose numbers already say so.
      r.reason && r.reason !== 'counted' ? REASON_WORDS[r.reason] ?? r.reason : '',
    ].filter(Boolean).join(' · ') || undefined,
    expected: r.expected,
    counted: r.counted,
    delta: r.delta,
    worth: r.delta * r.unit_price,
    unitPrice: r.unit_price,
    valuedAt: 'selling' as const,
  })));
}

/* ---------------------------------------------------------------- spends */

export interface SpendItemRow {
  name_snapshot: string;
  qty?: number;
  unit_cost?: number;
  line_total?: number;
}

export function spendReviewLines(rows: SpendItemRow[]): ReviewLine[] {
  return rows.map((r) => ({
    name: r.name_snapshot,
    qty: r.qty ?? 0,
    unitCost: r.unit_cost ?? 0,
    worth: r.line_total ?? Math.round((r.qty ?? 0) * (r.unit_cost ?? 0)),
  }));
}

/**
 * What the lines add up to, against what the row claims.
 *
 * Worth showing side by side: a spend whose lines come to less than the
 * amount is a receipt with something on it nobody wrote down, and that is
 * exactly the spend an approver should be asking about.
 */
export function linesAgainst(lines: ReviewLine[], claimed: number): {
  total: number;
  off: number;
  agrees: boolean;
} {
  const total = lines.reduce((s, l) => s + l.worth, 0);
  const off = total - claimed;
  return { total, off, agrees: Math.abs(off) <= 1 };
}

/** Words for a spend whose lines do not add up to what it says it was. */
export function offWords(off: number, money: (n: number) => string): string {
  if (off === 0) return '';
  return off > 0
    ? `The lines come to ${money(Math.abs(off))} MORE than the spend says.`
    : `The lines come to ${money(Math.abs(off))} less than the spend says, so something on the receipt was not listed.`;
}
