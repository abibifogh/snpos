/**
 * The arithmetic of a set of books.
 *
 * Split from `ledger.ts` for the reason every pure module here is: that file
 * opens a database connection on import, and these are the sums that decide
 * what a business believes it earned and what it believes it owns. They are
 * worth being able to check without a database.
 *
 * Every figure is in minor units, and every function here takes the lines and
 * gives back a shape. Nothing reads and nothing writes.
 *
 * Pure. Imports nothing at runtime.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface AccountRow {
  code: string;
  name: string;
  type: AccountType;
  parent_code?: string;
}

export interface LineRow {
  account_code: string;
  debit: number;
  credit: number;
}

/**
 * Which way round an account is normally held.
 *
 * Debits raise what you own and what things cost; credits raise what you owe,
 * what the owner has put in, and what you earned. Getting this backwards does
 * not make the books unbalanced — they still add up — it makes every figure on
 * every statement the wrong sign, which is the kind of wrong that looks
 * plausible on a screen and is discovered by an accountant a year later.
 */
export const isDebitNormal = (type: AccountType): boolean =>
  type === 'asset' || type === 'expense';

/**
 * What one account came to, in the direction it is normally held.
 *
 * A revenue account with 500 credited reads as 500, not as −500. This is the
 * only place that sign flip happens, so a statement cannot disagree with a
 * trial balance about which way round an account is.
 */
export const naturalBalance = (type: AccountType, debit: number, credit: number): number =>
  isDebitNormal(type) ? debit - credit : credit - debit;

/** Only lines dated inside the window. Both ends are inclusive. */
export function within<T extends { date?: string }>(rows: T[], from?: string, to?: string): T[] {
  return rows.filter((r) => {
    const d = r.date ?? '';
    if (from && d < from) return false;
    // `to` is a date, and a line stamped later that same day is still that
    // day's. Comparing against the end of it rather than the start of it is
    // the difference between a month's figures and a month minus its last day.
    if (to && d > `${to}￿`) return false;
    return true;
  });
}

/**
 * One account as it appears on a statement.
 *
 * Named for the account rather than for the statement, because a consignor's
 * statement already has a line of its own and two things called StatementLine
 * in one export surface is a name that means whichever the importer guessed.
 */
export interface AccountLine {
  code: string;
  name: string;
  type: AccountType;
  amount: number;
}

export interface ProfitAndLoss {
  revenue: AccountLine[];
  expenses: AccountLine[];
  totalRevenue: number;
  totalExpenses: number;
  /** What was earned less what it cost. Not cash, and not what is in the bank. */
  netProfit: number;
}

/**
 * What the business earned over a period, and what that cost it.
 *
 * Only revenue and expense accounts: a profit and loss is about a period, and
 * what you own and owe is a fact about a moment, which is the balance sheet's
 * question. Accounts with nothing on them are left out rather than printed as
 * a column of zeros nobody reads.
 */
export function profitAndLoss(accounts: AccountRow[], lines: LineRow[]): ProfitAndLoss {
  const totals = totalsByAccount(lines);
  const pick = (type: AccountType) =>
    accounts
      .filter((a) => a.type === type)
      .map((a) => {
        const t = totals.get(a.code) ?? { debit: 0, credit: 0 };
        return { code: a.code, name: a.name, type, amount: naturalBalance(type, t.debit, t.credit) };
      })
      .filter((l) => l.amount !== 0)
      .sort((a, b) => a.code.localeCompare(b.code));

  const revenue = pick('revenue');
  const expenses = pick('expense');
  const totalRevenue = revenue.reduce((s, l) => s + l.amount, 0);
  const totalExpenses = expenses.reduce((s, l) => s + l.amount, 0);
  return { revenue, expenses, totalRevenue, totalExpenses, netProfit: totalRevenue - totalExpenses };
}

export interface BalanceSheet {
  assets: AccountLine[];
  liabilities: AccountLine[];
  equity: AccountLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  /** Profit not yet moved into equity, which is most businesses most of the time. */
  retained: number;
  /** assets − (liabilities + equity + retained). Nought when the books are whole. */
  outBy: number;
  balanced: boolean;
}

