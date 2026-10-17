import { Query, listAll, saveDropping } from './client';
import { postEntry } from './ledger';
import { ACCOUNTS } from './accounts';
import { payProblem } from './owed-spends';
import type { OwedSpend, PayVia } from './owed-spends';

/**
 * Spends received on account. Narrowed to what is still owed by stillOwed.
 * Spends carry no venue of their own; there is one.
 */
export const loadOwedSpends = (): Promise<OwedSpend[]> =>
  listAll<OwedSpend>('shift_expenses', [Query.equal('pay_later', true)]);

/**
 * Pay a supplier for stock received on account.
 *
 * Accounts payable down, the bank or the cash down, dated the day it was
 * paid. Keyed by the spend, so paying twice posts once.
 */
export async function payOwedSpend(opts: {
  venueId: string;
  spend: OwedSpend;
  via: PayVia;
  date: Date;
  reference?: string;
  userId: string;
}): Promise<void> {
  const why = payProblem(opts.spend, opts.via);
  if (why) throw new Error(why);
  await postEntry(opts.venueId, {
    date: opts.date,
    source: 'adjustment',
    sourceId: `owed_paid:${opts.spend.$id}`,
    memo: `Paid ${opts.spend.payee || 'the supplier'} for stock received${opts.reference ? ` · ${opts.reference}` : ''}`,
    postedBy: opts.userId,
  }, [
    { account_code: ACCOUNTS.accountsPayable, debit: opts.spend.amount, credit: 0 },
    { account_code: opts.via === 'bank' ? ACCOUNTS.bank : ACCOUNTS.cash, debit: 0, credit: opts.spend.amount },
  ]);
  await saveDropping('shift_expenses', opts.spend.$id, {
    paid_at: opts.date.toISOString(),
    paid_via: opts.via,
    paid_ref: (opts.reference ?? '').slice(0, 120),
    paid_by: opts.userId,
  });
}
