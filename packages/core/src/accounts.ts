/**
 * The accounts the system itself posts to, by number.
 *
 * Moved out of ledger.ts so the rules that decide WHERE money lands can be
 * checked without a database: that file opens a connection on import, and a
 * posting rule tested only through it is a posting rule tested rarely.
 *
 * Pure. Imports nothing at runtime.
 */
import type { Module } from './access';

/** Account codes seeded by provisioning. Kept here so postings read plainly. */
export const ACCOUNTS = {
  cash: '1000',
  cardClearing: '1010',
  momoClearing: '1020',
  /**
   * Money that has left the safe but has not yet been spent.
   *
   * Its own asset account rather than part of Cash on hand. A petty cash box
   * is somebody else's responsibility and is counted on its own schedule, and
   * folding it into the till's cash makes a shortage in the box and a shortage
   * in the drawer the same number — which is to say neither can be found.
   */
  pettyCash: '1030',
  /**
   * The business's bank account.
   *
   * Where card and mobile-money takings end up once the provider settles,
   * where a maker paid by transfer is paid from, and where tax is remitted
   * from. It did not exist, which is why the clearing accounts above only
   * ever went up.
   */
  bank: '1040',
  /**
   * Stock owned but not yet sold, one account per trade.
   *
   * Buying stock is not spending: the money turns into something the business
   * still has, which is why it sits on the balance sheet until the thing is
   * sold. One shared account answered "what stock do we own" and nothing else
   * — and a bar's stock and a kitchen's larder move at completely different
   * speeds, so a single figure hid whichever of them was drifting.
   */
  inventory: '1200',
  barInventory: '1210',
  craftInventory: '1220',
  taxPayable: '2100',
  tipsPayable: '2200',
  /**
   * What the craft shop holds for its makers.
   *
   * A consigned piece is not the shop's: when it sells, the maker's share of
   * the money is theirs from that moment and the shop is holding it. Crediting
   * the whole sale to Craft shop sales overstated the shop's income by every
   * maker's share and left the payouts with nowhere to go, so the money paid
   * to makers was invisible in the books.
   */
  owedToMakers: '2400',
  /**
   * Sales and cost of sales, one pair per side of the business.
   *
   * A single "Food sales" line answers what the business took and nothing
   * else. The question an owner running three trades actually asks is which of
   * them is making money, and that cannot be recovered afterwards from one
   * merged figure — a restaurant, a bar and a craft shop have completely
   * different margins, and added together they describe none of them.
   *
   * A shift belongs to exactly one side, so the side is known at the moment
   * the entry is written and nothing has to be apportioned later.
   */
  foodSales: '4000',
  barSales: '4010',
  craftSales: '4020',
  discountsGiven: '4900',
  cogs: '5000',
  barCogs: '5010',
  craftCogs: '5020',
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
 * added to or retired. These are named in code, a shift close writes to them
 * by number, so deleting one would not produce an error message, it would
 * produce a shift that fails to balance at eleven at night.
 *
 * Derived from ACCOUNTS rather than listed again, so the protected set cannot
 * drift away from the set actually in use.
 */
export const SYSTEM_ACCOUNT_CODES: readonly string[] = Object.values(ACCOUNTS);

/**
 * Which sales account a side of the business credits.
 *
 * Kept beside the codes rather than at the call site, because posting a shift
 * and reading the reports back must not be able to answer it differently.
 */
export function salesAccount(module: Module): string {
  if (module === 'bar') return ACCOUNTS.barSales;
  if (module === 'craft') return ACCOUNTS.craftSales;
  return ACCOUNTS.foodSales;
}

/** And which cost-of-sales account it debits. */
export function cogsAccount(module: Module): string {
  if (module === 'bar') return ACCOUNTS.barCogs;
  if (module === 'craft') return ACCOUNTS.craftCogs;
  return ACCOUNTS.cogs;
}

/**
 * Where a side's unsold stock sits.
 *
 * The pair to cogsAccount: buying debits this, selling credits it and debits
 * the cost of sales. Getting the two out of step is how inventory grows for
 * ever on one trade while another shows a cost of goods nobody bought.
 */
export function inventoryAccount(module: Module): string {
  if (module === 'bar') return ACCOUNTS.barInventory;
  if (module === 'craft') return ACCOUNTS.craftInventory;
  return ACCOUNTS.inventory;
}

/** Every stock account, for a balance sheet that lists them together. */
export const INVENTORY_ACCOUNTS: readonly string[] = [
  ACCOUNTS.inventory, ACCOUNTS.barInventory, ACCOUNTS.craftInventory,
];

/** Every cost-of-sales account, for the reports' Costs total. */
export const COGS_ACCOUNTS: readonly string[] = [ACCOUNTS.cogs, ACCOUNTS.barCogs, ACCOUNTS.craftCogs];

/** Every sales account, for revenue totals. */
export const SALES_ACCOUNTS: readonly string[] = [ACCOUNTS.foodSales, ACCOUNTS.barSales, ACCOUNTS.craftSales];

export const isSystemAccount = (code: string): boolean => SYSTEM_ACCOUNT_CODES.includes(code);

/**
 * Where the money for a maker's payout comes from.
 *
 * Cash is the drawer. A mobile-money payout is sent from the wallet that holds
 * mobile-money takings, which is what the clearing account is until the
 * provider settles it to the bank. Anything else is the bank.
 */
export function payoutAccount(method: 'cash' | 'momo' | 'bank' | 'other' | string | undefined): string {
  if (method === 'cash') return ACCOUNTS.cash;
  if (method === 'momo') return ACCOUNTS.momoClearing;
  return ACCOUNTS.bank;
}

/**
 * Accounts an expense category may be pointed at.
 *
 * Expense lines only: money going out lands on an expense account, and
 * offering "Food sales" as a destination for a gas refill is offering a way to
 * make the books wrong. Cost of goods sold and cash over/short are left out
 * too: both are posted automatically at shift close from the stock count and
 * the drawer count, and an expense filed there would be double-counted.
 *
 * The inventory accounts are left out as well, now. A category used to be the
 * only way a delivery could reach the balance sheet, so "Bar stock" pointed
 * at it. Stock now reaches inventory from the LINES of a spend — see
 * spendDebits — and a category pointing there would charge the shelf twice.
 */
export const isPostableExpenseAccount = (a: { code: string; type: string }): boolean => {
  if (COGS_ACCOUNTS.includes(a.code) || a.code === ACCOUNTS.cashOverShort) return false;
  if (INVENTORY_ACCOUNTS.includes(a.code)) return false;
  return a.type === 'expense';
};