/**
 * What the business owns and owes at a moment.
 *
 * Everything from the beginning up to that date, not a period: an asset does
 * not stop existing because a month ended.
 *
 * Profit is carried in as retained earnings rather than left out. A set of
 * books that has never closed a year — which is every set of books here — has
 * its profit sitting in the revenue and expense accounts, and a balance sheet
 * that ignores them is out by exactly the profit and looks broken. Shown as
 * its own line rather than folded into equity, because "what the owner put in"
 * and "what the business has made" are different questions.
 */
export function balanceSheet(accounts: AccountRow[], lines: LineRow[]): BalanceSheet {
  const totals = totalsByAccount(lines);
  const pick = (type: AccountType) =>
    accounts
      .filter((a) => a.type === type)
      .map((a) => {
        const t = totals.get(a.code) ?? { debit: 0, credit: 0 };
        return { code: a.code, name: a.name, type, amount: naturalBalance(type, t.debit, t.credit) };
      })
      .filter((l) => l.amount !== 0)
      .sort((a, b) => a.code.localeCompare(b.code));

  const assets = pick('asset');
  const liabilities = pick('liability');
  const equity = pick('equity');
  const { netProfit } = profitAndLoss(accounts, lines);

  const totalAssets = assets.reduce((s, l) => s + l.amount, 0);
  const totalLiabilities = liabilities.reduce((s, l) => s + l.amount, 0);
  const totalEquity = equity.reduce((s, l) => s + l.amount, 0);
  const outBy = totalAssets - (totalLiabilities + totalEquity + netProfit);

  return {
    assets, liabilities, equity,
    totalAssets, totalLiabilities, totalEquity,
    retained: netProfit,
    outBy,
    balanced: outBy === 0,
  };
}

/** Debits and credits per account, in one pass. */
export function totalsByAccount(lines: LineRow[]): Map<string, { debit: number; credit: number }> {
  const map = new Map<string, { debit: number; credit: number }>();
  for (const l of lines) {
    const row = map.get(l.account_code) ?? { debit: 0, credit: 0 };
    row.debit += l.debit ?? 0;
    row.credit += l.credit ?? 0;
    map.set(l.account_code, row);
  }
  return map;
}

/* --------------------------------------------------------------- balancing */

/** Whether a set of lines can be posted at all. */
export function entryProblem(lines: LineRow[]): string | null {
  const real = lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  if (real.length < 2) return 'An entry needs at least two lines: what was given and what was received.';
  if (real.some((l) => (l.debit ?? 0) < 0 || (l.credit ?? 0) < 0)) {
    return 'No line can be negative. Put the amount on the other side instead.';
  }
  // Both sides on one line is the commonest way of typing an entry that adds
  // up and means nothing.
  if (real.some((l) => (l.debit ?? 0) > 0 && (l.credit ?? 0) > 0)) {
    return 'A line is either a debit or a credit, never both.';
  }
  if (real.some((l) => !l.account_code)) return 'Every line needs an account.';

  const debit = real.reduce((s, l) => s + (l.debit ?? 0), 0);
  const credit = real.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (debit !== credit) {
    return `This does not balance: ${debit} debited against ${credit} credited.`;
  }
  return null;
}

/* ------------------------------------------------------------ depreciation */

export type DepreciationMethod = 'straight_line' | 'reducing_balance';

export interface DepreciableAsset {
  /** What it cost, in minor units. */
  cost: number;
  /** What it is expected to be worth at the end. Usually nought. */
  salvage_value?: number;
  method: DepreciationMethod;
  /** Straight line: how many months it is written off over. */
  life_months?: number;
  /** Reducing balance: the annual rate in basis points. 2000 = 20% a year. */
  rate_bp?: number;
  /** First day of the first month it is charged for. */
  acquired_on: string;
  disposed_on?: string;
}

export interface DepreciationCharge {
  /** The month being charged for, as YYYY-MM. */
  month: string;
  amount: number;
  /** What it is worth on the books after this month's charge. */
  closingValue: number;
}

/** The month a date falls in, as YYYY-MM. Comparable as a string. */
export const monthOf = (iso: string): string => iso.slice(0, 7);

