import { db, DB_ID, ID, Query, listAll } from './client';
import type { Doc } from './types';
import { entryProblem, within, chargeForMonth } from './ledger-math';
import type { AccountRow, DepreciableAsset } from './ledger-math';

export interface JournalEntry extends Doc {
  venue_id: string;
  date: string;
  source: string;
  source_id?: string;
  shift_id?: string;
  memo?: string;
  posted_by: string;
  /** What undid this entry, and what this entry undid. See reverseEntry. */
  reversed_by?: string;
  reversal_of?: string;
}

export interface JournalLine extends Doc {
  venue_id: string;
  entry_id: string;
  account_code: string;
  debit: number;
  credit: number;
  memo?: string;
}

/** Account codes seeded by provisioning. Kept here so postings read plainly. */
export const ACCOUNTS = {
  cash: '1000',
  cardClearing: '1010',
  momoClearing: '1020',
  inventory: '1200',
  taxPayable: '2100',
  tipsPayable: '2200',
  foodSales: '4000',
  discountsGiven: '4900',
  cogs: '5000',
  cashOverShort: '7000',
  // What the business owns and uses rather than sells, and how much of it has
  // been used up. Depreciation posts to these by number.
  equipment: '1500',
  accumDepreciation: '1510',
  depreciation: '6060',
} as const;

/**
 * Accounts the system itself posts to, which therefore cannot be removed.
 *
 * Everything else in the chart is the restaurant's own and can be renamed,
 * added to or retired. These ten are named in code, a shift close writes to
 * them by number, so deleting one would not produce an error message, it
 * would produce a shift that fails to balance at eleven at night.
 *
 * Derived from ACCOUNTS rather than listed again, so the protected set cannot
 * drift away from the set actually in use.
 */
export const SYSTEM_ACCOUNT_CODES: readonly string[] = Object.values(ACCOUNTS);
export const isSystemAccount = (code: string) => SYSTEM_ACCOUNT_CODES.includes(code);

/**
 * Accounts an expense category may be pointed at.
 *
 * Expense lines only, money going out lands on an expense account, and
 * offering "Food sales" as a destination for a gas refill is offering a way to
 * make the books wrong. Cost of goods sold and cash over/short are left out
 * too: both are posted automatically at shift close from the stock count and
 * the drawer count, and an expense filed there would be double-counted.
 */
export const isPostableExpenseAccount = (a: { code: string; type: string }) =>
  a.type === 'expense' && a.code !== ACCOUNTS.cogs && a.code !== ACCOUNTS.cashOverShort;

export interface PostingLine {
  account_code: string;
  debit: number;
  credit: number;
  memo?: string;
}

/**
 * Post a balanced entry.
 *
 * Refuses to write if debits and credits differ. An unbalanced ledger is worse
 * than no ledger: it looks authoritative and quietly is not, and every report
 * built on top of it inherits the error.
 */
export async function postEntry(
  venueId: string,
  opts: { date?: Date; source: string; sourceId?: string; shiftId?: string; memo?: string; postedBy: string },
  lines: PostingLine[],
): Promise<JournalEntry> {
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const credits = lines.reduce((s, l) => s + l.credit, 0);
  if (debits !== credits) {
    throw new Error(`Entry does not balance: debits ${debits} vs credits ${credits}. Nothing was posted.`);
  }
  if (lines.length === 0) throw new Error('An entry needs at least one line.');

  const entry = (await db.createDocument(DB_ID, 'journal_entries', ID.unique(), {
    venue_id: venueId,
    date: (opts.date ?? new Date()).toISOString(),
    source: opts.source,
    source_id: opts.sourceId ?? '',
    shift_id: opts.shiftId ?? '',
    memo: opts.memo ?? '',
    posted_by: opts.postedBy,
  })) as unknown as JournalEntry;

  await Promise.all(
    lines.map((l) =>
      db.createDocument(DB_ID, 'journal_lines', ID.unique(), {
        venue_id: venueId,
        entry_id: entry.$id,
        account_code: l.account_code,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo ?? '',
      }),
    ),
  );

  return entry;
}

