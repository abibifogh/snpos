/**
 * Parking a sale, so the next customer can be served.
 *
 * A counter till serves one person at a time and holds one bill. That breaks
 * the moment somebody says "I'll take these three, and let me go and find the
 * other one" — the person behind them is now waiting on a decision that has
 * nothing to do with them. Every till of any size has a way to put a bill down
 * and pick it up again, and this is it.
 *
 * PARKED IS NOT ORDERED. Nothing is written to the database, nothing reaches
 * the pass, no stock moves, and no shift is held open by it. That is the whole
 * distinction: a parked sale is a basket somebody is still filling, and turning
 * it into a real unpaid order would put drinks on the bar screen that nobody
 * has asked to be poured and block the close on bills that do not exist.
 *
 * IT LIVES ON THE DEVICE, and the screen says so. A till is a place as much as
 * a program — the person coming back to collect their basket comes back to the
 * same counter — and syncing parked baskets between tills would mean two
 * people can pick up and pay for the same one. The cost is that a device
 * cleared or swapped loses them, which is why they are capped and aged rather
 * than kept for ever.
 *
 * Pure. Nothing here reads or writes; the caller owns the storage.
 */

/**
 * One line of a parked sale.
 *
 * Deliberately the same shape a cart line already has, add-ons included, so a
 * basket picked back up is the one that was put down rather than an
 * approximation of it. Losing the option and group ids would produce a bill
 * that looks right on screen and orders the wrong thing.
 */
export interface ParkedAddon {
  option_id: string;
  group_id: string;
  name: string;
  price_delta: number;
  qty?: number;
}

export interface ParkedLine {
  key: string;
  menu_item_id: string;
  name: string;
  unit_price: number;
  qty: number;
  addons?: ParkedAddon[];
  notes?: string;
  variant_id?: string;
  variant_label?: string;
  list_price?: number;
}

export interface ParkedSale {
  id: string;
  /** What to call it on the list. A name, a description, or nothing. */
  label: string;
  lines: ParkedLine[];
  /** Kept with it, so a parked bill resumes with the discount it had. */
  discount?: number;
  discountLabel?: string;
  discountId?: string;
  parkedAt: string;
  /** Who put it down, so a shift handing over knows whose basket this is. */
  by?: string;
}

/**
 * How many a device will hold.
 *
 * Not a technical limit. A counter with nine baskets behind it is a counter
 * where nobody can find the right one, and the honest answer at that point is
 * that they have stopped being parked sales and started being lost ones.
 */
export const MAX_PARKED = 8;

/** Where a device keeps them. Per venue and per side; a bar is not a shop. */
export const parkKey = (venueId: string, module: string): string =>
  `snpos.parked.${venueId}.${module}`;

/** What a parked sale comes to, so the list can be read without opening each. */
export const parkedTotal = (sale: ParkedSale): number =>
  sale.lines.reduce(
    (sum, l) => sum
      + (l.unit_price + (l.addons ?? []).reduce((a, x) => a + x.price_delta * (x.qty ?? 1), 0)) * l.qty,
    0,
  );

export const parkedCount = (sale: ParkedSale): number =>
  sale.lines.reduce((sum, l) => sum + l.qty, 0);

/** Why this cannot be parked, or nothing. */
export function parkProblem(lines: ParkedLine[], existing: ParkedSale[]): string | null {
  if (lines.length === 0) return 'There is nothing on this sale to park.';
  if (existing.length >= MAX_PARKED) {
    return `${MAX_PARKED} sales are already parked on this till. Finish or clear one before parking another — `
      + 'past that nobody can find the right basket.';
  }
  return null;
}

/**
 * Put one down.
 *
 * Newest first, because the one somebody wants back is nearly always the one
 * they just put down. A list in the order they were parked puts it at the
 * bottom and grows away from them.
 */
export function park(existing: ParkedSale[], sale: ParkedSale): ParkedSale[] {
  return [sale, ...existing.filter((s) => s.id !== sale.id)].slice(0, MAX_PARKED);
}

/** Pick one back up. Returns the sale and the list without it. */
export function unpark(
  existing: ParkedSale[],
  id: string,
): { sale: ParkedSale | null; rest: ParkedSale[] } {
  const sale = existing.find((s) => s.id === id) ?? null;
  return { sale, rest: existing.filter((s) => s.id !== id) };
}

/**
 * How long a basket sits before it is worth asking about.
 *
 * Four hours. Long enough that a customer who went to the cashpoint is not
 * nagged about, short enough that yesterday's abandoned basket is not still
 * sitting on the till at opening looking like a live sale.
 */
export const STALE_AFTER_MS = 4 * 3_600_000;

export const isStale = (sale: ParkedSale, now: Date = new Date()): boolean =>
  now.getTime() - Date.parse(sale.parkedAt) > STALE_AFTER_MS;

/** Roughly how long ago, in the words a person would use. */
export function parkedAgo(sale: ParkedSale, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(sale.parkedAt);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** The one line a parked sale shows on the list. */
export function describeParked(sale: ParkedSale, money: (n: number) => string, now?: Date): string {
  const count = parkedCount(sale);
  return `${count} item${count === 1 ? '' : 's'} · ${money(parkedTotal(sale))} · ${parkedAgo(sale, now)}`;
}

/**
 * A label somebody will recognise, when they did not type one.
 *
 * The first thing in the basket beats "Sale 3": a customer is remembered by
 * what they were buying, and a numbered list of anonymous baskets is one
 * where the wrong basket gets picked up.
 */
export function autoLabel(lines: ParkedLine[]): string {
  const first = lines[0];
  if (!first) return 'Empty sale';
  const more = lines.length - 1;
  return more > 0 ? `${first.name} and ${more} more` : first.name;
}
