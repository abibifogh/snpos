/**
 * What the business actually spends, taken apart.
 *
 * The Expenses page lists what was spent. This answers the questions that come
 * after that: on what, by which trade, is it going up, who is spending it, and
 * which of it went out of a drawer nobody counts.
 *
 * THREE TRADES, NOT ONE. A bistro, a bar and a craft shop under one roof have
 * completely different cost shapes — a bar's spending is almost all stock, a
 * kitchen's is stock and gas and transport, a shop's is barely anything at all.
 * Added together they describe none of them, which is why every figure here can
 * be read per side as well as whole, and why the comparison between sides is
 * built rather than left to somebody with a calculator.
 *
 * THE COMPARISON IS THE POINT. A total on its own is a number; a total against
 * the period before it is information. Every headline here carries what the
 * same length of time before it came to, because "we spent four thousand on
 * transport" is only worth reading next to "we spent two thousand last month".
 *
 * Pure. Nothing here reads or writes.
 */

export interface AnalysedExpense {
  $id: string;
  $createdAt: string;
  amount: number;
  module?: string;
  category?: string;
  category_key?: string;
  payee?: string;
  supplier_id?: string;
  paid_to_kind?: string;
  created_by?: string;
  shift_id?: string;
  imprest_float_id?: string;
  from_takings?: boolean;
  receipt_file_id?: string;
}

export const SIDES = ['kitchen', 'bar', 'craft'] as const;
export type Side = (typeof SIDES)[number];

export const sideOf = (e: AnalysedExpense): Side =>
  (SIDES as readonly string[]).includes(e.module ?? '') ? (e.module as Side) : 'kitchen';

/* ------------------------------------------------------------ the windows */

/**
 * The period immediately before the one being looked at, of the same length.
 *
 * Same length, not "last month" — comparing eleven days against thirty is how
 * a report tells somebody their costs have collapsed. The window ends where
 * this one begins, so the two never overlap and nothing is counted twice.
 */
export function previousWindow(fromIso: string, toIso: string): { from: string; to: string } {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { from: fromIso, to: fromIso };
  const span = to - from;
  return { from: new Date(from - span).toISOString(), to: new Date(from - 1).toISOString() };
}

/**
 * Named for spending: `inWindow` belongs to the consignor reassignment already,
 * and `Bucket` to the insights module. Two exports with one name in a package
 * everything imports from is a collision waiting for whichever file compiles
 * second.
 */
export const spentInWindow = (e: AnalysedExpense, fromIso: string, toIso: string): boolean =>
  e.$createdAt >= fromIso && e.$createdAt <= toIso;

/* ------------------------------------------------------------- the totals */

export interface Movement {
  now: number;
  before: number;
  /** How far it has moved, in basis points. Null when there is nothing to compare to. */
  changeBp: number | null;
}

/**
 * A figure against the same figure last time.
 *
 * `changeBp` is null rather than zero when the period before spent nothing.
 * Nought to five hundred is not "up 100%", it is a thing that did not happen
 * before and does now — a percentage there is arithmetic pretending to be
 * insight, and the screen says "new" instead.
 */
export function movement(now: number, before: number): Movement {
  return {
    now,
    before,
    changeBp: before > 0 ? Math.round(((now - before) / before) * 10_000) : null,
  };
}

export interface Slice {
  key: string;
  label: string;
  now: number;
  before: number;
  changeBp: number | null;
  /** How much of the period's spending this is, in basis points. */
  shareBp: number;
  count: number;
}

/**
 * Break spending down by whatever question is being asked of it.
 *
 * One function for category, side, payee and person, because they are the same
 * arithmetic asked four ways and four copies of it is four chances for the
 * totals to stop agreeing with each other.
 *
 * Sorted by what is being spent NOW, largest first. Sorting by the change
 * would put a category that went from two cedis to twenty above the one
 * quietly eating a third of the month.
 */