export interface ShiftPosting {
  venueId: string;
  shiftId: string;
  postedBy: string;
  /** Money taken, split by payment method kind. */
  takings: { cash: number; card: number; mobile_money: number; other: number };
  tips: number;
  tax: number;
  discounts: number;
  cogs: number;
  cashVariance: number;
  expenses: { amount: number; accountCode: string }[];
}

/**
 * Turn one closed shift into ledger entries.
 *
 * Separate entries per concern rather than one giant one, so a wrong figure can
 * be traced and reversed on its own instead of unpicking the whole day.
 */
export async function postShift(p: ShiftPosting): Promise<string[]> {
  const posted: string[] = [];
  const common = { shiftId: p.shiftId, postedBy: p.postedBy, source: 'shift_close', sourceId: p.shiftId };

  // --- sales: what came in, what it was made of, and what is owed onward
  const gross = p.takings.cash + p.takings.card + p.takings.mobile_money + p.takings.other;
  if (gross > 0 || p.discounts > 0) {
    const netRevenue = gross - p.tax - p.tips;
    const lines: PostingLine[] = [
      { account_code: ACCOUNTS.cash, debit: p.takings.cash, credit: 0, memo: 'Cash taken' },
      { account_code: ACCOUNTS.cardClearing, debit: p.takings.card, credit: 0, memo: 'Card taken' },
      { account_code: ACCOUNTS.momoClearing, debit: p.takings.mobile_money, credit: 0, memo: 'Mobile money taken' },
      // Discounts are recorded as a debit rather than netted off sales, so
      // "how much did we give away" stays an answerable question.
      { account_code: ACCOUNTS.discountsGiven, debit: p.discounts, credit: 0, memo: 'Discounts given' },
      { account_code: ACCOUNTS.foodSales, debit: 0, credit: netRevenue + p.discounts, memo: 'Sales' },
      { account_code: ACCOUNTS.taxPayable, debit: 0, credit: p.tax, memo: 'Tax collected' },
      { account_code: ACCOUNTS.tipsPayable, debit: 0, credit: p.tips, memo: 'Tips owed to staff' },
    ].filter((l) => l.debit !== 0 || l.credit !== 0);

    if (p.takings.other > 0) {
      lines.push({ account_code: ACCOUNTS.cash, debit: p.takings.other, credit: 0, memo: 'Other tender' });
    }
    const entry = await postEntry(p.venueId, { ...common, memo: 'Shift sales' }, lines);
    posted.push(entry.$id);
  }

  // --- cost of what was sold
  if (p.cogs > 0) {
    const entry = await postEntry(p.venueId, { ...common, memo: 'Cost of goods sold' }, [
      { account_code: ACCOUNTS.cogs, debit: p.cogs, credit: 0 },
      { account_code: ACCOUNTS.inventory, debit: 0, credit: p.cogs },
    ]);
    posted.push(entry.$id);
  }

  // --- money paid out during the shift
  for (const e of p.expenses.filter((x) => x.amount > 0)) {
    const entry = await postEntry(p.venueId, { ...common, memo: 'Shift expense' }, [
      { account_code: e.accountCode, debit: e.amount, credit: 0 },
      { account_code: ACCOUNTS.cash, debit: 0, credit: e.amount },
    ]);
    posted.push(entry.$id);
  }

  // --- the drawer being over or short is itself a cost, and belongs on record
  if (p.cashVariance !== 0) {
    const short = p.cashVariance < 0;
    const amount = Math.abs(p.cashVariance);
    const entry = await postEntry(p.venueId, { ...common, memo: short ? 'Cash short' : 'Cash over' }, [
      { account_code: short ? ACCOUNTS.cashOverShort : ACCOUNTS.cash, debit: amount, credit: 0 },
      { account_code: short ? ACCOUNTS.cash : ACCOUNTS.cashOverShort, debit: 0, credit: amount },
    ]);
    posted.push(entry.$id);
  }

  return posted;
}

export interface TrialBalanceRow {
  account_code: string;
  debit: number;
  credit: number;
  balance: number;
}

