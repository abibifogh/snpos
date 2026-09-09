import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftEntries, takingsByKind, cashVarianceOf, payoutLines, wasteLines, BOOK_KEYS, BOOK_ACCOUNTS,
} from '../books.ts';
import { ACCOUNTS, salesAccount, cogsAccount, inventoryAccount, payoutAccount } from '../accounts.ts';
import { spendDebits, spendPostingLines, sameDebits } from '../spend-posting.ts';
import { splitTax, parseLevies, levyAccount, GHANA_LEVIES, serialiseLevies } from '../pricing.ts';
import { makersShareOf, splitSale, rateFor, flatFor } from '../consignment-math.ts';
import { isLocked } from '../ledger-math.ts';
import * as server from '../../../../functions/notify/src/books.js';

const balanced = (lines: { debit: number; credit: number }[]) =>
  lines.reduce((s, l) => s + l.debit, 0) === lines.reduce((s, l) => s + l.credit, 0);
/** Net by account. Two lines can share one account (cash taken, other tender), so they are summed. */
const netBy = (lines: { account_code: string; debit: number; credit: number }[]) => {
  const out: Record<string, number> = {};
  for (const l of lines) out[l.account_code] = (out[l.account_code] ?? 0) + l.debit - l.credit;
  return out;
};

const night = {
  takings: { cash: 10_000, card: 5_000, mobile_money: 2_500, other: 500 },
  tips: 300, tax: 2_000, discounts: 400, cogs: 6_000, cashVariance: -150, module: 'kitchen',
};

test('a shift close is three balanced entries: sales, cost of sales, the drawer', () => {
  const entries = shiftEntries(night);
  assert.deepEqual(entries.map((e) => e.memo), ['Shift sales', 'Cost of bistro goods sold', 'Cash short']);
  for (const e of entries) assert.ok(balanced(e.lines), e.memo);
  const sales = netBy(entries[0].lines);
  // Other tender is counted as cash, so cash carries 10,000 + 500.
  assert.equal(sales['1000'], 10_500);
  assert.equal(sales['4000'], -(18_000 - 2_000 - 300 + 400));
  assert.equal(sales['4900'], 400);
  assert.equal(sales['2100'], -2_000);
  assert.equal(sales['2200'], -300);
});

test('nothing taken and nothing given away posts no sales entry; an exact drawer posts no variance', () => {
  const quiet = shiftEntries({ ...night, takings: { cash: 0, card: 0, mobile_money: 0, other: 0 }, discounts: 0, cogs: 0, cashVariance: 0 });
  assert.deepEqual(quiet, []);
  const over = shiftEntries({ ...night, cashVariance: 75 });
  assert.equal(over[2].memo, 'Cash over');
  assert.deepEqual(over[2].lines.map((l) => [l.account_code, l.debit, l.credit]), [['1000', 75, 0], ['7000', 0, 75]]);
});

test('a craft shift holds the makers’ share, never more than the sales it came from', () => {
  const craft = shiftEntries({ ...night, module: 'craft', makersShare: 9_000, cogs: 0 });
  const by = Object.fromEntries(craft[0].lines.map((l) => [l.account_code, l.debit - l.credit]));
  assert.equal(by['2400'], -9_000);
  assert.equal(by['4020'], -(18_000 - 2_000 - 300 + 400 - 9_000));
  const capped = shiftEntries({ ...night, module: 'craft', makersShare: 99_000 });
  const cap = Object.fromEntries(capped[0].lines.map((l) => [l.account_code, l.debit - l.credit]));
  assert.equal(cap['4020'], undefined);
  assert.equal(cap['2400'], -(18_000 - 2_000 - 300 + 400));
});

test('each levy goes to its own account when the parts are given', () => {
  const parts = splitTax(2_190, { vatBp: 1500, levies: [...GHANA_LEVIES] });
  const [sales] = shiftEntries({ ...night, tax: 2_190, taxParts: parts });
  const by = Object.fromEntries(sales.lines.map((l) => [l.account_code, l.debit - l.credit]));
  assert.equal(by['2110'], -250);
  assert.equal(by['2120'], -250);
  assert.equal(by['2130'], -100);
  assert.equal(by['2100'], -1_590);
  assert.equal(by['2100'] + by['2110'] + by['2120'] + by['2130'], -2_190);
});

test('takings by kind ignore voided and refunded payments, and an unknown method is other', () => {
  const methods = [{ $id: 'm1', kind: 'cash' }, { $id: 'm2', kind: 'card' }, { $id: 'm3', kind: 'mobile_money' }];
  const payments = [
    { method_id: 'm1', amount: 100 }, { method_id: 'm2', amount: 200, status: 'voided' },
    { method_id: 'm3', amount: 300 }, { method_id: 'gone', amount: 7 }, { method_id: 'm2', amount: 50, status: 'refunded' },
  ];
  assert.deepEqual(takingsByKind(payments, methods), { cash: 100, card: 0, mobile_money: 300, other: 7 });
});

