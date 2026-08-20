/**
 * "That looks dear. Are you sure?"
 *
 * The moment to catch a wrong purchase figure is while the person who was at
 * the market is still standing at the screen. Afterwards it is a number in a
 * report that somebody has to reconstruct from memory — and a unit cost typed
 * with an extra nought does not merely record a wrong price, it revalues the
 * whole shelf and every dish the ingredient is in.
 *
 * NOTHING HERE BLOCKS ANYTHING. Prices genuinely triple: a bad harvest, a fuel
 * rise, a supplier of last resort at six in the evening. A system that refuses
 * the truth gets a smaller number typed into it, which is worse than the
 * surprise it was trying to prevent. So this asks, and then gets out of the
 * way, and writes down that it asked.
 *
 * TWO KINDS OF SURPRISE, and they are genuinely different questions.
 * Paying much more per unit is a price question — the market moved, or a nought
 * slipped. Buying much more than usual is a quantity question — a real bulk
 * buy, or "kg" typed where "g" was meant. Both revalue the shelf and neither
 * is visible in the other's figure.
 *
 * THE BASELINE IS THE MIDDLE, NOT THE AVERAGE. One purchase entered with an
 * extra nought drags a mean far enough to hide the next three mistakes behind
 * it; the median shrugs it off. This matters more than it looks, because the
 * first thing a business does with a new flag is discover the wrong entry that
 * has been sitting in the history all along.
 *
 * Pure. Nothing here reads or writes.
 */

export interface PastPurchase {
  at: string;
  qty: number;
  unitCost: number;
}

/**
 * How many past purchases before this is worth an opinion.
 *
 * Two is not a pattern. With one prior purchase every second purchase of
 * anything would be measured against a single figure that might itself be the
 * mistake — and a warning that fires on the second delivery of everything is
 * one people learn to dismiss before it ever means something.
 */
export const MIN_HISTORY = 3;

/** Dearer than usual by this much, in basis points. Forty per cent. */
export const PRICE_RISE_BP = 4_000;

/**
 * More than usual by this much, in basis points. Twice.
 *
 * Deliberately looser than the price threshold. Quantities are lumpy in a way
 * prices are not — a kitchen buys one sack this week and three before a
 * function, and neither is a mistake. What this is looking for is the missing
 * decimal point and the wrong unit, which are out by a factor, not by half.
 */
export const QTY_RISE_BP = 10_000;

/** The middle value, which one silly entry cannot drag. */
export function median(values: number[]): number {
  const usable = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (usable.length === 0) return 0;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[mid] : Math.round((usable[mid - 1] + usable[mid]) / 2);
}

export type FlagKind = 'price' | 'qty';

export interface PurchaseFlag {
  kind: FlagKind;
  /** What is being paid or bought now. */
  value: number;
  /** What this ingredient normally goes for, or is normally bought in. */
  typical: number;
  /** How far above typical, in basis points. */
  riseBp: number;
  /** How many past purchases the typical figure rests on. */
  seen: number;
  /** The question, in the words shown on screen. */
  message: string;
}

const riseBpOf = (value: number, typical: number): number =>
  typical > 0 ? Math.round(((value - typical) / typical) * 10_000) : 0;

/** How many times over, for a sentence rather than a percentage. */
const timesOver = (value: number, typical: number): string => {
  const times = typical > 0 ? value / typical : 0;
  return times >= 2 ? `${times.toFixed(times >= 10 ? 0 : 1)} times` : `${Math.round(riseBpOf(value, typical) / 100)}%`;
};

/**
 * Whether this purchase is worth a second look, and why.
 *
 * Returns every surprise it finds rather than the worst one. A line that is
 * both three times the price AND ten times the quantity is almost certainly a
 * unit mix-up, and saying only one of those would send somebody to check the
 * wrong half of it.
 *
 * Only ever looks UP. Something bought unusually cheaply is a good day, not a
 * mistake worth interrupting anybody over, and flagging it would double how
 * often this fires while halving what it means.
 */
export function flagPurchase(opts: {
  /** What is being paid per unit now, in minor units. */
  unitCost: number;
  /** How much is being bought now, in the ingredient's own unit. */
  qty: number;
  history: PastPurchase[];
  name?: string;
  priceRiseBp?: number;
  qtyRiseBp?: number;
  minHistory?: number;
}): PurchaseFlag[] {
  const {
    unitCost, qty, history,
    name = 'this',
    priceRiseBp = PRICE_RISE_BP,
    qtyRiseBp = QTY_RISE_BP,
    minHistory = MIN_HISTORY,
  } = opts;

  const past = history.filter((h) => Number.isFinite(h.unitCost) && h.unitCost > 0);
  if (past.length < minHistory) return [];

  const flags: PurchaseFlag[] = [];

  const typicalCost = median(past.map((h) => h.unitCost));
  if (unitCost > 0 && typicalCost > 0 && riseBpOf(unitCost, typicalCost) >= priceRiseBp) {
    flags.push({
      kind: 'price',
      value: unitCost,
      typical: typicalCost,
      riseBp: riseBpOf(unitCost, typicalCost),
      seen: past.length,
      message: `${name} normally costs about %TYPICAL% a unit. This is ${timesOver(unitCost, typicalCost)} more. `
        + 'Worth checking the amount before saving — it may well be right.',
    });
  }

  const typicalQty = median(past.map((h) => Math.abs(h.qty)));
  if (qty > 0 && typicalQty > 0 && riseBpOf(qty, typicalQty) >= qtyRiseBp) {
    flags.push({
      kind: 'qty',
      value: qty,
      typical: typicalQty,
      riseBp: riseBpOf(qty, typicalQty),
      seen: past.length,
      message: `${name} is usually bought about %TYPICALQTY% at a time. This is ${timesOver(qty, typicalQty)} more. `
        + 'Check the unit and the quantity — it may well be right.',
    });
  }

  return flags;
}

/** Whether anything on this whole shop run wants a second look. */
export const anyFlagged = (flags: PurchaseFlag[][]): boolean => flags.some((f) => f.length > 0);

export const FLAG_WORDS: Record<FlagKind, string> = {
  price: 'Dearer than usual',
  qty: 'More than usual',
};

/**
 * The one-line summary a review list shows.
 *
 * Written here rather than at the screen so the alert reads the same in the
 * list an admin opens next week as it did in the question somebody was asked
 * at the market.
 */
export function describeFlag(f: {
  kind: FlagKind;
  value: number;
  typical: number;
  name?: string;
  money: (n: number) => string;
  unit?: string;
}): string {
  const what = f.name ?? 'It';
  if (f.kind === 'price') {
    return `${what} was bought at ${f.money(f.value)} a ${f.unit ?? 'unit'}, against a usual `
      + `${f.money(f.typical)}.`;
  }
  return `${f.value}${f.unit ? ` ${f.unit}` : ''} of ${what} was bought, against a usual `
    + `${f.typical}${f.unit ? ` ${f.unit}` : ''}.`;
}

/**
 * Whether an alert still needs somebody to look at it.
 *
 * Absent means yes. Every row written before anybody could tick one off is
 * outstanding, which is what it is — reading a missing field as "already
 * handled" would quietly empty the list the day the field was added.
 */
export const isOutstanding = (a: { acknowledged?: boolean }): boolean => a.acknowledged !== true;
