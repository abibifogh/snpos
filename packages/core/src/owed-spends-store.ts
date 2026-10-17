import { Query, listAll, saveDropping } from './client';
import { postEntry } from './ledger';
import { ACCOUNTS } from './accounts';
import { payProblem, leftToPay } from './owed-spends';
import type { OwedSpend, PayVia } from './owed-spends';

/**
 * Spends received on account. Narrowed to what is still owed by stillOwed.
 * Spends carry no venue of their own; there is one.
 */
export const loadOwedSpends = (): Promise<OwedSpend[]> =>
  listAll<OwedSpend>('shift_expenses', [Query.equal('pay_later', true)]);

/**
 * Pay a bill, in full or in part.
 *
 * Accounts payable down, and the bank or cash down, dated the day it was
 * paid. `via` is the account it was paid from: 'bank' and 'cash' name the
 * main bank account and cash on hand, any other value an account code (a
 * second bank account, the MoMo wallet). Keyed by the bill and what had been
 * paid before, so pressing twice does not post twice.
 */
export async function payOwedSpend(opts: {
  venueId: string;
  spend: OwedSpend;
  via: PayVia | string;
  date: Date;
  /** Left out, everything still to pay. */
  amount?: number;
  reference?: string;
  userId: string;
}): Promise<void> {
  const amount = Math.round(opts.amount ?? leftToPay(opts.spend));
  const why = payProblem(opts.spend, opts.via, amount);
  if (why) throw new Error(why);
  const before = opts.spend.paid_amount ?? 0;
  const from = opts.via === 'bank' ? ACCOUNTS.bank : opts.via === 'cash' ? ACCOUNTS.cash : opts.via;
  await postEntry(opts.venueId, {
    date: opts.date,
    source: 'adjustment',
    sourceId: `owed_paid:${opts.spend.$id}:${before}`,
    memo: `Paid ${opts.spend.payee || 'the supplier'}${amount < leftToPay(opts.spend) ? ' (part)' : ''}${opts.reference ? ` · ${opts.reference}` : ''}`,
    postedBy: opts.userId,
  }, [
    { account_code: ACCOUNTS.accountsPayable, debit: amount, credit: 0 },
    { account_code: from, debit: 0, credit: amount },
  ]);
  const paid = before + amount;
  await saveDropping('shift_expenses', opts.spend.$id, {
    paid_amount: paid,
    ...(paid >= opts.spend.amount ? { paid_at: opts.date.toISOString() } : {}),
    paid_via: String(opts.via).slice(0, 20),
    paid_ref: (opts.reference ?? '').slice(0, 120),
    paid_by: opts.userId,
  });
}
