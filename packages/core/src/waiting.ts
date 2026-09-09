/**
 * Everything waiting for somebody senior, as one list.
 *
 * A held bar count sat on the bar page, a shop stocktake on the stocktake
 * page, a shelf change on the products page, a spend nobody had looked at on
 * the expenses page, and a shift that could not close for the tabs on it on
 * the shifts page. Five places to look, so nobody looked in all five, and the
 * email that said "three things are waiting" sent people to three screens.
 *
 * This shapes all of them into one row each, oldest first, so one page can
 * show them and the same page can decide them. The reads and the writes live
 * next door; this file imports nothing at runtime so the rules can be tested
 * without a database.
 */

/** What kind of thing is waiting. The filter chips are these, plus "all". */
export type WaitingKind = 'count' | 'spend' | 'shelf' | 'tab';

export const WAITING_KIND_WORDS: Record<WaitingKind, string> = {
  count: 'Counts',
  spend: 'Spends',
  shelf: 'Shelf changes',
  tab: 'Tabs to release',
};

/** How the page finds the thing again when a button on the row is pressed. */
export type WaitingRef =
  | { kind: 'bar_count'; shiftId: string; phase: 'open' | 'close' }
  | { kind: 'shop_count'; countId: string }
  | { kind: 'shelf'; countId: string }
  | { kind: 'spend'; expenseId: string }
  | { kind: 'tab'; shiftId: string; module: string; venueId: string };

export interface WaitingItem {
  /** Unique across kinds, so a list of mixed rows can key on it. */
  id: string;
  kind: WaitingKind;
  /** What it is, in the words of the person who will decide it. */
  title: string;
  /** What deciding it does, and what the row says. */
  detail: string;
  /** Who put it there: a user id, resolved to a name by the screen. */
  by?: string;
  /** When it started waiting, ISO. Empty when the record never said. */
  at: string;
  /** What it is worth, in minor units. Differences for a count, the amount for a spend. */
  value: number;
  ref: WaitingRef;
}

/**
 * The note a change made on the products page carries.
 *
 * A shelf change and a shop stocktake are the same row in the same table; the
 * note is the only thing that says which. Named here so the code that writes
 * it and the code that reads it cannot disagree by a full stop.
 */
export const SHELF_CHANGE_NOTE = 'Changed on the products page.';

export interface WaitingBarCount {
  shiftId: string;
  phase: 'open' | 'close';
  at: string;
  worth: number;
  changed: number;
  pending: number;
  countedBy?: string;
}

export interface WaitingShopCount {
  $id: string;
  counted_by: string;
  counted_at: string;
  note?: string;
  line_count: number;
  missing_pieces: number;
  missing_value: number;
  surplus_pieces: number;
}

/** One line of a shelf change, so the row can say what moved. */
export interface WaitingShelfLine {
  countId: string;
  name: string;
  expected: number;
  counted: number;
}

export interface WaitingSpend {
  $id: string;
  amount: number;
  payee?: string;
  category?: string;
  category_key?: string;
  created_by: string;
  $createdAt: string;
  module?: string;
}

/** An open shift with money on tabs, which the till cannot close without a code. */
export interface WaitingTabShift {
  $id: string;
  code?: string;
  module?: string;
  venue_id?: string;
  opened_at?: string;
  tabOrders: number;
  tabValue: number;
}

export interface WaitingInput {
  barCounts: WaitingBarCount[];
  shopCounts: WaitingShopCount[];
  shelfLines?: WaitingShelfLine[];
  spends: WaitingSpend[];
  tabShifts: WaitingTabShift[];
  /** Shift id to its code, for a bar count that is named by the shift it was taken on. */
  shiftCodes?: Record<string, string>;
  /** A store room's count carries the room in its id; this names the room. */
  storeNames?: Record<string, string>;
  /** Category key to its name, for a spend. */
  categoryNames?: Record<string, string>;
  money: (minor: number) => string;
}

/** Whether a stock_counts row is a change made on the products page, rather than a count of the shelf. */
export const isShelfChange = (c: { note?: string; line_count: number }): boolean =>
  c.line_count === 1 && (c.note ?? '').trim() === SHELF_CHANGE_NOTE;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const STORE_PREFIX = 'store:';

/**
 * Every waiting thing as one row, oldest first.
 *
 * Oldest first, not newest, because the thing that has waited longest is the
 * thing most likely to be blocking a shift, a month or a person, and a list
 * that shows the newest at the top is a list where the old ones sink.
 */
