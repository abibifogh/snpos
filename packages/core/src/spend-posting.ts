/**
 * What a spend puts on the books, worked out from what was bought.
 *
 * THE LINES DECIDE, NOT THE CATEGORY. A market run used to land wherever the
 * cashier's dropdown happened to be: filed under "Supplies" it was charged to
 * expenses the day it was bought, and then charged AGAIN as cost of sales
 * when the shift closed and the recipes worked out what had been used. Filed
 * under "Kitchen stock" it was right. Which of the two happened depended on a
 * list somebody picked from at nine at night, and the balance sheet's stock
 * line drifted negative every time the guess was wrong.
 *
 * So a line that went onto a shelf is stock, and goes to that side's
 * inventory. A line that did not — a taxi, a gas refill, the part of the total
 * that was never itemised — is spent the moment it is bought, and goes to the
 * category's account. The category only ever answers for what the lines do
 * not.
 *
 * Pure. Imports nothing at runtime.
 */

export interface SpendLine {
  /** Whether it went onto a shelf that gets counted. */
  stocked: boolean;
  /** What was actually paid for this line, minor units. */
  lineTotal: number;
}

export interface SpendDebit {
  account_code: string;
  amount: number;
  memo: string;
}

export interface SpendDebitsInput {
  /** The whole amount that left the drawer, box or bank. */
  amount: number;
  lines: SpendLine[];
  /** This side's inventory account. See inventoryAccount. */
  stockAccount: string;
  /** Where the category points. See accountForExpense. */
  categoryAccount: string;
  /**
   * The account for anything the lines do not explain when the category is
   * itself a stock account — an old "Bar stock" row, say. Money that was not
   * itemised is not on any shelf, so it cannot go to inventory; it is spent.
   */
  fallbackAccount: string;
  /** Every stock account, so a category pointing at one can be recognised. */
  stockAccounts: readonly string[];
}

/**
 * The debit side of a spend. The credit is the caller's — a drawer, a box or
 * the bank — and is always the whole amount.
 *
 * Stock first, then whatever is left. The remainder is worked out from the
 * amount rather than added up from overhead lines, so a total that was typed
 * larger than its lines still balances: the difference is money that left,
 * and it lands on the category rather than vanishing.
 */
export function spendDebits(input: SpendDebitsInput): SpendDebit[] {
  const amount = Math.max(0, Math.round(input.amount));
  if (amount === 0) return [];

  const stocked = input.lines
    .filter((l) => l.stocked)
    .reduce((sum, l) => sum + Math.max(0, Math.round(l.lineTotal)), 0);
  // A shelf cannot have received more than was paid. A line typed dearer than
  // the total is a typing mistake, and the books take the total as the truth.
  const toStock = Math.min(stocked, amount);
  const remainder = amount - toStock;

  const overheadAccount = input.stockAccounts.includes(input.categoryAccount)
    ? input.fallbackAccount
    : input.categoryAccount;

  const debits: SpendDebit[] = [];
  if (toStock > 0) debits.push({ account_code: input.stockAccount, amount: toStock, memo: 'Stock bought' });
  if (remainder > 0) {
    debits.push({
      account_code: overheadAccount,
      amount: remainder,
      memo: toStock > 0 ? 'Not on a shelf' : 'Money paid out',
    });
  }
  return debits;
}

/** The lines of a posting, ready for postEntry: the debits and one credit. */
export function spendPostingLines(
  debits: SpendDebit[],
  fromAccount: string,
): { account_code: string; debit: number; credit: number; memo?: string }[] {
  const total = debits.reduce((s, d) => s + d.amount, 0);
  if (total === 0) return [];
  return [
    ...debits.map((d) => ({ account_code: d.account_code, debit: d.amount, credit: 0, memo: d.memo })),
    { account_code: fromAccount, debit: 0, credit: total },
  ];
}

/**
 * Do two sets of debits say the same thing?
 *
 * Order-blind and memo-blind: a posting is the same posting whether the stock
 * line was written first or second, and a reworded memo is not a correction.
 */
export function sameDebits(a: SpendDebit[], b: SpendDebit[]): boolean {
  const key = (xs: SpendDebit[]) =>
    xs.filter((d) => d.amount > 0).map((d) => `${d.account_code}:${d.amount}`).sort().join('|');
  return key(a) === key(b);
}