export function sliceBy(opts: {
  now: AnalysedExpense[];
  before: AnalysedExpense[];
  keyOf: (e: AnalysedExpense) => string;
  labelOf?: (key: string) => string;
}): Slice[] {
  const { now, before, keyOf, labelOf } = opts;
  const total = now.reduce((a, e) => a + e.amount, 0);

  const sums = new Map<string, { now: number; before: number; count: number }>();
  const bump = (key: string, amount: number, which: 'now' | 'before') => {
    const row = sums.get(key) ?? { now: 0, before: 0, count: 0 };
    row[which] += amount;
    if (which === 'now') row.count += 1;
    sums.set(key, row);
  };

  for (const e of now) bump(keyOf(e), e.amount, 'now');
  /*
    The period before can raise a row of its own.

    Something spent last month and not this one is exactly what somebody wants
    to see — a supplier who stopped being paid, a category that quietly went
    away — and it can only appear if the earlier rows are allowed to create
    keys the current ones never mention. It comes out with nothing in the
    "now" column, which is the honest shape of it.
  */
  for (const e of before) bump(keyOf(e), e.amount, 'before');

  return [...sums.entries()]
    .map(([key, row]) => ({
      key,
      label: labelOf ? labelOf(key) : key,
      now: row.now,
      before: row.before,
      changeBp: row.before > 0 ? Math.round(((row.now - row.before) / row.before) * 10_000) : null,
      shareBp: total > 0 ? Math.round((row.now / total) * 10_000) : 0,
      count: row.count,
    }))
    .sort((a, b) => b.now - a.now || b.before - a.before);
}

/* --------------------------------------------------------- one side's shape */

export interface SideAnalysis {
  side: Side;
  spend: Movement;
  count: number;
  /** The biggest single thing spent, which is often the whole story. */
  largest: AnalysedExpense | null;
  categories: Slice[];
  /** Spending that never reduced a drawer: petty cash, or somebody's pocket. */
  offDrawer: number;
  /** Of this side's spending, how much has a receipt behind it, in basis points. */
  receiptedBp: number;
}

export function analyseSide(opts: {
  side: Side;
  now: AnalysedExpense[];
  before: AnalysedExpense[];
  labelOf?: (key: string) => string;
}): SideAnalysis {
  const mine = opts.now.filter((e) => sideOf(e) === opts.side);
  const was = opts.before.filter((e) => sideOf(e) === opts.side);
  const spent = mine.reduce((a, e) => a + e.amount, 0);

  return {
    side: opts.side,
    spend: movement(spent, was.reduce((a, e) => a + e.amount, 0)),
    count: mine.length,
    largest: [...mine].sort((a, b) => b.amount - a.amount)[0] ?? null,
    categories: sliceBy({
      now: mine,
      before: was,
      keyOf: (e) => e.category_key || e.category || 'other',
      labelOf: opts.labelOf,
    }),
    /*
      Money the business spent that no drawer is short of.

      Petty cash and out-of-pocket both. It is real spending and belongs in
      every total here — what it is not is money missing from a till, and a
      figure that cannot tell the two apart is one that sends somebody looking
      for cash that was never there.
    */
    offDrawer: mine.filter((e) => e.from_takings === false).reduce((a, e) => a + e.amount, 0),
    receiptedBp: spent > 0
      ? Math.round(
        (mine.filter((e) => !!e.receipt_file_id).reduce((a, e) => a + e.amount, 0) / spent) * 10_000,
      )
      : 0,
  };
}

/* --------------------------------------------------------------- over time */

export interface SpendBucket {
  key: string;
  label: string;
  total: number;
  bySide: Record<Side, number>;
}

/**
 * Spending laid out over time, by day or by week.
 *
 * Buckets are built from the WINDOW rather than from the rows, so a day
 * nothing was spent shows as a gap rather than being quietly skipped. A chart
 * that omits its empty days makes a fortnight of nothing look like a busy
 * week, which is the one shape this is meant to reveal.
 */