/** One month on from a YYYY-MM, without a Date and without a timezone. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m >= 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * What an asset should have been charged, month by month, up to a point.
 *
 * A whole month is charged for the month it was bought in, however late in
 * that month it arrived. This is the convention small businesses actually
 * keep, it needs no day counting, and the difference it makes over the life of
 * a fridge is a few cedis.
 *
 * Two methods, because both are in real use and they answer different people.
 * Straight line spreads the cost evenly and is what a set of management
 * accounts wants: the fridge cost this much a month to have. Reducing balance
 * charges a percentage of what is left each year, so more early and less
 * later, which is how tax authorities generally want capital allowances
 * worked out, Ghana's included.
 *
 * Nothing is ever charged below the salvage value, and nothing is charged
 * after disposal. Both of those are how an asset quietly acquires a negative
 * book value, which no amount of arithmetic further down can put right.
 */
export function depreciationSchedule(asset: DepreciableAsset, upToMonth: string): DepreciationCharge[] {
  const floor = Math.max(0, asset.salvage_value ?? 0);
  const depreciable = Math.max(0, asset.cost - floor);
  if (depreciable === 0) return [];

  const start = monthOf(asset.acquired_on);
  const last = asset.disposed_on
    // Nothing is charged for the month it was sold in: it was not there to be
    // used, and charging for it means depreciating something already gone.
    ? minMonth(upToMonth, previousMonth(monthOf(asset.disposed_on)))
    : upToMonth;
  if (last < start) return [];

  const charges: DepreciationCharge[] = [];
  let value = asset.cost;

  for (let month = start; month <= last; month = nextMonth(month)) {
    let amount: number;
    if (asset.method === 'reducing_balance') {
      // A twelfth of the annual rate, applied to what is left. The rate is on
      // the written-down value, so it never reaches nought on its own, which
      // is the whole character of the method.
      amount = Math.round(((value - floor) * (asset.rate_bp ?? 0)) / 10_000 / 12);
    } else {
      const months = Math.max(1, asset.life_months ?? 1);
      amount = Math.round(depreciable / months);
    }

    // Never past the salvage value, and never negative. The last month takes
    // whatever rounding left behind rather than leaving a few pesewas on the
    // books for ever.
    amount = Math.max(0, Math.min(amount, value - floor));
    if (amount === 0 && value <= floor) break;

    value -= amount;
    charges.push({ month, amount, closingValue: value });
  }

  return charges;
}

/** What is left to charge, and what the asset is worth, as at a month. */
export function bookValue(asset: DepreciableAsset, upToMonth: string): number {
  const charges = depreciationSchedule(asset, upToMonth);
  return charges.length ? charges[charges.length - 1].closingValue : asset.cost;
}

/** Everything charged in one month, or nought if that month has none. */
export function chargeForMonth(asset: DepreciableAsset, month: string): number {
  return depreciationSchedule(asset, month).find((c) => c.month === month)?.amount ?? 0;
}

const minMonth = (a: string, b: string) => (a < b ? a : b);

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m <= 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/* ------------------------------------------------------- reconciliation */

export interface RecLine {
  line_id: string;
  date: string;
  memo: string;
  /** Positive into the account, negative out of it. */
  amount: number;
  cleared: boolean;
}

export interface RecSummary {
  /** The account's own balance, everything up to the statement date. */
  perBooks: number;
  /** What has been ticked off as also seen by the bank. */
  cleared: number;
  /** Posted, but the bank has not seen it yet. */
  outstanding: number;
  /** What the statement says was there. */
  perStatement: number;
  /**
   * What is still unexplained.
   *
   * Nought means the two agree: every posting the bank has seen is ticked, and
   * everything left over is genuinely still in transit. Anything else is a
   * transaction one side has and the other does not, and it is the whole point
   * of doing this — the difference is not an error to be written off, it is a
   * pointer at the thing that is missing.
   */
  difference: number;
  agreed: boolean;
}

/**
 * Where a reconciliation stands.
 *
 * Cleared postings are what the bank has also seen. The statement's closing
 * balance should equal them, because both sides are then describing the same
 * set of transactions. What is left over is outstanding — written by the
 * business, not yet processed by the bank — and it is not part of the check.
 */
export function reconcile(lines: RecLine[], perStatement: number): RecSummary {
  const perBooks = lines.reduce((s, l) => s + l.amount, 0);
  const cleared = lines.filter((l) => l.cleared).reduce((s, l) => s + l.amount, 0);
  const outstanding = perBooks - cleared;
  const difference = perStatement - cleared;
  return { perBooks, cleared, outstanding, perStatement, difference, agreed: difference === 0 };
}
