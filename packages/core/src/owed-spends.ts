/**
 * Stock received and not yet paid for.
 *
 * A supplier who delivers on account is paid next week, from the bank or
 * from cash. Recording the delivery as paid from somewhere would take money
 * out of a place it has not left yet; leaving it unrecorded keeps the stock
 * off the shelf. So Receive stock has a fourth answer to "paid from": not
 * yet. The books credit Accounts payable, and paying it later moves it from
 * there to the bank or the cash.
 *
 * Pure. Imports nothing at runtime. Reading and paying are in
 * owed-spends-store.ts.
 */

export interface OwedSpend {
  $id: string;
  $createdAt?: string;
  amount: number;
  payee?: string;
  supplier_id?: string;
  module?: string;
  approval_status?: string;
  pay_later?: boolean;
  paid_at?: string | null;
}

export type PayVia = 'bank' | 'cash';

export const PAY_VIA_WORDS: Record<PayVia, string> = {
  bank: 'From the bank',
  cash: 'From cash on hand',
};

/** Still owed: received on account, not refused, not yet paid. Oldest first. */
export function stillOwed<T extends OwedSpend>(rows: T[]): T[] {
  return rows
    .filter((r) => r.pay_later === true && !r.paid_at && r.approval_status !== 'rejected' && r.amount > 0)
    .sort((a, b) => (a.$createdAt ?? '').localeCompare(b.$createdAt ?? ''));
}

/** What is owed, per supplier as named on the spend, largest first. */
export function owedBySupplier(rows: OwedSpend[]): { payee: string; amount: number; count: number }[] {
  const by = new Map<string, { payee: string; amount: number; count: number }>();
  for (const r of stillOwed(rows)) {
    const payee = (r.payee ?? '').trim() || 'A supplier';
    const cur = by.get(payee) ?? { payee, amount: 0, count: 0 };
    cur.amount += r.amount;
    cur.count += 1;
    by.set(payee, cur);
  }
  return [...by.values()].sort((a, b) => b.amount - a.amount || a.payee.localeCompare(b.payee));
}

/** Why a payment cannot be recorded, or null when it can. */
export function payProblem(spend: OwedSpend | null, via: string): string | null {
  if (!spend) return 'Pick what is being paid.';
  if (spend.paid_at) return 'That has already been paid.';
  if (spend.approval_status === 'rejected') return 'That spend was refused, so there is nothing to pay.';
  if (via !== 'bank' && via !== 'cash') return 'Say where the money came from.';
  return null;
}
