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
  /** Retired. Off every list that offers a choice, still on every statement. */
  active?: boolean;
}

/**
 * The accounts still on offer.
 *
 * Archived ones are gone from anywhere somebody PICKS an account and present
 * everywhere one has already been used — a statement, a trial balance, the
 * postings behind a figure. Hiding a retired account from the books it is
 * already in would not tidy anything; it would leave last month with a total
 * and no rows adding up to it.
 */
export const openAccounts = (accounts: AccountRow[]): AccountRow[] =>
  accounts.filter((a) => a.active !== false);

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

/* ----------------------------------------------- matching a bank statement */

export interface BankLine {
  id: string;
  date: string;
  description: string;
  /** Positive into the account, negative out of it. */
  amount: number;
}

export interface Match {
  bank: BankLine;
  /** The posting it was matched to, or null when nothing fits. */
  bookLineId: string | null;
  /** How the match was arrived at, so a person can judge it. */
  how: 'exact' | 'near' | 'none';
  /** Days between the bank's date and the posting's. */
  daysApart: number;
}

/**
 * How far apart two dates may be and still be the same transaction.
 *
 * A payment written on Friday reaches a bank on Monday, and a cheque takes
 * longer. Five days catches nearly everything without matching this month's
 * rent to last month's, and anything outside it is offered to a person rather
 * than decided for them.
 */
export const MATCH_WINDOW_DAYS = 5;

const daysBetween = (a: string, b: string): number => {
  const x = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const y = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((x - y) / 86_400_000));
};

/**
 * Pair up what the bank says with what the books say.
 *
 * The amount has to agree exactly. Everything else is a judgement, and this is
 * deliberately not clever about any of it: matching by a similar amount, or by
 * words in a description, produces pairs that look right and are not, and a
 * reconciliation that quietly matched the wrong two things is worse than one
 * that matched nothing, because nobody goes looking afterwards.
 *
 * Same day is called exact; within a few days is called near, because a
 * payment written on Friday reaches the bank on Monday. Both are shown as what
 * they are so a person can disagree.
 *
 * Nothing is matched twice. A book posting taken by one bank line is gone, and
 * the closest date wins, so two identical amounts a month apart pair with their
 * own dates rather than with whichever came first in the file.
 */
export function matchStatement(
  bank: BankLine[],
  book: { line_id: string; date: string; amount: number }[],
  windowDays = MATCH_WINDOW_DAYS,
): { matches: Match[]; unmatchedBook: string[] } {
  const taken = new Set<string>();

  // Closest first, across the whole file rather than line by line. Taking each
  // bank line in turn lets an early one claim a posting that belonged to a
  // later one, which is how a month of small identical amounts ends up
  // matched entirely to the wrong days.
  const candidates: { bankId: string; lineId: string; days: number }[] = [];
  for (const b of bank) {
    for (const l of book) {
      if (l.amount !== b.amount) continue;
      const days = daysBetween(b.date, l.date);
      if (days <= windowDays) candidates.push({ bankId: b.id, lineId: l.line_id, days });
    }
  }
  candidates.sort((x, y) => x.days - y.days);

  const chosen = new Map<string, { lineId: string; days: number }>();
  for (const c of candidates) {
    if (chosen.has(c.bankId) || taken.has(c.lineId)) continue;
    chosen.set(c.bankId, { lineId: c.lineId, days: c.days });
    taken.add(c.lineId);
  }

  const matches: Match[] = bank.map((b) => {
    const hit = chosen.get(b.id);
    if (!hit) return { bank: b, bookLineId: null, how: 'none', daysApart: 0 };
    return {
      bank: b,
      bookLineId: hit.lineId,
      how: hit.days === 0 ? 'exact' : 'near',
      daysApart: hit.days,
    };
  });

  return { matches, unmatchedBook: book.filter((l) => !taken.has(l.line_id)).map((l) => l.line_id) };
}

/**
 * Read a bank statement's rows into lines.
 *
 * Banks export whatever they like, so the columns are named rather than
 * assumed by position: a file whose columns moved would otherwise import
 * silently with the date in the amount. Money in and money out arrive either
 * as one signed column or as two, and both are accepted, because arguing with
 * somebody's bank about its export format is not a fight worth having.
 */
export function readStatement(rows: string[][]): { lines: BankLine[]; problems: string[] } {
  const problems: string[] = [];
  if (rows.length < 2) return { lines: [], problems: ['That file has no rows in it.'] };

  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  const find = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  const iDate = find('date', 'transactiondate', 'posteddate');
  const iDesc = find('description', 'narration', 'details', 'particulars', 'reference');
  const iAmount = find('amount', 'value');
  const iIn = find('credit', 'moneyin', 'deposit', 'paidin');
  const iOut = find('debit', 'moneyout', 'withdrawal', 'paidout');

  if (iDate < 0) problems.push('No date column. One of the columns has to be called Date.');
  if (iAmount < 0 && iIn < 0 && iOut < 0) {
    problems.push('No amount column. Either one called Amount, or a pair called Credit and Debit.');
  }
  if (problems.length) return { lines: [], problems };

  const lines: BankLine[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row || row.every((c) => !c?.trim())) continue;

    const date = (row[iDate] ?? '').trim();
    if (!date) { problems.push(`Row ${r + 1} has no date.`); continue; }

    let amount: number | null = null;
    if (iAmount >= 0) {
      amount = readAmount(row[iAmount]);
    } else {
      const inn = iIn >= 0 ? readAmount(row[iIn]) ?? 0 : 0;
      const out = iOut >= 0 ? readAmount(row[iOut]) ?? 0 : 0;
      amount = inn - Math.abs(out);
    }
    if (amount === null || amount === 0) { problems.push(`Row ${r + 1} has no amount.`); continue; }

    lines.push({
      id: `row-${r}`,
      date: normaliseDate(date),
      description: (iDesc >= 0 ? row[iDesc] ?? '' : '').trim(),
      amount,
    });
  }

  return { lines, problems };
}

/** A money cell from a bank, in minor units. Handles 1,234.56 and (1,234.56). */
function readAmount(cell?: string): number | null {
  const raw = (cell ?? '').trim();
  if (!raw) return null;
  // Brackets are how a statement writes a negative, and a minus is how another
  // one does. Both mean out.
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  const digits = raw.replace(/[()\-\s,]/g, '').replace(/[^\d.]/g, '');
  if (!digits || !/^\d*\.?\d*$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (negative ? -1 : 1);
}

/** A bank's date, as YYYY-MM-DD. Day-first where it is ambiguous. */
function normaliseDate(raw: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // 14/08/2026 and 14-08-2026. Day first, because that is what Ghana, and
  // most of the world outside the United States, writes on a statement.
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(raw.trim());
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : raw.slice(0, 10);
}

/* ------------------------------------------------------------ locked books */

/**
 * Is this date inside a period that has been closed?
 *
 * Everything on or BEFORE the lock date is shut. The whole of the last day is
 * included, which is the point of locking to the end of a month: a lock
 * through the 31st that let the 31st be posted to would leave the one day
 * somebody is most likely to be adjusting still open.
 */
export function isLocked(date: string, lockedThrough?: string): boolean {
  if (!lockedThrough) return false;
  const d = (date ?? '').slice(0, 10);
  const through = lockedThrough.slice(0, 10);
  return d !== '' && d <= through;
}

/** What to say when a posting lands in a closed period. */
export const lockedMessage = (date: string, lockedThrough: string): string =>
  `The books are closed up to ${lockedThrough.slice(0, 10)}, and this is dated ${date.slice(0, 10)}. `
  + 'Post it in an open period, or reopen the books first — which is recorded.';
