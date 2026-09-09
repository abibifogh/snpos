/**
 * What each event puts on the books, as lines.
 *
 * A shift closing, a maker being paid, stock written off: each is an event
 * somewhere else in the system, and each has exactly one right set of journal
 * lines. Those lines used to be worked out inside the functions that wrote
 * them, in the browser, which meant a till that lost its connection between
 * writing the shift and writing the books left the month short by a night
 * and nothing said so.
 *
 * The lines are worked out here, with nothing else in the way, so the server
 * job that now writes them (functions/notify/src/books.js carries a copy) and
 * the admin corrections that still run in the browser cannot disagree. A
 * parity test holds the copy to this file.
 *
 * Pure. Imports nothing at runtime.
 */
import type { Module } from './access';

/**
 * The account numbers these lines use.
 *
 * A copy of the relevant part of ACCOUNTS in accounts.ts, because this file
 * must import nothing at runtime to stay testable without a bundler. The
 * test in books.test.ts holds the copy to the chart.
 */
export const BOOK_ACCOUNTS = {
  cash: '1000',
  cardClearing: '1010',
  momoClearing: '1020',
  bank: '1040',
  inventory: '1200',
  barInventory: '1210',
  craftInventory: '1220',
  taxPayable: '2100',
  tipsPayable: '2200',
  owedToMakers: '2400',
  foodSales: '4000',
  barSales: '4010',
  craftSales: '4020',
  discountsGiven: '4900',
  cogs: '5000',
  barCogs: '5010',
  craftCogs: '5020',
  waste: '6080',
  cashOverShort: '7000',
} as const;
const ACCOUNTS = BOOK_ACCOUNTS;

const salesAccount = (module: Module): string =>
  module === 'bar' ? ACCOUNTS.barSales : module === 'craft' ? ACCOUNTS.craftSales : ACCOUNTS.foodSales;
const cogsAccount = (module: Module): string =>
  module === 'bar' ? ACCOUNTS.barCogs : module === 'craft' ? ACCOUNTS.craftCogs : ACCOUNTS.cogs;
const inventoryAccount = (module: Module): string =>
  module === 'bar' ? ACCOUNTS.barInventory : module === 'craft' ? ACCOUNTS.craftInventory : ACCOUNTS.inventory;
const payoutAccount = (method: string | undefined): string =>
  method === 'cash' ? ACCOUNTS.cash : method === 'momo' ? ACCOUNTS.momoClearing : ACCOUNTS.bank;

export interface BookLine {
  account_code: string;
  debit: number;
  credit: number;
  memo?: string;
}

/** One entry to post: its memo and its lines. */
export interface BookEntry {
  memo: string;
  lines: BookLine[];
}

const SIDE_WORDS: Record<string, string> = { kitchen: 'Bistro', bar: 'Bar', craft: 'Craft shop' };

export interface ShiftFigures {
  takings: { cash: number; card: number; mobile_money: number; other: number };
  tips: number;
  tax: number;
  taxParts?: { account_code: string; amount: number; name: string }[];
  discounts: number;
  cogs: number;
  cashVariance: number;
  module?: Module | string;
  makersShare?: number;
}

/**
 * The entries a closed shift makes: its sales, the cost of what it sold, and
 * the drawer being over or short. Separate entries rather than one, so a
 * wrong figure can be traced and reversed on its own.
 *
 * Expenses are not here. Each posts by its own id from its own row, so a
 * spend recorded outside a shift lands the same way as one recorded on it.
 */