export function overTime(opts: {
  rows: AnalysedExpense[];
  fromIso: string;
  toIso: string;
  by: 'day' | 'week';
}): SpendBucket[] {
  const { rows, fromIso, toIso, by } = opts;
  const start = Date.parse(fromIso);
  const end = Date.parse(toIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const keyFor = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    if (by === 'day') return d.toISOString().slice(0, 10);
    // The Monday of that week, so a week is always the same seven days
    // whichever day somebody happens to be looking on.
    const monday = new Date(d);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  };

  const buckets = new Map<string, SpendBucket>();
  const step = by === 'day' ? 86_400_000 : 7 * 86_400_000;
  for (let t = Date.parse(keyFor(fromIso)); t <= end; t += step) {
    const key = keyFor(new Date(t).toISOString());
    if (!key) break;
    buckets.set(key, { key, label: key, total: 0, bySide: { kitchen: 0, bar: 0, craft: 0 } });
  }

  for (const e of rows) {
    const key = keyFor(e.$createdAt);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.total += e.amount;
    bucket.bySide[sideOf(e)] += e.amount;
  }

  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/* ------------------------------------------------------- the whole picture */

export interface ExpenseAnalysis {
  spend: Movement;
  count: number;
  /** The average size of one expense. A useful shape-of-spending figure. */
  average: number;
  sides: SideAnalysis[];
  categories: Slice[];
  payees: Slice[];
  people: Slice[];
  buckets: SpendBucket[];
  offDrawer: number;
  receiptedBp: number;
  /** Spending recorded against no shift at all, which nothing counts against. */
  outsideShift: number;
}

export function analyseExpenses(opts: {
  now: AnalysedExpense[];
  before: AnalysedExpense[];
  fromIso: string;
  toIso: string;
  by?: 'day' | 'week';
  labelOf?: (key: string) => string;
  nameOf?: (id: string) => string;
}): ExpenseAnalysis {
  const { now, before, fromIso, toIso, by = 'day', labelOf, nameOf } = opts;
  const spent = now.reduce((a, e) => a + e.amount, 0);

  return {
    spend: movement(spent, before.reduce((a, e) => a + e.amount, 0)),
    count: now.length,
    average: now.length ? Math.round(spent / now.length) : 0,
    sides: SIDES.map((side) => analyseSide({ side, now, before, labelOf })),
    categories: sliceBy({
      now, before, keyOf: (e) => e.category_key || e.category || 'other', labelOf,
    }),
    payees: sliceBy({
      now,
      before,
      // The name that was recorded, whoever it was. A supplier id would name
      // nothing on screen and would hide every market stall behind one blank.
      keyOf: (e) => (e.payee || '').trim() || 'Not recorded',
    }),
    people: sliceBy({
      now,
      before,
      keyOf: (e) => e.created_by || '',
      labelOf: (id) => (id ? nameOf?.(id) || 'Somebody who has left' : 'Not recorded'),
    }),
    buckets: overTime({ rows: now, fromIso, toIso, by }),
    offDrawer: now.filter((e) => e.from_takings === false).reduce((a, e) => a + e.amount, 0),
    receiptedBp: spent > 0
      ? Math.round(
        (now.filter((e) => !!e.receipt_file_id).reduce((a, e) => a + e.amount, 0) / spent) * 10_000,
      )
      : 0,
    outsideShift: now.filter((e) => !e.shift_id).reduce((a, e) => a + e.amount, 0),
  };
}

/* --------------------------------------------------------------- the words */

export const SIDE_WORDS: Record<Side, string> = {
  kitchen: 'Bistro', bar: 'Bar', craft: 'Craft shop',
};

/**
 * A change, in words somebody reads rather than a percentage to interpret.
 *
 * Spending MORE is the warning here, which is the opposite of a sales report
 * and worth getting right: green for down, and no colour at all for a change
 * too small to mean anything.
 */
export function changeWords(changeBp: number | null): { text: string; tone: 'ok' | 'warn' | 'default' } {
  if (changeBp === null) return { text: 'new', tone: 'warn' };
  const pct = Math.abs(changeBp) / 100;
  // Under five per cent is noise in a month's spending, and dressing it up as
  // a trend is how a report stops being believed.
  if (pct < 5) return { text: 'about the same', tone: 'default' };
  return changeBp > 0
    ? { text: `up ${pct.toFixed(0)}%`, tone: 'warn' }
    : { text: `down ${pct.toFixed(0)}%`, tone: 'ok' };
}

/**
 * The one or two things actually worth saying about a period.
 *
 * A page of tables answers questions somebody already knew to ask. This is for
 * the ones they did not: what moved most, what is new, and what is quietly
 * taking the biggest share.
 */
export function highlights(a: ExpenseAnalysis, money: (n: number) => string): string[] {
  const out: string[] = [];

  const risen = a.categories
    .filter((c) => c.changeBp !== null && c.changeBp >= 2_500 && c.now > 0)
    .sort((x, y) => (y.now - y.before) - (x.now - x.before))[0];
  if (risen) {
    out.push(
      `${risen.label} is up ${(risen.changeBp! / 100).toFixed(0)}% on the period before — `
      + `${money(risen.now)} against ${money(risen.before)}.`,
    );
  }

  const fresh = a.categories.filter((c) => c.before === 0 && c.now > 0).sort((x, y) => y.now - x.now)[0];
  if (fresh) out.push(`${fresh.label} is new this period, at ${money(fresh.now)}.`);

  const gone = a.categories.filter((c) => c.now === 0 && c.before > 0).sort((x, y) => y.before - x.before)[0];
  if (gone) out.push(`Nothing was spent on ${gone.label} this period; last time it was ${money(gone.before)}.`);

  const biggest = a.categories[0];
  if (biggest && biggest.shareBp >= 3_000) {
    out.push(`${biggest.label} is ${(biggest.shareBp / 100).toFixed(0)}% of everything spent.`);
  }

  if (a.receiptedBp < 5_000 && a.count > 0) {
    out.push(
      `Only ${(a.receiptedBp / 100).toFixed(0)}% of what was spent has a receipt behind it. `
      + 'That is the half of the books an accountant asks for and nobody can reconstruct later.',
    );
  }

  return out;
}

/* ------------------------------------------------- down to the actual items */

export interface AnalysedItem {
  expense_id: string;
  ingredient_id?: string;
  /** The name as it was when it was bought. See below. */
  name_snapshot: string;
  qty: number;
  unit_cost?: number;
  line_total?: number;
}

export interface ItemSlice {
  key: string;
  label: string;
  /** What was spent on this thing in the period. */
  now: number;
  before: number;
  changeBp: number | null;
  /** Its share of everything ITEMISED, not of everything spent. See below. */
  shareBp: number;
  /** Its share of the running total once everything above it is added up. */
  cumulativeBp: number;
  qty: number;
  /** How many separate times it was bought. */
  times: number;
  /** What it averaged per unit across the period, for a price that moved. */
  unitCost: number;
  beforeUnitCost: number;
  /** How far the unit price has moved, in basis points. */
  priceMoveBp: number | null;
  side: Side;
}

/**
 * Every expense line, ranked by what it actually cost.
 *
 * The category tables answer "how much went on supplies". This answers the
 * question underneath it, which is the one that changes what somebody buys:
 * WHICH THINGS. A kitchen spending a third of its money on one item does not
 * find that out from a category called Supplies, and until it does there is
 * nothing to act on.
 *
 * TWO FIGURES PER ITEM, and they are different questions. What was SPENT on it
 * is the ranking — that is where the money went. What it COST PER UNIT is the
 * price, and it moves for reasons that have nothing to do with how much was
 * bought. An item can be up thirty per cent in spend because the price rose,
 * or because three times as much was bought at a lower price, and those need
 * completely different responses.
 *
 * SHARES ARE OF WHAT WAS ITEMISED, never of all spending. Transport and gas
 * have no lines behind them, so measuring an item against total spending would
 * quietly understate every one of them by however much of the month went on
 * things nobody lists. The screen says which total it is using.
 *
 * The name is the SNAPSHOT, not the ingredient's current name. An ingredient
 * renamed in March must not silently rewrite what January's report says was
 * bought — and one archived entirely would otherwise vanish from its own
 * history.
 */
export function rankItems(opts: {
  now: AnalysedItem[];
  before: AnalysedItem[];
  /** Which side each expense belongs to, to colour and filter the ranking. */
  sideOfExpense?: (expenseId: string) => Side;
}): ItemSlice[] {
  const { now, before, sideOfExpense } = opts;
  const total = now.reduce((a, i) => a + (i.line_total ?? 0), 0);

  interface Row { now: number; before: number; qty: number; beforeQty: number; times: number; side: Side }
  const sums = new Map<string, Row>();

  const keyOf = (i: AnalysedItem) => i.ingredient_id || i.name_snapshot.trim().toLowerCase();
  const bump = (i: AnalysedItem, which: 'now' | 'before') => {
    const key = keyOf(i);
    const row = sums.get(key)
      ?? { now: 0, before: 0, qty: 0, beforeQty: 0, times: 0, side: 'kitchen' as Side };
    if (which === 'now') {
      row.now += i.line_total ?? 0;
      row.qty += i.qty || 0;
      row.times += 1;
      if (sideOfExpense) row.side = sideOfExpense(i.expense_id);
    } else {
      row.before += i.line_total ?? 0;
      row.beforeQty += i.qty || 0;
    }
    sums.set(key, row);
  };

  const labels = new Map<string, string>();
  for (const i of now) { bump(i, 'now'); labels.set(keyOf(i), i.name_snapshot); }
  for (const i of before) {
    bump(i, 'before');
    // Only where this period has no name of its own to use, so a thing bought
    // last month and not this one still reads as something rather than an id.
    if (!labels.has(keyOf(i))) labels.set(keyOf(i), i.name_snapshot);
  }

  const ranked = [...sums.entries()]
    .map(([key, row]) => {
      const unitCost = row.qty > 0 ? Math.round(row.now / row.qty) : 0;
      const beforeUnitCost = row.beforeQty > 0 ? Math.round(row.before / row.beforeQty) : 0;
      return {
        key,
        label: labels.get(key) ?? key,
        now: row.now,
        before: row.before,
        changeBp: row.before > 0 ? Math.round(((row.now - row.before) / row.before) * 10_000) : null,
        shareBp: total > 0 ? Math.round((row.now / total) * 10_000) : 0,
        cumulativeBp: 0,
        qty: Math.round(row.qty * 1000) / 1000,
        times: row.times,
        unitCost,
        beforeUnitCost,
        priceMoveBp: beforeUnitCost > 0 && unitCost > 0
          ? Math.round(((unitCost - beforeUnitCost) / beforeUnitCost) * 10_000)
          : null,
        side: row.side,
      };
    })
    .sort((a, b) => b.now - a.now || b.before - a.before);

  /*
    The running total, added after the sort.

    "These four things are two thirds of everything we buy" is a sentence
    somebody can act on in a way that a list of forty percentages is not — and
    it can only be worked out once the order is settled.
  */
  let running = 0;
  for (const row of ranked) {
    running += row.shareBp;
    row.cumulativeBp = Math.min(10_000, running);
  }

  return ranked;
}

/** Everything the ranking was measured against, said plainly on screen. */
export interface ItemCoverage {
  /** What was spent on lines somebody itemised. */
  itemised: number;
  /** Everything spent, itemised or not. */
  spent: number;
  /** How much of the spending has lines behind it, in basis points. */
  coverBp: number;
}

export function itemCoverage(items: AnalysedItem[], spent: number): ItemCoverage {
  const itemised = items.reduce((a, i) => a + (i.line_total ?? 0), 0);
  return {
    itemised,
    spent,
    coverBp: spent > 0 ? Math.round((itemised / spent) * 10_000) : 0,
  };
}

/**
 * The few things that make up most of the spending.
 *
 * Where the cumulative share first crosses the mark — eighty per cent by
 * default, which is the line most people mean by "most of it". It is the
 * shortest list worth arguing about at a supplier, and it is almost always
 * far shorter than anybody expects.
 */
export function vitalFew(ranked: ItemSlice[], throughBp = 8_000): ItemSlice[] {
  const out: ItemSlice[] = [];
  for (const row of ranked) {
    if (row.now <= 0) break;
    out.push(row);
    if (row.cumulativeBp >= throughBp) break;
  }
  return out;
}

/** The one or two things worth saying about the items themselves. */
export function itemHighlights(
  ranked: ItemSlice[],
  coverage: ItemCoverage,
  money: (n: number) => string,
): string[] {
  const out: string[] = [];
  const few = vitalFew(ranked);

  if (few.length > 0 && ranked.filter((r) => r.now > 0).length > few.length) {
    out.push(
      `${few.length} of ${ranked.filter((r) => r.now > 0).length} things account for `
      + `${(few[few.length - 1].cumulativeBp / 100).toFixed(0)}% of everything itemised. `
      + `That is the list worth taking to a supplier.`,
    );
  }

  /*
    A price that moved, told apart from a quantity that moved.

    An item up thirty per cent because it was bought three times over is not a
    problem; the same item up thirty per cent a unit is. Only the second is
    worth a sentence, and saying so needs both figures.
  */
  const dearer = ranked
    .filter((r) => r.priceMoveBp !== null && r.priceMoveBp >= 2_000 && r.now > 0)
    .sort((a, b) => (b.priceMoveBp ?? 0) - (a.priceMoveBp ?? 0))[0];
  if (dearer) {
    out.push(
      `${dearer.label} costs ${((dearer.priceMoveBp ?? 0) / 100).toFixed(0)}% more per unit than last period — `
      + `${money(dearer.unitCost)} against ${money(dearer.beforeUnitCost)}.`,
    );
  }

  const cheaper = ranked
    .filter((r) => r.priceMoveBp !== null && r.priceMoveBp <= -2_000 && r.now > 0)
    .sort((a, b) => (a.priceMoveBp ?? 0) - (b.priceMoveBp ?? 0))[0];
  if (cheaper) {
    out.push(
      `${cheaper.label} is ${Math.abs((cheaper.priceMoveBp ?? 0) / 100).toFixed(0)}% cheaper per unit than last `
      + `period, at ${money(cheaper.unitCost)}.`,
    );
  }

  if (coverage.coverBp < 5_000 && coverage.spent > 0) {
    out.push(
      `Only ${(coverage.coverBp / 100).toFixed(0)}% of spending is itemised, so this ranking covers `
      + `${money(coverage.itemised)} of ${money(coverage.spent)}. Transport, gas and repairs have no lines `
      + 'behind them; anything bought as stock should.',
    );
  }

  return out;
}
