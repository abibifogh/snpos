import { db, DB_ID, ID, Query, listAll } from './client';
import type { Doc } from './types';
import { entryProblem, within, chargeForMonth, isLocked, lockedMessage } from './ledger-math';
import { uploadFile } from './files';
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
  /** The evidence, attached to the posting rather than to a drawer. */
  receipt_file_id?: string;
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

  /**
   * Nothing lands in a period that has been closed.
   *
   * Checked here rather than in each caller, because here is the one place
   * every posting in this system passes through: a shift close, a payout, an
   * expense, depreciation, a statement line, an entry somebody typed. A rule
   * enforced in six places is a rule with five ways round it, and the way
   * round is always the one nobody remembered to guard.
   */
  const date = (opts.date ?? new Date()).toISOString();
  const lockedThrough = await lockedThroughFor(venueId);
  if (isLocked(date, lockedThrough)) throw new Error(lockedMessage(date, lockedThrough));

  const entry = (await db.createDocument(DB_ID, 'journal_entries', ID.unique(), {
    venue_id: venueId,
    date,
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
  expenses: { amount: number; accountCode: string; expenseId?: string }[];
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

  /**
   * Money paid out during the shift.
   *
   * Each one posted by id rather than as a batch, and skipped if it is already
   * on the books. Expenses used to reach the ledger only here, at shift close,
   * which meant one recorded outside a shift — from the admin form, or after
   * the till had been closed for the night — never reached it at all. The
   * books were short by every one of those, and nothing said so.
   *
   * They now post themselves the moment they are recorded, so most are already
   * there by the time a shift closes. This stays as the net under that: an
   * expense whose own posting failed still lands, and one that landed is not
   * counted twice.
   */
  for (const e of p.expenses.filter((x) => x.amount > 0)) {
    const id = await postExpense(p.venueId, {
      expenseId: e.expenseId,
      amount: e.amount,
      accountCode: e.accountCode,
      postedBy: p.postedBy,
      shiftId: p.shiftId,
    });
    if (id) posted.push(id);
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

/* ------------------------------------------------- money out, wherever it was */

/**
 * Put one expense on the books, once.
 *
 * Expenses reached the ledger only at shift close, so one recorded outside a
 * shift — from the admin form, or after the till had been shut for the night —
 * never reached it at all. Those are real money that really left, and the
 * books were short by every one of them with nothing to say so.
 *
 * Keyed by the expense's own id, and refused if that id is already posted. The
 * key is what makes this safe to call from everywhere it should be called
 * from: the till form, the admin form, and the shift close that used to be the
 * only one. Calling it twice does nothing the second time, which is the
 * property that lets all three exist without anybody having to reason about
 * which of them got there first.
 *
 * Returns the entry id when it posted, and null when there was nothing to do.
 */
export async function postExpense(
  venueId: string,
  e: { expenseId?: string; amount: number; accountCode: string; postedBy: string; shiftId?: string; date?: Date },
): Promise<string | null> {
  if (!e.amount || e.amount <= 0) return null;

  const key = e.expenseId ? `expense:${e.expenseId}` : '';
  if (key) {
    const already = await db.listDocuments(DB_ID, 'journal_entries', [
      Query.equal('venue_id', venueId),
      Query.equal('source_id', key),
      Query.limit(1),
    ]).catch(() => ({ total: 0 }));
    if (already.total > 0) return null;
  }

  const entry = await postEntry(
    venueId,
    {
      date: e.date,
      source: 'expense',
      sourceId: key || undefined,
      shiftId: e.shiftId,
      memo: 'Money paid out',
      postedBy: e.postedBy,
    },
    [
      { account_code: e.accountCode, debit: e.amount, credit: 0 },
      // Out of the drawer. What it was paid FROM is on the expense; every
      // method a business may pay an expense from is cash or a cash-like
      // float, and none of them is a card the customer holds.
      { account_code: ACCOUNTS.cash, debit: 0, credit: e.amount },
    ],
  );
  return entry.$id;
}

/**
 * Which account an expense's category points at.
 *
 * Shared so the till, the admin form and the shift close cannot disagree about
 * where a taxi lands. Falls back to Other expenses rather than refusing: an
 * expense filed imperfectly is a great deal better than an expense that would
 * not save.
 */
export async function accountForExpense(e: { category_key?: string; category?: string }): Promise<string> {
  const cats = await listAll<{ key: string; account_code?: string }>('expense_categories').catch(() => []);
  return cats.find((c) => c.key === (e.category_key || e.category))?.account_code || '6090';
}

/* --------------------------------------------------------- editing an entry */

/**
 * Change an entry that has already been posted.
 *
 * Against the usual rule, and deliberately so. The usual rule is that a wrong
 * entry is corrected by posting its opposite and both halves stay, because an
 * auditor's question is not "what does it say" but "what did it say, and who
 * changed it". That is right, and it is why `reverseEntry` still exists and is
 * still the better answer on anything a third party has already seen.
 *
 * It is also why reversals double the length of a journal, and a journal
 * nobody can read is its own kind of unreliable. For a business of this size
 * the owner asked for the simpler thing, and the trade is theirs to make.
 *
 * What is not given up is the history. Every edit writes what the entry said
 * before into the audit log, which this page cannot reach and the erase page
 * never clears, so the old version survives somewhere an admin cannot quietly
 * remove it from. Editing was worth allowing; QUIETLY editing was the part
 * worth preventing.
 *
 * The lines are replaced rather than patched. An edit changes how many there
 * are, and matching an old line to a new one is guesswork that gets the
 * account wrong in exactly the case somebody was fixing.
 */
export async function editEntry(
  entry: JournalEntry,
  next: { date?: Date; memo: string; lines: PostingLine[] },
  opts: { editedBy: string },
): Promise<void> {
  if (entry.reversed_by) throw new Error('That entry has been reversed. Edit the reversal, or post a fresh entry.');
  const problem = entryProblem(next.lines);
  if (problem) throw new Error(problem);

  /**
   * Both dates, not one.
   *
   * Where it is now, because changing a figure inside a closed period is the
   * thing locking exists to stop. And where it is going, because moving an
   * open entry backwards into a closed period would otherwise be the way
   * round the rule.
   */
  const lockedThrough = await lockedThroughFor(entry.venue_id);
  const moving = next.date?.toISOString() ?? entry.date;
  for (const d of [entry.date, moving]) {
    if (isLocked(d, lockedThrough)) throw new Error(lockedMessage(d, lockedThrough));
  }

  const before = await listAll<JournalLine>('journal_lines', [Query.equal('entry_id', entry.$id)]);

  // Written first, so the old version is safe before anything is taken away.
  // An audit trail that is written last is an audit trail that is missing for
  // exactly the runs that failed half way.
  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: entry.venue_id,
    actor_id: opts.editedBy,
    action: 'journal_edited',
    entity_type: 'journal_entry',
    entity_id: entry.$id,
    before: JSON.stringify({
      date: entry.date,
      memo: entry.memo,
      lines: before.map((l) => ({ account_code: l.account_code, debit: l.debit, credit: l.credit, memo: l.memo })),
    }).slice(0, 4000),
    after: JSON.stringify({
      date: next.date?.toISOString() ?? entry.date,
      memo: next.memo,
      lines: next.lines,
    }).slice(0, 4000),
  });

  const keep = next.lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  for (const l of keep) {
    await db.createDocument(DB_ID, 'journal_lines', ID.unique(), {
      venue_id: entry.venue_id,
      entry_id: entry.$id,
      account_code: l.account_code,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo ?? '',
    });
  }
  // The old lines go only once the new ones are down. The other order leaves a
  // window in which the entry exists with nothing on it, and anything reading
  // the books in that window sees an unbalanced ledger.
  for (const l of before) {
    await db.deleteDocument(DB_ID, 'journal_lines', l.$id).catch(() => undefined);
  }

  await db.updateDocument(DB_ID, 'journal_entries', entry.$id, {
    memo: next.memo,
    ...(next.date ? { date: next.date.toISOString() } : {}),
  });
}

/* --------------------------------------------------- evidence for a posting */

/**
 * Attach a receipt to a posting.
 *
 * A receipt in a drawer proves nothing a year later. One attached to an
 * expense is at least findable, but only from the expense — and a posting made
 * by hand, which is exactly the kind somebody will be asked to justify, had
 * nowhere at all to put one.
 *
 * The upload happens first and the entry is only pointed at it once it is
 * there, so a failed upload leaves an entry with no receipt rather than an
 * entry pointing at a file that does not exist.
 */
export async function attachReceipt(
  entryId: string,
  file: File,
  settings?: Parameters<typeof uploadFile>[2],
): Promise<string> {
  const { fileId } = await uploadFile(file, 'receipt', settings);
  await db.updateDocument(DB_ID, 'journal_entries', entryId, { receipt_file_id: fileId });
  return fileId;
}

/* ------------------------------------------------------- bank statements */

/**
 * One row from a bank's own export.
 *
 * Named for the bank rather than for the word "statement", because a
 * consignor's statement already owns that name in these exports and a reader
 * three files away cannot tell which is which.
 */
export interface BankStatementLine extends Doc {
  venue_id?: string;
  account_code: string;
  statement_date?: string;
  line_date: string;
  description?: string;
  amount: number;
  matched_line_id?: string;
}

export const loadStatementLines = async (accountCode: string): Promise<BankStatementLine[]> =>
  (await listAll<BankStatementLine>('statement_lines').catch(() => [] as BankStatementLine[]))
    .filter((l) => l.account_code === accountCode)
    .sort((a, b) => (a.line_date ?? '').localeCompare(b.line_date ?? ''));

/**
 * Save the rows read out of a bank's export.
 *
 * A line already imported is skipped rather than added again. Somebody
 * uploading August twice, or a file that overlaps last month by a few days,
 * is the ordinary case and not a mistake worth refusing — but importing the
 * same transaction twice turns a reconciliation into a search for a
 * discrepancy that was created by the import.
 *
 * Sameness is the date, the amount and the description together. Any two of
 * those genuinely repeat; all three on one account is one transaction.
 */
export async function importStatementLines(
  venueId: string,
  accountCode: string,
  statementDate: string,
  lines: { date: string; description: string; amount: number }[],
): Promise<{ added: number; alreadyThere: number }> {
  const existing = await loadStatementLines(accountCode);
  const seen = new Set(
    existing.map((l) => `${(l.line_date ?? '').slice(0, 10)}|${l.amount}|${(l.description ?? '').trim()}`),
  );

  let added = 0;
  let alreadyThere = 0;
  for (const l of lines) {
    const key = `${l.date.slice(0, 10)}|${l.amount}|${l.description.trim()}`;
    if (seen.has(key)) { alreadyThere += 1; continue; }
    seen.add(key);
    await db.createDocument(DB_ID, 'statement_lines', ID.unique(), {
      venue_id: venueId,
      account_code: accountCode,
      statement_date: new Date(`${statementDate}T12:00:00`).toISOString(),
      line_date: new Date(`${l.date}T12:00:00`).toISOString(),
      description: l.description.slice(0, 300),
      amount: l.amount,
      imported_at: new Date().toISOString(),
    });
    added += 1;
  }
  return { added, alreadyThere };
}

/**
 * Post the entry a bank line turned out to be, and tie the two together.
 *
 * For the lines the books have nothing for, which is what a reconciliation is
 * really looking for: a charge nobody recorded, interest, a transfer somebody
 * made from a phone. Done here rather than by sending somebody to the journal
 * and back, because the figure and the date are already on the screen and
 * retyping them is where they get typed wrongly.
 */
export async function postFromStatement(
  venueId: string,
  bankLine: BankStatementLine,
  opts: { accountCode: string; cashAccountCode: string; memo: string; postedBy: string },
): Promise<string> {
  const amount = Math.abs(bankLine.amount);
  // Money in debits the bank account and credits wherever it came from; money
  // out is the other way round. Getting this backwards is the single thing a
  // person doing this by hand gets wrong, which is why they do not type it.
  const intoAccount = bankLine.amount > 0;

  const entry = await postEntry(
    venueId,
    {
      date: new Date(bankLine.line_date),
      source: 'adjustment',
      sourceId: `statement:${bankLine.$id}`,
      memo: opts.memo || bankLine.description || 'From the bank statement',
      postedBy: opts.postedBy,
    },
    intoAccount
      ? [
          { account_code: opts.cashAccountCode, debit: amount, credit: 0 },
          { account_code: opts.accountCode, debit: 0, credit: amount },
        ]
      : [
          { account_code: opts.accountCode, debit: amount, credit: 0 },
          { account_code: opts.cashAccountCode, debit: 0, credit: amount },
        ],
  );

  // The line it became, so the same bank line cannot be posted twice.
  const lines = await listAll<JournalLine>('journal_lines', [Query.equal('entry_id', entry.$id)]);
  const cashLine = lines.find((l) => l.account_code === opts.cashAccountCode);
  if (cashLine) {
    await db.updateDocument(DB_ID, 'statement_lines', bankLine.$id, { matched_line_id: cashLine.$id })
      .catch(() => undefined);
  }
  return entry.$id;
}

/* --------------------------------------------------------- closing a period */

export interface PeriodLock extends Doc {
  venue_id?: string;
  locked_through: string;
  locked_by: string;
  locked_at: string;
  note?: string;
}

/**
 * Every lock and unlock, newest first.
 *
 * A row per act rather than a field that gets overwritten, so reopening a
 * period leaves a trace. Somebody opening January back up to change one figure
 * is exactly the event worth being able to see afterwards, and a field would
 * simply forget it happened.
 */
export const loadLocks = async (venueId: string): Promise<PeriodLock[]> =>
  (await listAll<PeriodLock>('accounting_locks').catch(() => [] as PeriodLock[]))
    .filter((l) => !l.venue_id || l.venue_id === venueId)
    .sort((a, b) => (b.locked_at ?? '').localeCompare(a.locked_at ?? ''));

/**
 * The line currently drawn under the books.
 *
 * The most recent act wins, not the latest date. Reopening a period means
 * saying "closed only up to the earlier day", and if the furthest date won
 * instead, a period could never be reopened at all.
 */
export async function lockedThroughFor(venueId: string): Promise<string> {
  const locks = await loadLocks(venueId);
  return locks[0]?.locked_through?.slice(0, 10) ?? '';
}

/**
 * Draw the line, or move it.
 *
 * Moving it backwards is reopening, and is recorded in exactly the same way as
 * closing: same row, same author, same moment, and the note says why. Nothing
 * is deleted, because the useful question a year later is not where the line
 * is but where it has been.
 */
export async function lockPeriod(
  venueId: string,
  through: string,
  opts: { lockedBy: string; note?: string },
): Promise<void> {
  await db.createDocument(DB_ID, 'accounting_locks', ID.unique(), {
    venue_id: venueId,
    locked_through: new Date(`${through.slice(0, 10)}T12:00:00`).toISOString(),
    locked_by: opts.lockedBy,
    locked_at: new Date().toISOString(),
    note: (opts.note ?? '').slice(0, 300),
  });
}

/**
 * Remove an entry and its lines.
 *
 * The last resort, and offered because the owner asked for it. Reversing keeps
 * both halves and is the right answer for anything a third party has seen;
 * editing changes it in place and keeps the old version; this leaves nothing
 * behind but the audit trail — which is exactly why the audit trail is written
 * first, before a single line is taken away.
 *
 * A locked period is refused, and so is an entry that has been reversed:
 * deleting one half of a pair leaves the other standing on its own, which is
 * an entry that says the opposite of what happened.
 */
export async function deleteEntry(entry: JournalEntry, opts: { deletedBy: string }): Promise<void> {
  if (entry.reversed_by || entry.reversal_of) {
    throw new Error('That is one half of a reversal. Deleting one half leaves the other saying the opposite of what happened.');
  }
  const lockedThrough = await lockedThroughFor(entry.venue_id);
  if (isLocked(entry.date, lockedThrough)) throw new Error(lockedMessage(entry.date, lockedThrough));

  const lines = await listAll<JournalLine>('journal_lines', [Query.equal('entry_id', entry.$id)]);

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: entry.venue_id,
    actor_id: opts.deletedBy,
    action: 'journal_deleted',
    entity_type: 'journal_entry',
    entity_id: entry.$id,
    before: JSON.stringify({
      date: entry.date,
      memo: entry.memo,
      source: entry.source,
      lines: lines.map((l) => ({ account_code: l.account_code, debit: l.debit, credit: l.credit })),
    }).slice(0, 4000),
  });

  for (const l of lines) await db.deleteDocument(DB_ID, 'journal_lines', l.$id).catch(() => undefined);
  await db.deleteDocument(DB_ID, 'journal_entries', entry.$id);
}