export function waitingList(input: WaitingInput): WaitingItem[] {
  const items: WaitingItem[] = [];
  const money = input.money;

  for (const c of input.barCounts) {
    if (c.pending <= 0) continue;
    const store = c.shiftId.startsWith(STORE_PREFIX) ? c.shiftId.slice(STORE_PREFIX.length) : null;
    const where = store
      ? `${input.storeNames?.[store] ?? 'Store room'} count`
      : `Bar count, ${c.phase === 'open' ? 'counted in' : 'counted out'}${input.shiftCodes?.[c.shiftId] ? ` on ${input.shiftCodes[c.shiftId]}` : ''}`;
    items.push({
      id: `bar:${c.shiftId}:${c.phase}`,
      kind: 'count',
      title: where,
      detail: `${plural(c.changed, 'line differs', 'lines differ')} from what was expected, worth ${money(Math.abs(c.worth))}. `
        + 'Approving moves the shelf by the difference; refusing leaves it as it is.',
      by: c.countedBy,
      at: c.at,
      value: Math.abs(c.worth),
      ref: { kind: 'bar_count', shiftId: c.shiftId, phase: c.phase },
    });
  }

  const linesByCount = new Map<string, WaitingShelfLine[]>();
  for (const l of input.shelfLines ?? []) {
    linesByCount.set(l.countId, [...(linesByCount.get(l.countId) ?? []), l]);
  }

  for (const c of input.shopCounts) {
    if (isShelfChange(c)) {
      const line = linesByCount.get(c.$id)?.[0];
      items.push({
        id: `shelf:${c.$id}`,
        kind: 'shelf',
        title: line ? `${line.name}: ${line.expected} → ${line.counted}` : 'A shelf change',
        detail: `Typed on the products page. The shelf still says ${line ? line.expected : 'what it said'} until this is approved, `
          + 'and nobody can change this piece again while it waits.',
        by: c.counted_by,
        at: c.counted_at,
        value: Math.abs(c.missing_value),
        ref: { kind: 'shelf', countId: c.$id },
      });
      continue;
    }
    const moved = c.missing_pieces + c.surplus_pieces;
    items.push({
      id: `shop:${c.$id}`,
      kind: 'count',
      title: `Shop stocktake, ${plural(c.line_count, 'piece', 'pieces')}`,
      detail: moved > 0
        ? `${plural(c.missing_pieces, 'piece missing', 'pieces missing')}, ${plural(c.surplus_pieces, 'extra', 'extra')}, worth ${money(Math.abs(c.missing_value))}. `
          + 'Approving moves the shelf by the difference; refusing leaves it as it is.'
        : 'Everything counted matched the shelf. Approving records that it was checked.',
      by: c.counted_by,
      at: c.counted_at,
      value: Math.abs(c.missing_value),
      ref: { kind: 'shop_count', countId: c.$id },
    });
  }

  for (const s of input.spends) {
    const category = input.categoryNames?.[s.category_key || s.category || ''] ?? s.category_key ?? s.category ?? '';
    items.push({
      id: `spend:${s.$id}`,
      kind: 'spend',
      title: `${money(s.amount)}${s.payee ? ` to ${s.payee}` : ''}${category ? ` · ${category}` : ''}`,
      detail: 'Recorded at the till and not yet looked at. Approving keeps it; refusing takes it off the books, '
        + 'and the person who spent it should be asked to make it good.',
      by: s.created_by,
      at: s.$createdAt,
      value: s.amount,
      ref: { kind: 'spend', expenseId: s.$id },
    });
  }

  for (const sh of input.tabShifts) {
    if (sh.tabOrders <= 0) continue;
    items.push({
      id: `tab:${sh.$id}`,
      kind: 'tab',
      title: `${sh.code ?? 'A shift'} cannot close: ${plural(sh.tabOrders, 'order', 'orders')} on tabs, ${money(sh.tabValue)}`,
      detail: 'The till will not close a shift with money still on tabs. A code read out to the cashier lets it close '
        + 'with the tabs carried over; it works once, on that shift only.',
      at: sh.opened_at ?? '',
      value: sh.tabValue,
      ref: { kind: 'tab', shiftId: sh.$id, module: sh.module ?? 'kitchen', venueId: sh.venue_id ?? 'main' },
    });
  }

  // Plain ordering, not locale-aware: ISO dates sort as text, and a row that
  // never said when it started goes last rather than wherever a collation
  // happens to put an empty string.
  return items.sort((a, b) => {
    if (!a.at !== !b.at) return a.at ? -1 : 1;
    return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
  });
}

/** How many of each kind, for the chips. */
export function waitingCounts(items: WaitingItem[]): Record<WaitingKind, number> {
  const counts: Record<WaitingKind, number> = { count: 0, spend: 0, shelf: 0, tab: 0 };
  for (const i of items) counts[i.kind] += 1;
  return counts;
}

/** The heading: what is waiting, in a sentence. */
export function waitingSummary(items: WaitingItem[]): string {
  if (items.length === 0) return 'Nothing is waiting for you.';
  const counts = waitingCounts(items);
  const parts = (Object.keys(counts) as WaitingKind[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${WAITING_KIND_WORDS[k].toLowerCase()}`);
  return `${plural(items.length, 'thing is', 'things are')} waiting: ${parts.join(', ')}.`;
}

/**
 * How long it has been, in the words somebody would use.
 *
 * The same words the approval email uses, so "waiting 3 days" in the inbox is
 * "waiting 3 days" on the page. A parity test holds the two together.
 */
export function waitedWords(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const mins = Math.max(1, Math.round(ms / 60_000));
  return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
}

/**
 * What refusing a spend does, said before the button is pressed.
 *
 * Refusing does not put the money back in the drawer: it was spent. It takes
 * the spend off the month's costs, so the person who spent it owes it back,
 * and a drawer that paid it out will show short by it on that shift.
 */
export function refuseSpendWords(source: string | undefined, amount: string): string {
  const drawer = !source || source === 'drawer';
  return `Refuse this ${amount} spend? It comes off the books and off the month's costs. `
    + (drawer
      ? 'The money did leave the drawer, so that shift will show short by it until it is made good.'
      : 'Whoever paid it will need to be paid back some other way, or not at all.');
}