test('the drawer variance is counted less expected, and unreadable text is no variance', () => {
  assert.equal(cashVarianceOf('{"m1":9900,"m2":500}', '{"m1":10000,"m2":500}'), -100);
  assert.equal(cashVarianceOf('{"m1":10100}', '{"m1":10000}'), 100);
  assert.equal(cashVarianceOf('not json', '{}'), 0);
  assert.equal(cashVarianceOf(undefined, undefined), 0);
  assert.equal(cashVarianceOf('[]', '{}'), 0);
});

test('a payout and a write-off each make one balanced pair', () => {
  assert.deepEqual(payoutLines({ amount: 1_400, method: 'momo' }).map((l) => [l.account_code, l.debit, l.credit]),
    [['2400', 1_400, 0], ['1020', 0, 1_400]]);
  assert.deepEqual(payoutLines({ amount: 0 }), []);
  assert.deepEqual(wasteLines({ value: 800, module: 'bar' }).map((l) => [l.account_code, l.debit, l.credit]),
    [['6080', 800, 0], ['1210', 0, 800]]);
  assert.deepEqual(wasteLines({ value: -5 }), []);
  assert.equal(BOOK_KEYS.expense('e1'), 'expense:e1');
  assert.equal(BOOK_KEYS.shift('sh1'), 'sh1');
});

/* ------------------------------------------------- the server's copy */

/**
 * The function that now writes the books cannot import this package, so it
 * carries a copy of every rule above. These run both over the same inputs.
 */

test('the chart of accounts is the same on both sides, and the books’ own copy matches it', () => {
  assert.deepEqual(server.ACCOUNTS, ACCOUNTS);
  for (const [k, v] of Object.entries(BOOK_ACCOUNTS)) assert.equal(v, (ACCOUNTS as Record<string, string>)[k], k);
  // And the side-to-account rules, through what they produce.
  for (const m of ['kitchen', 'bar', 'craft'] as const) {
    const [sales] = shiftEntries({ ...night, module: m, cogs: 100, cashVariance: 0 });
    assert.ok(sales.lines.some((l) => l.account_code === salesAccount(m)), m);
    const cost = shiftEntries({ ...night, module: m, cogs: 100 })[1];
    assert.deepEqual(cost.lines.map((l) => l.account_code), [cogsAccount(m), inventoryAccount(m)]);
    assert.equal(wasteLines({ value: 1, module: m })[1].account_code, inventoryAccount(m));
  }
  for (const method of ['cash', 'momo', 'bank', 'other', undefined]) {
    assert.equal(payoutLines({ amount: 1, method })[1].account_code, payoutAccount(method));
  }
});

test('a shift posts identically from the browser and the server', () => {
  const ghana = splitTax(2_190, { vatBp: 1500, levies: [...GHANA_LEVIES] });
  const cases = [
    night,
    { ...night, module: 'bar', cashVariance: 0 },
    { ...night, module: 'craft', makersShare: 9_000 },
    { ...night, module: 'craft', makersShare: 99_000, cogs: 0 },
    { ...night, tax: 2_190, taxParts: ghana },
    { ...night, takings: { cash: 0, card: 0, mobile_money: 0, other: 0 }, discounts: 0, cogs: 0, cashVariance: 0 },
    { ...night, takings: { cash: 0, card: 0, mobile_money: 0, other: 0 }, discounts: 200 },
    { ...night, cashVariance: 75, module: undefined },
  ];
  for (const c of cases) {
    assert.deepEqual(server.shiftEntries(c), shiftEntries(c), JSON.stringify(c));
  }
});

test('takings, variance, payouts and write-offs agree', () => {
  const methods = [{ $id: 'm1', kind: 'cash' }, { $id: 'm2', kind: 'card' }];
  const payments = [{ method_id: 'm1', amount: 100 }, { method_id: 'm2', amount: 200, status: 'voided' }, { method_id: 'x', amount: 3 }];
  assert.deepEqual(server.takingsByKind(payments, methods), takingsByKind(payments, methods));
  for (const [c, e] of [['{"a":1}', '{"a":3}'], ['bad', '{}'], ['{"a":"9"}', '{"a":4}'], [undefined, undefined]] as const) {
    assert.equal(server.cashVarianceOf(c, e), cashVarianceOf(c, e));
  }
  for (const p of [{ amount: 1_400, method: 'momo' }, { amount: 50, method: 'cash' }, { amount: 7, method: 'bank' }, { amount: 0 }]) {
    assert.deepEqual(server.payoutLines(p), payoutLines(p));
  }
  for (const w of [{ value: 800, module: 'bar' }, { value: 12 }, { value: 0 }, { value: 5, module: 'craft' }]) {
    assert.deepEqual(server.wasteLines(w), wasteLines(w));
  }
});