export function shiftEntries(p: ShiftFigures): BookEntry[] {
  const module = (p.module ?? 'kitchen') as Module;
  const side = SIDE_WORDS[module] ?? SIDE_WORDS.kitchen;
  const entries: BookEntry[] = [];

  const gross = p.takings.cash + p.takings.card + p.takings.mobile_money + p.takings.other;
  if (gross > 0 || p.discounts > 0) {
    const netRevenue = gross - p.tax - p.tips;
    // Never more than the sales it came out of: a rounding quirk or a line
    // refunded after its maker was credited must not turn sales negative.
    const makersShare = Math.max(0, Math.min(p.makersShare ?? 0, netRevenue + p.discounts));
    const lines: BookLine[] = [
      { account_code: ACCOUNTS.cash, debit: p.takings.cash, credit: 0, memo: 'Cash taken' },
      { account_code: ACCOUNTS.cardClearing, debit: p.takings.card, credit: 0, memo: 'Card taken' },
      { account_code: ACCOUNTS.momoClearing, debit: p.takings.mobile_money, credit: 0, memo: 'Mobile money taken' },
      // Discounts are recorded as a debit rather than netted off sales, so
      // "how much did we give away" stays an answerable question.
      { account_code: ACCOUNTS.discountsGiven, debit: p.discounts, credit: 0, memo: 'Discounts given' },
      { account_code: salesAccount(module), debit: 0, credit: netRevenue + p.discounts - makersShare, memo: `${side} sales` },
      // The makers' part of a craft shift is held for them, not earned.
      { account_code: ACCOUNTS.owedToMakers, debit: 0, credit: makersShare, memo: 'Owed to makers' },
      ...(p.taxParts && p.taxParts.length > 0
        ? p.taxParts.map((t) => ({ account_code: t.account_code, debit: 0, credit: t.amount, memo: `${t.name} collected` }))
        : [{ account_code: ACCOUNTS.taxPayable, debit: 0, credit: p.tax, memo: 'Tax collected' }]),
      { account_code: ACCOUNTS.tipsPayable, debit: 0, credit: p.tips, memo: 'Tips owed to staff' },
    ].filter((l) => l.debit !== 0 || l.credit !== 0);
    if (p.takings.other > 0) {
      lines.push({ account_code: ACCOUNTS.cash, debit: p.takings.other, credit: 0, memo: 'Other tender' });
    }
    entries.push({ memo: 'Shift sales', lines });
  }

  if (p.cogs > 0) {
    entries.push({
      memo: `Cost of ${side.toLowerCase()} goods sold`,
      lines: [
        { account_code: cogsAccount(module), debit: p.cogs, credit: 0 },
        // Off this side's own shelf. Crediting the shared account would write
        // a bar's pours off against the kitchen's larder.
        { account_code: inventoryAccount(module), debit: 0, credit: p.cogs },
      ],
    });
  }

  if (p.cashVariance !== 0) {
    const short = p.cashVariance < 0;
    const amount = Math.abs(p.cashVariance);
    entries.push({
      memo: short ? 'Cash short' : 'Cash over',
      lines: [
        { account_code: short ? ACCOUNTS.cashOverShort : ACCOUNTS.cash, debit: amount, credit: 0 },
        { account_code: short ? ACCOUNTS.cash : ACCOUNTS.cashOverShort, debit: 0, credit: amount },
      ],
    });
  }

  return entries;
}

/**
 * What a shift took, by the kind of money.
 *
 * Voided and refunded payments are not money. A method the list does not
 * know is "other", which is counted as cash on the books because it was
 * counted in the drawer.
 */
export function takingsByKind(
  payments: { method_id: string; amount: number; status?: string }[],
  methods: { $id: string; kind?: string }[],
): { cash: number; card: number; mobile_money: number; other: number } {
  const byKind = { cash: 0, card: 0, mobile_money: 0, other: 0 };
  for (const p of payments) {
    if (p.status === 'voided' || p.status === 'refunded') continue;
    const kind = methods.find((m) => m.$id === p.method_id)?.kind ?? 'other';
    byKind[(kind in byKind ? kind : 'other') as keyof typeof byKind] += p.amount || 0;
  }
  return byKind;
}

/**
 * The drawer over or short, from what was counted against what was expected.
 *
 * Both are JSON the shift row carries, per method. Text that cannot be read
 * is no variance: inventing a shortage against nothing is worse than none.
 */
export function cashVarianceOf(countedJson: string | undefined, expectedJson: string | undefined): number {
  let counted: Record<string, number>;
  let expected: Record<string, number>;
  try {
    counted = JSON.parse(countedJson || '{}');
    expected = JSON.parse(expectedJson || '{}');
  } catch {
    return 0;
  }
  if (!counted || typeof counted !== 'object' || !expected || typeof expected !== 'object') return 0;
  return Object.keys(counted).reduce((a, k) => a + ((Number(counted[k]) || 0) - (Number(expected[k]) || 0)), 0);
}

/** A maker paid: what the shop owed goes down, and the cash, wallet or bank with it. */
export function payoutLines(payout: { amount: number; method?: string }): BookLine[] {
  if (!(payout.amount > 0)) return [];
  return [
    { account_code: ACCOUNTS.owedToMakers, debit: payout.amount, credit: 0, memo: 'Owed to makers, paid' },
    { account_code: payoutAccount(payout.method), debit: 0, credit: payout.amount, memo: 'Paid out' },
  ];
}

/** Stock written off: a cost of the month, and the shelf is lighter. */
export function wasteLines(w: { value: number; module?: string }): BookLine[] {
  if (!(w.value > 0)) return [];
  return [
    { account_code: ACCOUNTS.waste, debit: w.value, credit: 0, memo: 'Waste and spoilage' },
    { account_code: inventoryAccount((w.module ?? 'kitchen') as Module), debit: 0, credit: w.value, memo: 'Off the shelf' },
  ];
}

/**
 * The key an event's entry carries, so it is posted once however many times
 * the event arrives. The browser's corrections look entries up by the same
 * keys, so the two sides find each other's work.
 */
export const BOOK_KEYS = {
  shift: (shiftId: string) => shiftId,
  expense: (expenseId: string) => `expense:${expenseId}`,
  payout: (payoutId: string) => `payout:${payoutId}`,
  waste: (wasteId: string) => `waste:${wasteId}`,
} as const;
