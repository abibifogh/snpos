import { db, DB_ID, ID, Query, listAll, tryWrite, saveDropping } from './client';
import { postEntry } from './ledger';
import { ACCOUNTS } from './accounts';
import type { CashMove, CashPlan } from './cash-away';

/**
 * Writing down where the cash went, and confirming it reached the bank.
 * The rules are in cash-away.ts.
 */

export const loadCashMoves = (venueId: string): Promise<CashMove[]> =>
  listAll<CashMove>('cash_moves', [Query.equal('venue_id', venueId)])
    .then((rows) => rows.sort((a, b) => (b.$createdAt ?? '').localeCompare(a.$createdAt ?? '')));

/**
 * The close's answer, as movements. Best effort: the shift is closed and its
 * own row carries the split as well, so a failure here loses a convenience,
 * not the record.
 */
export async function recordCashPlan(opts: {
  venueId: string;
  shiftId: string;
  shiftCode?: string;
  module?: string;
  plan: CashPlan;
  userId: string;
}): Promise<void> {
  const base = {
    venue_id: opts.venueId,
    shift_id: opts.shiftId,
    shift_code: opts.shiftCode ?? '',
    module: opts.module ?? 'kitchen',
    taken_by: (opts.plan.takenBy ?? '').trim().slice(0, 120),
    recorded_by: opts.userId,
  };
  if (opts.plan.toSafe > 0) {
    await tryWrite(db.createDocument(DB_ID, 'cash_moves', ID.unique(), {
      ...base, kind: 'to_safe', status: 'in_safe', amount: Math.round(opts.plan.toSafe),
    }));
  }
  if (opts.plan.toBank > 0) {
    await tryWrite(db.createDocument(DB_ID, 'cash_moves', ID.unique(), {
      ...base, kind: 'to_bank', status: 'pending', amount: Math.round(opts.plan.toBank),
    }));
  }
}

/**
 * Cash taken to the bank at a close, confirmed with the slip.
 *
 * Posted now, not at the close: Bank up, cash on hand down, dated the day it
 * was paid in. Keyed by the movement, so confirming twice posts once.
 */
export async function confirmBanked(opts: {
  venueId: string;
  move: CashMove;
  amount: number;
  date: Date;
  reference?: string;
  userId: string;
}): Promise<void> {
  await postEntry(opts.venueId, {
    date: opts.date,
    source: 'adjustment',
    sourceId: `cash_move:${opts.move.$id}`,
    memo: `Cash banked${opts.move.shift_code ? ` from ${opts.move.shift_code}` : ''}${opts.reference ? ` · ${opts.reference}` : ''}`,
    postedBy: opts.userId,
  }, [
    { account_code: ACCOUNTS.bank, debit: opts.amount, credit: 0 },
    { account_code: ACCOUNTS.cash, debit: 0, credit: opts.amount },
  ]);
  await saveDropping('cash_moves', opts.move.$id, {
    status: 'banked',
    amount: Math.round(opts.amount),
    banked_at: opts.date.toISOString(),
    banked_ref: (opts.reference ?? '').slice(0, 120),
    banked_by: opts.userId,
  });
}

/** Cash taken out of the safe and paid into the bank. */
export async function bankFromSafe(opts: {
  venueId: string;
  amount: number;
  date: Date;
  reference?: string;
  takenBy?: string;
  userId: string;
}): Promise<void> {
  const { id } = await saveDropping('cash_moves', null, {
    venue_id: opts.venueId,
    kind: 'safe_to_bank',
    status: 'banked',
    amount: Math.round(opts.amount),
    taken_by: (opts.takenBy ?? '').slice(0, 120),
    recorded_by: opts.userId,
    banked_at: opts.date.toISOString(),
    banked_ref: (opts.reference ?? '').slice(0, 120),
    banked_by: opts.userId,
  });
  await postEntry(opts.venueId, {
    date: opts.date,
    source: 'adjustment',
    sourceId: `cash_move:${id}`,
    memo: `Cash banked from the safe${opts.reference ? ` · ${opts.reference}` : ''}`,
    postedBy: opts.userId,
  }, [
    { account_code: ACCOUNTS.bank, debit: opts.amount, credit: 0 },
    { account_code: ACCOUNTS.cash, debit: 0, credit: opts.amount },
  ]);
}
