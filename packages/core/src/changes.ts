/**
 * What changed on a record, in words somebody can read back.
 *
 * A log that stores the whole row before and after answers "did anything
 * change" and nothing else: the reader has to compare forty fields by eye to
 * find the one that moved. What anybody actually asks is narrower — who put
 * the price up, when did this stop being sold, why is this suddenly in another
 * category — and that is a list of differences, not two snapshots.
 *
 * So only the fields that moved are kept, with the old value beside the new
 * one. It is smaller, it is readable without tooling, and it does not quietly
 * copy a description into an audit row every time somebody fixes a typo in a
 * price.
 *
 * Pure. What counts as a change, and how it reads, can be checked without a
 * database.
 */

export interface FieldChange {
  field: string;
  label: string;
  from: unknown;
  to: unknown;
}

/** Which fields are worth watching, and what to call them. */
export type WatchList = Record<string, string>;

/** The fields of a product whose movement somebody will one day ask about. */
export const PRODUCT_WATCH: WatchList = {
  name: 'Name',
  price: 'Price',
  category_id: 'Category',
  active: 'On the menu',
  description: 'Description',
  prep_minutes: 'Prep time',
  station: 'Station',
  station_key: 'Station',
  track_stock: 'Tracks stock',
  is_one_off: 'One of a kind',
  consignor_id: 'Maker',
  sku: 'Barcode',
  module: 'Side of the business',
  // On_hand is deliberately absent: a shelf figure is changed through the
  // approval desk, which keeps its own record with both names on it.
  is_service: 'Work rather than goods',
  // Who may drop this price at the counter, which is a permission and
  // therefore exactly the kind of thing somebody asks about a year later.
  price_editors: 'Who may change this price',
};

const same = (a: unknown, b: unknown): boolean => {
  // Blank, absent and empty are the same absence. Without this, opening a
  // record and saving it unchanged logs "Description: null to empty".
  const empty = (v: unknown) =>
    v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  if (empty(a) && empty(b)) return true;
  /*
    A list is the same list when it holds the same things.

    Compared by contents rather than by identity, because these arrive as two
    separately built arrays on every save — so by identity they are never
    equal, and a product opened and saved with nothing changed would log "Who
    may change this price: Ama, Kofi to Ama, Kofi" every time. A log that fills
    up with changes that are not changes is one nobody reads.

    Order does not count. Ticking two people in the other order is not a
    different permission.
  */
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const left = [...a].map(String).sort();
    const right = [...b].map(String).sort();
    return left.every((v, i) => v === right[i]);
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return a === b;
};

export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown>,
  watch: WatchList,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [field, label] of Object.entries(watch)) {
    // A field the new version does not mention is a field this save did not
    // touch, not a field set to nothing.
    if (!(field in after)) continue;
    const from = before ? before[field] : undefined;
    if (same(from, after[field])) continue;
    out.push({ field, label, from, to: after[field] });
  }
  return out;
}

/**
 * One line per change, for a log somebody reads rather than parses.
 *
 * `money` is passed in rather than imported so this file stays free of the
 * money module, and because only the caller knows which fields are money.
 */
export function describeChanges(
  changes: FieldChange[],
  opts: { money?: (v: number) => string; moneyFields?: string[]; nameFor?: (field: string, v: unknown) => string | undefined } = {},
): string {
  const { money, moneyFields = ['price'], nameFor } = opts;
  const show = (field: string, v: unknown): string => {
    if (v === undefined || v === null || v === '') return 'nothing';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (money && moneyFields.includes(field) && typeof v === 'number') return money(v);
    const named = nameFor?.(field, v);
    return named ?? String(v);
  };
  return changes.map((c) => `${c.label}: ${show(c.field, c.from)} → ${show(c.field, c.to)}`).join('; ');
}

/**
 * The change list trimmed to fit the column it is stored in.
 *
 * Appwrite refuses the whole document when a string is over length, so a
 * product with a long description could otherwise take the entire audit row
 * down with it — losing the record of the change because the change was big.
 */
export function fitForLog(value: unknown, limit = 3800): string {
  const text = JSON.stringify(value ?? null);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 20)}…","truncated":true}`;
}
