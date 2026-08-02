import { db, DB_ID, ID, Query, listAll } from './client';
import type { Doc } from './types';

export interface JournalEntry extends Doc {
  venue_id: string;
  date: string;
  source: string;
  source_id?: string;
  shift_id?: string;
  memo?: string;
  posted_by: string;
  reversed_by?: string;
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
} as const;

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

/** Every account's totals — the check that the books actually balance. */
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
