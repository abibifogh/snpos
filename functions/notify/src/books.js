/**
 * What each event puts on the books, as lines. The server's copy.
 *
 * An Appwrite function cannot import the browser bundle, so the arithmetic
 * that decides where money lands is written twice: once in packages/core
 * (accounts.ts, books.ts, spend-posting.ts, pricing.ts, consignment-math.ts)
 * and once here. Two copies drift, so a parity test in core runs both over
 * the same inputs and fails the build the moment they disagree. Nothing in
 * this file reads a database; books-post.js does that.
 */

/* ------------------------------------------------------------ the chart */

/** Mirrors ACCOUNTS in packages/core/src/accounts.ts. */
export const ACCOUNTS = {
  cash: '1000',
  cardClearing: '1010',
  momoClearing: '1020',
  pettyCash: '1030',
  bank: '1040',
  inventory: '1200',
  barInventory: '1210',
  craftInventory: '1220',
  taxPayable: '2100',
  nhilPayable: '2110',
  getfundPayable: '2120',
  tourismPayable: '2130',
  otherLeviesPayable: '2190',
  tipsPayable: '2200',
  owedToMakers: '2400',
  foodSales: '4000',
  barSales: '4010',
  craftSales: '4020',
  discountsGiven: '4900',
  cogs: '5000',
  barCogs: '5010',
  craftCogs: '5020',
  cashOverShort: '7000',
  providerFees: '6070',
  waste: '6080',
  equipment: '1500',
  accumDepreciation: '1510',
  depreciation: '6060',
};

/** Other expenses: where a spend lands when its category points nowhere useful. */
export const UNCATEGORISED = '6090';

export const salesAccount = (module) =>
  module === 'bar' ? ACCOUNTS.barSales : module === 'craft' ? ACCOUNTS.craftSales : ACCOUNTS.foodSales;
export const cogsAccount = (module) =>
  module === 'bar' ? ACCOUNTS.barCogs : module === 'craft' ? ACCOUNTS.craftCogs : ACCOUNTS.cogs;
export const inventoryAccount = (module) =>
  module === 'bar' ? ACCOUNTS.barInventory : module === 'craft' ? ACCOUNTS.craftInventory : ACCOUNTS.inventory;
export const INVENTORY_ACCOUNTS = [ACCOUNTS.inventory, ACCOUNTS.barInventory, ACCOUNTS.craftInventory];
export const payoutAccount = (method) =>
  method === 'cash' ? ACCOUNTS.cash : method === 'momo' ? ACCOUNTS.momoClearing : ACCOUNTS.bank;

const SIDE_WORDS = { kitchen: 'Bistro', bar: 'Bar', craft: 'Craft shop' };

/* ---------------------------------------------------------- shift close */

