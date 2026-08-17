/**
 * Buying in one unit and counting in another.
 *
 * A bar buys a bottle of Havana Club and pours it as shots. Both are true at
 * once, and neither is a conversion anybody should be doing in their head at
 * the end of a shop run: "I bought two bottles" has to become "the shelf holds
 * fifty-six shots" without somebody multiplying by twenty-eight and getting it
 * wrong at eleven at night.
 *
 * The counting unit stays the one on the ingredient, because that is what the
 * count sheet asks for and what a recipe draws on. The pack is only a way of
 * saying how many of those arrive at once.
 *
 * TWO things convert, not one. The quantity is the obvious half; the price is
 * the half that quietly ruins the books. A bottle at GHS 300 recorded as GHS
 * 300 per shot values the shelf at twenty-eight times what is on it, and every
 * dish costing and every stock figure downstream inherits that. So a pack
 * price is divided by the pack size before it is stored, always.
 *
 * Pure. What a pack means can be checked without a database.
 */

export interface Packable {
  unit: string;
  /** How many counting units come in one pack. 0 or 1 means it is not sold in packs. */
  pack_size?: number;
  /** What the pack is called in the trade: bottle, crate, case. */
  pack_name?: string;
}

/**
 * A pack of one is not a pack.
 *
 * Every ingredient that existed before this question has no pack size, and a
 * kitchen buying rice by the kilo never wants one. Both land here as "no", so
 * nothing about the old way of recording a delivery changes.
 */
export function hasPack(ing: Packable): boolean {
  const size = ing.pack_size ?? 0;
  return Number.isFinite(size) && size > 1;
}

export function packSize(ing: Packable): number {
  return hasPack(ing) ? (ing.pack_size as number) : 1;
}

export function packName(ing: Packable): string {
  return (ing.pack_name ?? '').trim() || 'pack';
}

export interface BuyOption {
  /** 'pack' buys in bottles or crates; 'unit' buys in whatever it is counted in. */
  key: 'pack' | 'unit';
  /** What to put on the button: "bottles", "shots". */
  label: string;
  /** How many counting units one of these is. */
  per: number;
}

/**
 * The choices to offer when recording a delivery.
 *
 * An item with no pack gets one choice, which the form can then not bother
 * showing — asking somebody to pick between one option is a question with no
 * information in it.
 */
export function buyOptions(ing: Packable): BuyOption[] {
  const unit: BuyOption = { key: 'unit', label: plural(ing.unit), per: 1 };
  if (!hasPack(ing)) return [unit];
  return [{ key: 'pack', label: plural(packName(ing)), per: packSize(ing) }, unit];
}

/** Buying is usually by the pack when there is one; that is the point of setting it. */
export function defaultBuyOption(ing: Packable): BuyOption {
  return buyOptions(ing)[0];
}

function plural(word: string): string {
  const w = (word || '').trim();
  if (!w) return 'units';
  // Units that read the same either way. "2 kgs" and "2 mls" are not things
  // people write, and a form that prints them looks like it was not finished.
  if (['g', 'kg', 'ml', 'l', 'cl', 'each'].includes(w.toLowerCase())) return w;
  if (/(s|sh|ch|x|z)$/i.test(w)) return `${w}es`;
  return `${w}s`;
}

/** How many counting units a purchase comes to. */
export function toCountingUnits(qty: number, per: number): number {
  if (!Number.isFinite(qty) || !Number.isFinite(per) || per <= 0) return 0;
  // Four places, matching how quantities are stored everywhere else. A third
  // of a crate is a real thing somebody types.
  return Number((qty * per).toFixed(4));
}

/**
 * What one counting unit cost, given what the pack cost.
 *
 * Rounds to the pesewa, which does not divide evenly for most pack sizes: a
 * GHS 300 bottle of twenty-eight shots is 10.7142... per shot. The rounded
 * figure is what values the shelf and prices a cocktail; the amount actually
 * handed over is stored separately as the line total, so the books balance
 * against the receipt rather than against the division. That is the same rule
 * the expense forms already follow for a split payment.
 */
export function costPerCountingUnit(packCost: number, per: number): number {
  if (!Number.isFinite(packCost) || !Number.isFinite(per) || per <= 0) return 0;
  return Math.round(packCost / per);
}

export interface PurchaseConversion {
  /** What goes on the shelf, in counting units. */
  qty: number;
  /** What one counting unit cost, in minor units. */
  unitCost: number;
  /** What was handed over in total, in minor units — the receipt figure. */
  lineTotal: number;
}

/**
 * One delivery line, converted.
 *
 * `qty` and `cost` are in whatever the person is buying in. `cost` is the
 * price of ONE of those — one bottle, one crate — because that is the number
 * printed on an invoice.
 */
export function convertPurchase(opts: {
  qty: number;
  costPerBought: number;
  per: number;
}): PurchaseConversion {
  const { qty, costPerBought, per } = opts;
  return {
    qty: toCountingUnits(qty, per),
    unitCost: costPerCountingUnit(costPerBought, per),
    // Rounded once, at the end, off the figures actually typed. Multiplying
    // the rounded per-shot cost back up would be out by a pesewa a shot, and
    // twenty-eight of those is a discrepancy somebody has to chase.
    lineTotal: Math.round(qty * costPerBought),
  };
}

/**
 * The sentence shown back before it is saved.
 *
 * The whole risk of this feature is somebody buying two bottles and getting
 * fifty-six of something they did not expect, so the arithmetic is said out
 * loud rather than done quietly. If the sentence looks wrong, the pack size
 * is wrong, and it is far cheaper to find that here.
 */
export function describePurchase(opts: {
  qty: number;
  option: BuyOption;
  ing: Packable;
  money: (minor: number) => string;
  unitCost?: number;
}): string {
  const { qty, option, ing, money, unitCost } = opts;
  if (option.per <= 1 || !qty) return '';
  const total = toCountingUnits(qty, option.per);
  const each = unitCost !== undefined ? `, at ${money(unitCost)} a ${ing.unit}` : '';
  return `${trim(qty)} ${option.label} = ${trim(total)} ${plural(ing.unit)} on the shelf${each}.`;
}

const trim = (n: number) => String(Number(n.toFixed(4)));

/**
 * Whether a pack size somebody typed is usable, and why not if it is not.
 *
 * A pack size of nought would divide a price by nothing and put every level at
 * zero, so it is refused rather than defaulted — a silent default here is a
 * shelf that empties itself.
 */
export function packProblem(size: number, unit: string, name: string): string | null {
  if (!Number.isFinite(size)) return 'How many come in a pack has to be a number.';
  if (size < 0) return 'A pack cannot hold less than none.';
  if (size > 0 && size < 1) {
    return 'A pack holds at least one. If you buy a fraction of one, count it in the smaller unit instead.';
  }
  if (size > 1 && !name.trim()) {
    return 'Say what the pack is called — bottle, crate, case — so the buying form can ask for the right thing.';
  }
  if (size > 1 && name.trim().toLowerCase() === unit.trim().toLowerCase()) {
    return `This is counted in ${unit}, so a pack called "${name.trim()}" would mean `
      + `${trim(size)} ${plural(unit)} in one ${unit.trim()}. Give the pack its own name.`;
  }
  return null;
}
