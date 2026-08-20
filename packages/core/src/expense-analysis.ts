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
