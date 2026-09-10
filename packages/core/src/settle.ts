/**
 * Settling up: the entries that clear what a shift close leaves hanging.
 *
 * Every close debits card and mobile-money takings to a CLEARING account,
 * credits tips to TIPS OWED and tax to TAX COLLECTED — and until now nothing
 * ever moved any of them again. The provider paid the money into the bank,
 * the staff were handed their tips, the tax was remitted, and the books kept
 * saying all three were still outstanding. Balances that only ever go up are
 * balances nobody can reconcile.
 *
 * Three entries, one shape each. Pure, so the arithmetic can be checked
 * without a database; the posting lives in ledger.ts.
 */

export interface PostingLineShape {
  account_code: string;
  debit: number;
  credit: number;
  memo?: string;
}

export interface SettlementInput {
  /** What the provider actually paid into the bank. */
  received: number;
  /** What the provider kept. Zero when they charge nothing, or bill separately. */
  fee: number;
  clearingAccount: string;
  bankAccount: string;
  feesAccount: string;
}

/**
 * A card or mobile-money settlement.
 *
 * What was cleared is what the customers paid: the money that reached the
 * bank PLUS the fee the provider kept. Crediting clearing by only what
 * arrived leaves the fee sitting there for ever, which is precisely the
 * residue a reconciliation cannot explain.
 */
export function settlementLines(input: SettlementInput): PostingLineShape[] {
  const received = Math.max(0, Math.round(input.received));
  const fee = Math.max(0, Math.round(input.fee));
  const cleared = received + fee;
  if (cleared === 0) return [];
  const lines: PostingLineShape[] = [
    { account_code: input.bankAccount, debit: received, credit: 0, memo: 'Settled to the bank' },
  ];
  if (fee > 0) lines.push({ account_code: input.feesAccount, debit: fee, credit: 0, memo: 'Provider fee' });
  lines.push({ account_code: input.clearingAccount, debit: 0, credit: cleared, memo: 'Cleared' });
  return lines.filter((l) => l.debit > 0 || l.credit > 0);
}

/** Tips handed to staff, out of the drawer. */
export function tipsPaidLines(amount: number, tipsAccount: string, fromAccount: string): PostingLineShape[] {
  const n = Math.max(0, Math.round(amount));
  if (n === 0) return [];
  return [
    { account_code: tipsAccount, debit: n, credit: 0, memo: 'Tips paid to staff' },
    { account_code: fromAccount, debit: 0, credit: n, memo: 'Tips paid out' },
  ];
}

/** Tax remitted to the authority, from the bank. */
export function taxRemittedLines(amount: number, taxAccount: string, fromAccount: string): PostingLineShape[] {
  const n = Math.max(0, Math.round(amount));
  if (n === 0) return [];
  return [
    { account_code: taxAccount, debit: n, credit: 0, memo: 'Tax remitted' },
    { account_code: fromAccount, debit: 0, credit: n, memo: 'Paid to the revenue authority' },
  ];
}

/**
 * Why a settlement cannot be posted, or nothing.
 *
 * Refused rather than warned about: a settlement larger than the balance it
 * clears would leave clearing NEGATIVE, which reads on a balance sheet as the
 * provider owing the business money it never took.
 */
export function settlementProblem(input: { received: number; fee: number; outstanding: number }): string | null {
  const received = Math.round(input.received);
  const fee = Math.round(input.fee);
  if (!Number.isFinite(received) || received < 0) return 'Enter what the provider paid into the bank.';
  if (!Number.isFinite(fee) || fee < 0) return 'A fee cannot be less than nothing.';
  if (received + fee === 0) return 'Enter what the provider paid into the bank.';
  if (received + fee > input.outstanding) {
    return 'That is more than is waiting to be settled. Check the amount, or post the difference as a journal entry.';
  }
  return null;
}

/** The same rule for paying down a liability: never past what is owed. */
export function paydownProblem(amount: number, owed: number, what: string): string | null {
  const n = Math.round(amount);
  if (!Number.isFinite(n) || n <= 0) return `Enter how much ${what} was paid.`;
  if (n > owed) return `That is more ${what} than is owed. Check the amount.`;
  return null;
}
