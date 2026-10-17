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
  /** Set when it is paid in full. */
  paid_at?: string | null;
  /** Paid so far: a bill can be paid in parts. */
  paid_amount?: number | null;
  /** When the supplier wants it by, as YYYY-MM-DD. None means on receipt. */
  due_on?: string | null;
}

/** What is still to pay on a bill. */
export const leftToPay = (r: Pick<OwedSpend, 'amount' | 'paid_amount' | 'paid_at'>): number =>
  r.paid_at ? 0 : Math.max(0, r.amount - (r.paid_amount ?? 0));

/** When it is due: its own date, or the day it was received. */
export const dueOf = (r: Pick<OwedSpend, 'due_on' | '$createdAt'>): string =>
  (r.due_on || r.$createdAt || '').slice(0, 10);

export type PayVia = 'bank' | 'cash';

export const PAY_VIA_WORDS: Record<PayVia, string> = {
  bank: 'From the bank',
  cash: 'From cash on hand',
};

/** Still owed: not paid yet, not refused, something left to pay. Soonest due first. */
export function stillOwed<T extends OwedSpend>(rows: T[]): T[] {
  return rows
    .filter((r) => r.pay_later === true && r.approval_status !== 'rejected' && leftToPay(r) > 0)
    .sort((a, b) => dueOf(a).localeCompare(dueOf(b)) || (a.$createdAt ?? '').localeCompare(b.$createdAt ?? ''));
}

/** What is owed, per supplier as named on the spend, largest first. */
export function owedBySupplier(rows: OwedSpend[]): { payee: string; amount: number; count: number }[] {
  const by = new Map<string, { payee: string; amount: number; count: number }>();
  for (const r of stillOwed(rows)) {
    const payee = (r.payee ?? '').trim() || 'A supplier';
    const cur = by.get(payee) ?? { payee, amount: 0, count: 0 };
    cur.amount += leftToPay(r);
    cur.count += 1;
    by.set(payee, cur);
  }
  return [...by.values()].sort((a, b) => b.amount - a.amount || a.payee.localeCompare(b.payee));
}

/** Why a payment cannot be recorded, or null when it can. Leave `amount` out to pay what is left. */
export function payProblem(spend: OwedSpend | null, via: string, amount?: number): string | null {
  if (!spend) return 'Pick what is being paid.';
  if (leftToPay(spend) <= 0) return 'That has already been paid.';
  if (spend.approval_status === 'rejected') return 'That spend was refused, so there is nothing to pay.';
  if (!via) return 'Say where the money came from.';
  if (amount !== undefined) {
    if (!(amount > 0)) return 'Enter the amount paid.';
    if (amount > leftToPay(spend)) return 'That is more than is left to pay.';
  }
  return null;
}