/** Every account's totals, the check that the books actually balance. */
export async function trialBalance(venueId: string): Promise<{ rows: TrialBalanceRow[]; balanced: boolean }> {
  const lines = await listAll<JournalLine>('journal_lines', [Query.equal('venue_id', venueId)]);
  const map = new Map<string, TrialBalanceRow>();

  for (const l of lines) {
    const row = map.get(l.account_code) ?? { account_code: l.account_code, debit: 0, credit: 0, balance: 0 };
    row.debit += l.debit;
    row.credit += l.credit;
    row.balance = row.debit - row.credit;
    map.set(l.account_code, row);
  }

  const rows = [...map.values()].sort((a, b) => a.account_code.localeCompare(b.account_code));
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { rows, balanced: totalDebit === totalCredit };
}

/**
 * The arithmetic lives next door, in a file that imports nothing.
 *
 * Re-exported so callers keep working. The split exists so the sums that
 * decide what a business believes it earned and what it believes it owns can
 * be checked without a database.
 */
export * from './ledger-math';

/* ------------------------------------------------------- reading the books */

/** Every posting inside a window, with its entry's date carried onto it. */
export async function ledgerLines(
  venueId: string,
  range?: { from?: string; to?: string },
): Promise<(JournalLine & { date: string })[]> {
  const [entries, lines] = await Promise.all([
    listAll<JournalEntry>('journal_entries', [Query.equal('venue_id', venueId)]),
    listAll<JournalLine>('journal_lines', [Query.equal('venue_id', venueId)]),
  ]);
  // A line has no date of its own; its entry has. Joined here rather than
  // stamped on both, because a line and its entry disagreeing about when
  // something happened is a class of bug with no honest resolution.
  const dateOf = new Map(entries.map((e) => [e.$id, e.date]));
  const dated = lines
    .map((l) => ({ ...l, date: dateOf.get(l.entry_id) ?? '' }))
    .filter((l) => l.date !== '');
  return range ? within(dated, range.from, range.to) : dated;
}

/** The chart, in the order a set of accounts is normally read. */
export const loadAccounts = async (): Promise<AccountRow[]> =>
  (await listAll<AccountRow & Doc>('accounts')).sort((a, b) => a.code.localeCompare(b.code));

/* ------------------------------------------------------ writing to the books */

/**
 * An entry somebody typed themselves.
 *
 * Everything else in these books is posted by the system from something that
 * happened — a shift closed, a bill was settled, a payout was made. This is
 * the way in for everything that has no such event: rent, a bank charge, the
 * owner putting money in, a correction an accountant asks for at year end.
 *
 * Checked before it is written, because `postEntry` refuses an unbalanced
 * entry with a message meant for a developer, and the person typing this is
 * not one. `entryProblem` says what is actually wrong with it.
 */
export async function postManualEntry(
  venueId: string,
  opts: { date: Date; memo: string; postedBy: string },
  lines: PostingLine[],
): Promise<string> {
  const problem = entryProblem(lines);
  if (problem) throw new Error(problem);

  const entry = await postEntry(
    venueId,
    { date: opts.date, source: 'adjustment', memo: opts.memo, postedBy: opts.postedBy },
    lines.filter((l) => l.debit !== 0 || l.credit !== 0),
  );
  return entry.$id;
}

/**
 * Undo an entry by posting its opposite.
 *
 * Never by deleting it. Books that can be quietly edited are not books, and
 * the question an auditor asks is not "what does it say now" but "what did it
 * say, and who changed it". A reversal leaves both halves standing and the
 * net effect is nought, which is the same answer arrived at honestly.
 *
 * Refused on an entry already reversed, because reversing a reversal twice is
 * how somebody turns a mistake into the opposite mistake at double the size.
 */