test('a spend is charged the same way on both sides', () => {
  const grid = [
    { amount: 5_000, lines: [{ stocked: true, lineTotal: 3_000 }, { stocked: false, lineTotal: 1_000 }], categoryAccount: '6010' },
    { amount: 5_000, lines: [{ stocked: true, lineTotal: 9_000 }], categoryAccount: '6010' },
    { amount: 5_000, lines: [], categoryAccount: '1210' },
    { amount: 0, lines: [{ stocked: true, lineTotal: 10 }], categoryAccount: '6010' },
    { amount: 2_500.4, lines: [{ stocked: true, lineTotal: 2_500.4 }], categoryAccount: '6020' },
  ];
  for (const g of grid) {
    const input = { ...g, stockAccount: '1200', fallbackAccount: '6090', stockAccounts: ['1200', '1210', '1220'] };
    assert.deepEqual(server.spendDebits(input), spendDebits(input), JSON.stringify(g));
    const mine = spendPostingLines(spendDebits(input), '1000');
    assert.deepEqual(server.spendPostingLines(server.spendDebits(input), '1000'), mine);
  }
  const a = [{ account_code: '1200', amount: 3_000, memo: 'x' }, { account_code: '6010', amount: 2_000, memo: 'y' }];
  const b = [{ account_code: '6010', amount: 2_000, memo: '' }, { account_code: '1200', amount: 3_000, memo: '' }];
  assert.equal(server.sameDebits(a, b), sameDebits(a, b));
  assert.equal(server.sameDebits(a, a.slice(1)), sameDebits(a, a.slice(1)));
  // Through the row, as the server reads it.
  const row = { amount: 5_000, module: 'bar' };
  const items = [{ stocked: true, line_total: 3_000 }, { stocked: false, line_total: 1_000 }];
  assert.deepEqual(server.debitsForSpend(row, items, '6010'), spendDebits({
    amount: 5_000, lines: [{ stocked: true, lineTotal: 3_000 }, { stocked: false, lineTotal: 1_000 }],
    stockAccount: '1210', categoryAccount: '6010', fallbackAccount: '6090', stockAccounts: ['1200', '1210', '1220'],
  }));
  assert.deepEqual(server.debitsForSpend(row, [], undefined), [{ account_code: '6090', amount: 5_000, memo: 'Money paid out' }]);
});

test('the tax comes apart the same way on both sides', () => {
  const text = serialiseLevies([...GHANA_LEVIES, { key: 'local', name: 'Local council', rate_bp: 50 }]);
  for (const raw of [text, '', 'not json', '{"key":"x"}', serialiseLevies([])]) {
    assert.deepEqual(server.parseLevies(raw), parseLevies(raw), raw);
  }
  const levies = parseLevies(text);
  for (const total of [0, 1, 99, 2_190, 12_345, 100_000]) {
    for (const vatBp of [0, 1250, 1500]) {
      assert.deepEqual(server.splitTax(total, { vatBp, levies }), splitTax(total, { vatBp, levies }), `${total} at ${vatBp}`);
      assert.deepEqual(server.splitTax(total, { vatBp, levies: [] }), splitTax(total, { vatBp, levies: [] }));
    }
  }
  for (const key of ['nhil', 'getfund', 'tourism', 'vat', 'local']) assert.equal(server.levyAccount(key), levyAccount(key));
});

test('the makers’ share agrees, everywhere', () => {
  const makers = [{ $id: 'ama', commission_bp: 3000 }, { $id: 'kofi', commission_flat: 500 }];
  const lines = [
    { consignor_id: 'ama', line_total: 20_000, qty: 2 },
    { consignor_id: 'kofi', line_total: 1_200, qty: 3 },
    { consignor_id: 'kofi', line_total: 300, qty: 1 },
    { consignor_id: '', line_total: 5_000, qty: 1 },
    { consignor_id: 'gone', line_total: 999, qty: 1, commission_bp: 1000 },
  ];
  for (const settings of [{ default_commission_bp: 3000 }, {}, null]) {
    assert.equal(server.makersShareOf(lines, makers, settings), makersShareOf(lines, makers, settings));
  }
  for (const gross of [0, 1, 999, 20_000]) {
    for (const bp of [0, 3000, 12_000]) {
      for (const [flat, qty] of [[0, 1], [500, 3], [50_000, 1]]) {
        assert.deepEqual(server.splitSale(gross, bp, flat, qty), splitSale(gross, bp, flat, qty));
      }
    }
  }
  assert.equal(server.rateFor({ commission_bp: 12_000 }, null, null), rateFor({ commission_bp: 12_000 }, null, null));
  assert.equal(server.flatFor({ commission_flat: 2.6 }, null), flatFor({ commission_flat: 2.6 }, null));
});

test('what counts as locked agrees', () => {
  for (const [date, through] of [
    ['2026-08-31T23:00:00Z', '2026-08-31'], ['2026-09-01T00:00:00Z', '2026-08-31'], ['2026-09-01', ''], ['', '2026-08-31'],
  ]) {
    assert.equal(server.isLocked(date, through), isLocked(date, through), `${date} / ${through}`);
  }
});
