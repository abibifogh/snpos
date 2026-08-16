/**
 * Where stock physically is, not just how much of it there is.
 *
 * A bar buys a case of tonic into a store room and carries bottles out to the
 * bar as the night needs them. One number cannot describe that. "Forty-two
 * tonics" is true of the business and useless to the person behind the bar,
 * who has nine and is about to run out — and useless to whoever does the
 * ordering, who sees forty-two and buys nothing.
 *
 * So stock is held per place, and the total is the sum rather than the record.
 * That ordering matters: a total kept as its own number drifts away from the
 * places it claims to add up, and the drift is invisible because both figures
 * look authoritative.
 *
 * Three rules, and everything else follows from them:
 *
 *   - what is BOUGHT lands in the store, because that is where a delivery is
 *     put down;
 *   - what is SOLD or poured comes off the counter, because that is what the
 *     customer was handed;
 *   - moving between them is one act with two ends, never a subtraction here
 *     and an addition there, or a crash between the two leaves stock that
 *     exists in neither place.
 *
 * Pure. Where a movement lands and whether a transfer is possible can both be
 * checked without a database.
 */

/** What a place is for. The kind decides where stock lands by default. */
export type LocationKind = 'store' | 'counter';

export const LOCATION_KINDS: { value: LocationKind; label: string; help: string }[] = [
  {
    value: 'store',
    label: 'Store room',
    help: 'Where deliveries are put down. Nothing is sold from here; stock is carried out to a counter first.',
  },
  {
    value: 'counter',
    label: 'Counter',
    help: 'The bar itself, or a shop floor. What is sold or poured comes off here, and this is what gets counted at the start and end of a shift.',
  },
];

export interface StockLocation {
  $id: string;
  name: string;
  kind: LocationKind;
  /** Which side of the business it belongs to. */
  module?: string;
  active?: boolean;
  sort?: number;
}

/**
 * How much of one thing is in one place.
 *
 * Named for the place rather than for the level, because `StockLevel` already
 * means something else here — "ok, low or out", the thing a cook is shown at a
 * shift-end check — and two things called StockLevel in one export surface is
 * a name that means whichever the importer guessed.
 */
export interface LocationStock {
  ingredient_id: string;
  location_id: string;
  qty: number;
}

/**
 * Where a delivery lands, and where a sale comes off.
 *
 * A business with one place has both answers the same, and that is the point:
 * everything below works unchanged for a kitchen that has never heard of a
 * store room, because its one location is both.
 *
 * Falls back to the first place of any kind rather than to nothing. A venue
 * that has set up one counter and no store still has somewhere to put a
 * delivery, and refusing the purchase because no room is labelled "store"
 * would be refusing it over a label.
 */
export function purchaseLocation(locations: StockLocation[], module?: string): StockLocation | null {
  const mine = openIn(locations, module);
  return mine.find((l) => l.kind === 'store') ?? mine[0] ?? null;
}

export function saleLocation(locations: StockLocation[], module?: string): StockLocation | null {
  const mine = openIn(locations, module);
  return mine.find((l) => l.kind === 'counter') ?? mine[0] ?? null;
}

/** This side's places, in the order they should be offered. */
export function openIn(locations: StockLocation[], module?: string): StockLocation[] {
  return locations
    .filter((l) => l.active !== false && (!module || (l.module ?? 'kitchen') === module))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
}

/** How much of one thing is in one place. Absent means none, not unknown. */
export const levelFor = (levels: LocationStock[], ingredientId: string, locationId: string): number =>
  levels.find((l) => l.ingredient_id === ingredientId && l.location_id === locationId)?.qty ?? 0;

/**
 * Everything, everywhere, for one ingredient.
 *
 * The figure the ordering decision is made on, and deliberately not the figure
 * the bar reads. A bar about to run dry needs to know what is behind the bar,
 * and being told the business has forty-two is being told about somebody
 * else's shelf.
 */
export const totalFor = (levels: LocationStock[], ingredientId: string): number =>
  levels.filter((l) => l.ingredient_id === ingredientId).reduce((sum, l) => sum + l.qty, 0);

export interface TransferLine {
  ingredientId: string;
  name: string;
  unit: string;
  /** How much is at the FROM end right now, for checking against. */
  available: number;
  qtyText?: string;
}

/** A quantity somebody actually typed, as a number, or null. */
export function transferQty(line: TransferLine): number | null {
  const text = (line.qtyText ?? '').trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What is wrong with this transfer, or null when it is fine.
 *
 * Moving more than the store holds is allowed and warned about rather than
 * refused. The shelf is the truth and the book is a claim about it: somebody
 * standing in the store room holding four cases the system says are three is
 * looking at the answer, and a system that argues is a system they route
 * around by not recording the transfer at all. The count is what settles it.
 *
 * Moving to the place it already is, on the other hand, is refused outright —
 * it cannot be what anybody meant, and it would write a movement that says
 * nothing happened.
 */
export function transferProblem(
  from: StockLocation | null,
  to: StockLocation | null,
  lines: TransferLine[],
): string | null {
  if (!from || !to) return 'Choose where the stock is coming from and where it is going.';
  if (from.$id === to.$id) return `${from.name} is both ends of this transfer. Choose a different destination.`;
  if (!lines.some((l) => transferQty(l) !== null)) return 'Nothing to move. Enter how much of at least one thing.';
  return null;
}

/** Lines being moved in quantities the source does not appear to hold. */
export function overdrawn(lines: TransferLine[]): TransferLine[] {
  return lines.filter((l) => {
    const q = transferQty(l);
    return q !== null && q > l.available;
  });
}

/**
 * Where one movement lands, given what kind it is.
 *
 * One place, in one file, because the alternative is each screen deciding for
 * itself — and the day the till decides a sale comes off the store while the
 * count checks the counter is the day the two stop being reconcilable, with
 * nothing on screen to say which is wrong.
 */
export function locationForMovement(
  type: string,
  locations: StockLocation[],
  module?: string,
): StockLocation | null {
  switch (type) {
    case 'purchase':
      return purchaseLocation(locations, module);
    case 'sale_depletion':
    case 'waste':
      return saleLocation(locations, module);
    default:
      // A count correction or an adjustment names its own place: somebody was
      // standing somewhere when they counted, and guessing which room would
      // move stock they never looked at.
      return null;
  }
}

/**
 * The two movements a transfer is made of, from one instruction.
 *
 * Written as a pair from a single description so neither can be produced
 * without the other. A transfer recorded as an independent subtraction and
 * addition is one that can half-fail, and stock that exists in neither place
 * is the hardest kind of discrepancy to find: every individual number looks
 * plausible and only the total is wrong.
 */
export function transferMovements(opts: {
  fromId: string;
  toId: string;
  ingredientId: string;
  qty: number;
  unitCost: number;
  note?: string;
}): { location_id: string; to_location_id: string; qty_delta: number; type: 'transfer' }[] {
  const { fromId, toId, ingredientId, qty, unitCost, note } = opts;
  void ingredientId; void unitCost; void note;
  return [
    { location_id: fromId, to_location_id: toId, qty_delta: -Math.abs(qty), type: 'transfer' },
    { location_id: toId, to_location_id: fromId, qty_delta: Math.abs(qty), type: 'transfer' },
  ];
}