export async function reverseEntry(
  entry: JournalEntry,
  opts: { postedBy: string; memo?: string },
): Promise<string> {
  if (entry.reversed_by) throw new Error('That entry has already been reversed.');

  const lines = await listAll<JournalLine>('journal_lines', [Query.equal('entry_id', entry.$id)]);
  if (lines.length === 0) throw new Error('That entry has no lines to reverse.');

  const reversal = await postEntry(
    entry.venue_id,
    {
      // Dated today, not on the original's date. A reversal is something that
      // happened now; back-dating it into a period somebody has already
      // reported on changes a figure that has been read and acted upon.
      source: 'reversal',
      sourceId: entry.$id,
      memo: opts.memo?.trim() || `Reversal of ${entry.memo || entry.source}`,
      postedBy: opts.postedBy,
    },
    // Every side swapped. Nothing is recalculated: whatever the original said,
    // the opposite of it is what cancels it, including anything wrong with it.
    lines.map((l) => ({
      account_code: l.account_code,
      debit: l.credit,
      credit: l.debit,
      memo: l.memo,
    })),
  );

  await db.updateDocument(DB_ID, 'journal_entries', reversal.$id, { reversal_of: entry.$id }).catch(() => undefined);
  // The original names what undid it, so the pair reads from either end. Best
  // effort: the reversal is posted and correct either way, and an entry that
  // does not know it was reversed is a display problem, not a wrong figure.
  await db.updateDocument(DB_ID, 'journal_entries', entry.$id, { reversed_by: reversal.$id }).catch(() => undefined);

  return reversal.$id;
}

/* ------------------------------------------------------------ depreciation */

export interface FixedAsset extends Doc, DepreciableAsset {
  venue_id?: string;
  name: string;
  category?: string;
  asset_account_code?: string;
  accum_account_code?: string;
  expense_account_code?: string;
  disposal_proceeds?: number;
  note?: string;
  active?: boolean;
}

export const loadFixedAssets = async (venueId: string): Promise<FixedAsset[]> =>
  (await listAll<FixedAsset>('fixed_assets').catch(() => [] as FixedAsset[]))
    .filter((a) => !a.venue_id || a.venue_id === venueId)
    .sort((a, b) => (b.acquired_on ?? '').localeCompare(a.acquired_on ?? ''));

/**
 * Charge one month's depreciation across every asset that owes it.
 *
 * Run rather than scheduled, and deliberately. This system may have four
 * background functions in total and all four are doing something that cannot
 * wait; depreciation can, because nobody needs last month's charge before
 * somebody looks at last month's figures. A button that says what it did beats
 * a job nobody can see running.
 *
 * Posting the same month twice would double the charge, so a month already
 * posted is skipped. That is checked against the entries themselves rather
 * than a flag on the asset: the entries are the books, and a flag can be right
 * about a posting that was later reversed.
 */
export async function postDepreciation(
  venueId: string,
  month: string,
  opts: { postedBy: string },
): Promise<{ posted: number; total: number; skipped: string[] }> {
  const assets = await loadFixedAssets(venueId);
  const already = await listAll<JournalEntry>('journal_entries', [
    Query.equal('venue_id', venueId),
    Query.equal('source', 'adjustment'),
  ]).catch(() => [] as JournalEntry[]);

  const done = new Set(
    already.filter((e) => e.source_id?.startsWith(`depreciation:${month}:`)).map((e) => e.source_id as string),
  );

  const skipped: string[] = [];
  let posted = 0;
  let total = 0;

  for (const asset of assets) {
    if (asset.active === false) continue;
    const amount = chargeForMonth(asset, month);
    if (amount <= 0) continue;

    const key = `depreciation:${month}:${asset.$id}`;
    if (done.has(key)) { skipped.push(asset.name); continue; }

    await postEntry(
      venueId,
      {
        // The last day of the month it is a charge for, so it falls inside the
        // period it belongs to however long afterwards somebody runs it.
        date: endOfMonth(month),
        source: 'adjustment',
        sourceId: key,
        memo: `Depreciation, ${asset.name}, ${month}`,
        postedBy: opts.postedBy,
      },
      [
        { account_code: asset.expense_account_code || ACCOUNTS.depreciation, debit: amount, credit: 0 },
        { account_code: asset.accum_account_code || ACCOUNTS.accumDepreciation, debit: 0, credit: amount },
      ],
    );
    posted += 1;
    total += amount;
  }

  return { posted, total, skipped };
}

/** The last moment of a YYYY-MM, without touching a timezone by accident. */
function endOfMonth(month: string): Date {
  const [y, m] = month.split('-').map(Number);
  // Day 0 of the next month is the last day of this one, which is also how
  // February gets its length right without anybody writing it down.
  return new Date(Date.UTC(y, m, 0, 23, 59, 59));
}
