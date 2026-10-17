/**
 * More than one bank account, and the MoMo merchant wallet as an account.
 *
 * The books had one bank account, 1040. A business with two banks, or MoMo
 * paid into a wallet it draws from, had to fold them together, and nothing
 * could be reconciled against either statement. Each is now an asset
 * account of its own, marked with what kind of money it holds, numbered
 * after the bank account (1041, 1042…), and money moves between them by a
 * transfer.
 *
 * Pure. Imports nothing at runtime. Written in banks-store.ts.
 */
import type { AccountRow } from './ledger-math';

export type MoneyAccountKind = 'bank' | 'momo' | 'cash';

export const MONEY_KIND_WORDS: Record<MoneyAccountKind, string> = {
  bank: 'Bank account',
  momo: 'MoMo wallet',
  cash: 'Cash',
};

/** What kind of money an account holds: its own mark, or the system's three. */
export function moneyKindOf(a: Pick<AccountRow, 'code' | 'cash_kind'>): MoneyAccountKind | null {
  if (a.cash_kind === 'bank' || a.cash_kind === 'momo' || a.cash_kind === 'cash') return a.cash_kind;
  if (a.code === '1040') return 'bank';
  if (a.code === '1000' || a.code === '1030') return 'cash';
  return null;
}

/** The next free number after the bank account, before what customers owe (1100). */
export function nextMoneyCode(accounts: Pick<AccountRow, 'code'>[]): string | null {
  const used = new Set(accounts.map((a) => a.code));
  for (let n = 1041; n <= 1099; n++) if (!used.has(String(n))) return String(n);
  return null;
}

/** Why a new money account cannot be added, or null when it can. */
export function newMoneyAccountProblem(name: string, accounts: Pick<AccountRow, 'code' | 'name'>[]): string | null {
  const n = name.trim().toLowerCase();
  if (!n) return 'Give it a name, like the bank and the last four digits.';
  if (accounts.some((a) => a.name.trim().toLowerCase() === n)) return 'There is already an account called that.';
  if (!nextMoneyCode(accounts)) return 'There is no free account number left between 1041 and 1099.';
  return null;
}

/** Why a transfer cannot be posted, or null when it can. */
export function moneyTransferProblem(from: string, to: string, amount: number): string | null {
  if (!from || !to) return 'Choose where the money came from and where it went.';
  if (from === to) return 'The two accounts are the same.';
  if (!(amount > 0)) return 'Enter the amount moved.';
  return null;
}

/** A transfer as journal lines: into one account, out of the other. */
export const transferLines = (from: string, to: string, amount: number, note = '') => [
  { account_code: to, debit: amount, credit: 0, memo: note || 'Transfer in' },
  { account_code: from, debit: 0, credit: amount, memo: note || 'Transfer out' },
];