/** Mirrors shiftEntries in packages/core/src/books.ts. */
export function shiftEntries(p) {
  const module = p.module || 'kitchen';
  const side = SIDE_WORDS[module] || SIDE_WORDS.kitchen;
  const entries = [];

  const gross = p.takings.cash + p.takings.card + p.takings.mobile_money + p.takings.other;
  if (gross > 0 || p.discounts > 0) {
    const netRevenue = gross - p.tax - p.tips;
    const makersShare = Math.max(0, Math.min(p.makersShare || 0, netRevenue + p.discounts));
    const lines = [
      { account_code: ACCOUNTS.cash, debit: p.takings.cash, credit: 0, memo: 'Cash taken' },
      { account_code: ACCOUNTS.cardClearing, debit: p.takings.card, credit: 0, memo: 'Card taken' },
      { account_code: ACCOUNTS.momoClearing, debit: p.takings.mobile_money, credit: 0, memo: 'Mobile money taken' },
      { account_code: ACCOUNTS.discountsGiven, debit: p.discounts, credit: 0, memo: 'Discounts given' },
      { account_code: salesAccount(module), debit: 0, credit: netRevenue + p.discounts - makersShare, memo: `${side} sales` },
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

/** Mirrors takingsByKind in packages/core/src/books.ts. */
export function takingsByKind(payments, methods) {
  const byKind = { cash: 0, card: 0, mobile_money: 0, other: 0 };
  for (const p of payments) {
    if (p.status === 'voided' || p.status === 'refunded') continue;
    const kind = methods.find((m) => m.$id === p.method_id)?.kind ?? 'other';
    byKind[kind in byKind ? kind : 'other'] += p.amount || 0;
  }
  return byKind;
}

/** Mirrors cashVarianceOf in packages/core/src/books.ts. */
export function cashVarianceOf(countedJson, expectedJson) {
  let counted;
  let expected;
  try {
    counted = JSON.parse(countedJson || '{}');
    expected = JSON.parse(expectedJson || '{}');
  } catch {
    return 0;
  }
  if (!counted || typeof counted !== 'object' || !expected || typeof expected !== 'object') return 0;
  return Object.keys(counted).reduce((a, k) => a + ((Number(counted[k]) || 0) - (Number(expected[k]) || 0)), 0);
}

/* ------------------------------------------------------- payouts, waste */

/** Mirrors payoutLines in packages/core/src/books.ts. */
export function payoutLines(payout) {
  if (!(payout.amount > 0)) return [];
  return [
    { account_code: ACCOUNTS.owedToMakers, debit: payout.amount, credit: 0, memo: 'Owed to makers, paid' },
    { account_code: payoutAccount(payout.method), debit: 0, credit: payout.amount, memo: 'Paid out' },
  ];
}

/** Mirrors wasteLines in packages/core/src/books.ts. */
export function wasteLines(w) {
  if (!(w.value > 0)) return [];
  return [
    { account_code: ACCOUNTS.waste, debit: w.value, credit: 0, memo: 'Waste and spoilage' },
    { account_code: inventoryAccount(w.module || 'kitchen'), debit: 0, credit: w.value, memo: 'Off the shelf' },
  ];
}

/* --------------------------------------------------------------- spends */

/** Mirrors spendDebits in packages/core/src/spend-posting.ts. */
export function spendDebits(input) {
  const amount = Math.max(0, Math.round(input.amount));
  if (amount === 0) return [];

  const stocked = input.lines
    .filter((l) => l.stocked)
    .reduce((sum, l) => sum + Math.max(0, Math.round(l.lineTotal)), 0);
  const toStock = Math.min(stocked, amount);
  const remainder = amount - toStock;

  const overheadAccount = input.stockAccounts.includes(input.categoryAccount)
    ? input.fallbackAccount
    : input.categoryAccount;

  const debits = [];
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

/** Mirrors spendPostingLines in packages/core/src/spend-posting.ts. */
export function spendPostingLines(debits, fromAccount) {
  const total = debits.reduce((s, d) => s + d.amount, 0);
  if (total === 0) return [];
  return [
    ...debits.map((d) => ({ account_code: d.account_code, debit: d.amount, credit: 0, memo: d.memo })),
    { account_code: fromAccount, debit: 0, credit: total },
  ];
}

/** Mirrors sameDebits in packages/core/src/spend-posting.ts. */
export function sameDebits(a, b) {
  const key = (xs) => xs.filter((d) => d.amount > 0).map((d) => `${d.account_code}:${d.amount}`).sort().join('|');
  return key(a) === key(b);
}

/**
 * What one spend is charged to, from its row, its lines and its category.
 * Mirrors debitsForExpense in packages/core/src/ledger.ts, given the
 * category's account instead of looking it up.
 */
export function debitsForSpend(e, items, categoryAccount) {
  return spendDebits({
    amount: e.amount,
    lines: items.map((i) => ({ stocked: i.stocked !== false, lineTotal: i.line_total || 0 })),
    stockAccount: inventoryAccount(e.module || 'kitchen'),
    categoryAccount: categoryAccount || UNCATEGORISED,
    fallbackAccount: UNCATEGORISED,
    stockAccounts: INVENTORY_ACCOUNTS,
  });
}

/* ------------------------------------------------------------------ tax */

/** Mirrors parseLevies in packages/core/src/pricing.ts. */
export function parseLevies(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((l) => !!l && typeof l === 'object' && typeof l.key === 'string')
      .map((l) => ({
        key: String(l.key).trim(),
        name: String(l.name ?? l.key).trim(),
        rate_bp: Math.max(0, Math.round(Number(l.rate_bp) || 0)),
      }))
      .filter((l) => l.key !== '' && l.rate_bp > 0);
  } catch {
    return [];
  }
}

const LEVY_ACCOUNTS = {
  vat: ACCOUNTS.taxPayable,
  nhil: ACCOUNTS.nhilPayable,
  getfund: ACCOUNTS.getfundPayable,
  tourism: ACCOUNTS.tourismPayable,
};

/** Mirrors levyAccount in packages/core/src/pricing.ts. */
export const levyAccount = (key) => LEVY_ACCOUNTS[key] || ACCOUNTS.otherLeviesPayable;

/** Mirrors splitTax in packages/core/src/pricing.ts. */
export function splitTax(taxTotal, input) {
  const total = Math.max(0, Math.round(taxTotal));
  if (total === 0) return [];
  const levies = input.levies.filter((l) => l.rate_bp > 0);
  const leviesBp = levies.reduce((s, l) => s + l.rate_bp, 0);
  const vatBp = Math.max(0, Math.round(input.vatBp || 0));
  const stack = leviesBp / 10000 + (1 + leviesBp / 10000) * (vatBp / 10000);
  if (stack === 0) return [{ key: 'vat', name: 'VAT', amount: total, account_code: LEVY_ACCOUNTS.vat }];
  const base = total / stack;
  const parts = [];
  let given = 0;
  for (const l of levies) {
    const amount = Math.round((base * l.rate_bp) / 10000);
    if (amount > 0) parts.push({ key: l.key, name: l.name, amount, account_code: levyAccount(l.key) });
    given += amount;
  }
  const vat = total - given;
  if (vat > 0 || parts.length === 0) parts.push({ key: 'vat', name: 'VAT', amount: vat, account_code: LEVY_ACCOUNTS.vat });
  return parts;
}

/* --------------------------------------------------------------- makers */

/** Mirrors rateFor in packages/core/src/consignment-math.ts. */
export function rateFor(line, consignor, settings) {
  const candidates = [line?.commission_bp, consignor?.commission_bp, settings?.default_commission_bp];
  for (const bp of candidates) {
    if (typeof bp === 'number' && Number.isFinite(bp) && bp >= 0) return bp;
  }
  return 3000;
}

/** Mirrors flatFor in packages/core/src/consignment-math.ts. */
export function flatFor(line, consignor) {
  const candidates = [line?.commission_flat, consignor?.commission_flat];
  for (const amount of candidates) {
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) return Math.round(amount);
  }
  return 0;
}

/** Mirrors splitSale in packages/core/src/consignment-math.ts. */
export function splitSale(gross, commissionBp, flatPerUnit = 0, qty = 1) {
  const bp = Math.max(0, Math.min(10000, Math.round(commissionBp)));
  const commission = flatPerUnit > 0
    ? Math.min(Math.max(0, gross), Math.round(flatPerUnit) * Math.max(1, Math.round(qty)))
    : Math.round((gross * bp) / 10000);
  return {
    gross,
    commission,
    consignor: gross - commission,
    bp: flatPerUnit > 0 ? (gross > 0 ? Math.round((commission / gross) * 10000) : 0) : bp,
    flat: flatPerUnit > 0 ? Math.round(flatPerUnit) : 0,
  };
}

/** Mirrors makersShareOf in packages/core/src/consignment-math.ts. */
export function makersShareOf(lines, consignors, settings) {
  let share = 0;
  for (const line of lines) {
    if (!line.consignor_id) continue;
    const maker = consignors.find((c) => c.$id === line.consignor_id) ?? null;
    const split = splitSale(line.line_total || 0, rateFor(line, maker, settings), flatFor(line, maker), line.qty || 1);
    share += split.consignor;
  }
  return share;
}

/* ---------------------------------------------------------------- locks */

/** Mirrors isLocked in packages/core/src/ledger-math.ts. */
export function isLocked(date, lockedThrough) {
  if (!lockedThrough) return false;
  const d = (date ?? '').slice(0, 10);
  const through = lockedThrough.slice(0, 10);
  return d !== '' && d <= through;
}
