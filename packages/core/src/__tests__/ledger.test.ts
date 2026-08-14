import test from 'node:test';
import assert from 'node:assert/strict';
import {
  naturalBalance, isDebitNormal, profitAndLoss, balanceSheet, entryProblem,
  depreciationSchedule, bookValue, chargeForMonth, monthOf, nextMonth, within,
} from '../ledger-math.ts';
import { reconcile } from '../ledger-math.ts';
import type { AccountRow, LineRow, RecLine } from '../ledger-math.ts';

const CHART: AccountRow[] = [
  { code: '1000', name: 'Cash on hand', type: 'asset' },
  { code: '1500', name: 'Equipment', type: 'asset' },
  { code: '1510', name: 'Accumulated depreciation', type: 'asset' },
  { code: '2300', name: 'Accounts payable', type: 'liability' },
  { code: '3000', name: 'Owner equity', type: 'equity' },
  { code: '4000', name: 'Food sales', type: 'revenue' },
  { code: '5000', name: 'Cost of goods sold', type: 'expense' },
  { code: '6060', name: 'Depreciation', type: 'expense' },
];

test('an account reads in the direction it is normally held', () => {
  /**
   * Getting this backwards does not unbalance the books — they still add up —
   * it makes every figure on every statement the wrong sign, which looks
   * plausible on screen and is found by an accountant a year later.
   */
  assert.equal(isDebitNormal('asset'), true);
  assert.equal(isDebitNormal('expense'), true);
  assert.equal(isDebitNormal('revenue'), false);
  assert.equal(isDebitNormal('liability'), false);
  assert.equal(isDebitNormal('equity'), false);

  // Sales of 500 read as 500, not as minus 500.
  assert.equal(naturalBalance('revenue', 0, 50000), 50000);
  assert.equal(naturalBalance('asset', 50000, 0), 50000);
  // And money going the other way is negative in both directions.
  assert.equal(naturalBalance('asset', 0, 2000), -2000);
});

test('the profit and loss is the period, and only the period', () => {
  const lines: LineRow[] = [
    { account_code: '1000', debit: 50000, credit: 0 },   // an asset, not P&L
    { account_code: '4000', debit: 0, credit: 50000 },
    { account_code: '5000', debit: 18000, credit: 0 },
  ];
  const pl = profitAndLoss(CHART, lines);

  assert.equal(pl.totalRevenue, 50000);
  assert.equal(pl.totalExpenses, 18000);
  assert.equal(pl.netProfit, 32000);
  // What you own is a fact about a moment, not about a period.
  assert.ok(!pl.revenue.some((l) => l.code === '1000'));
  assert.ok(!pl.expenses.some((l) => l.code === '1000'));
  // Nothing on it is left off rather than printed as a column of zeros.
  assert.ok(!pl.expenses.some((l) => l.code === '6060'));
});

test('the balance sheet carries the profit, or it looks broken', () => {
  /**
   * A set of books that has never closed a year has its profit sitting in the
   * revenue and expense accounts. A balance sheet that ignores them is out by
   * exactly the profit — which is not a rounding error, it is the whole
   * year's trading.
   */
  const lines: LineRow[] = [
    { account_code: '1000', debit: 50000, credit: 0 },
    { account_code: '4000', debit: 0, credit: 50000 },
  ];
  const bs = balanceSheet(CHART, lines);

  assert.equal(bs.totalAssets, 50000);
  assert.equal(bs.retained, 50000, 'the profit, shown as its own line');
  assert.equal(bs.outBy, 0);
  assert.equal(bs.balanced, true);
});

test('a balance sheet that does not balance says so rather than rounding it away', () => {
  // Only ever reachable through a half-written entry or a deleted line, and
  // exactly the thing worth being told about.
  const bs = balanceSheet(CHART, [{ account_code: '1000', debit: 500, credit: 0 }]);
  assert.equal(bs.balanced, false);
  assert.equal(bs.outBy, 500);
});

test('an entry that would make the books wrong is refused, with the reason', () => {
  const ok: LineRow[] = [
    { account_code: '1000', debit: 1000, credit: 0 },
    { account_code: '4000', debit: 0, credit: 1000 },
  ];
  assert.equal(entryProblem(ok), null);

  assert.match(entryProblem([ok[0]]) ?? '', /at least two lines/);
  assert.match(
    entryProblem([{ account_code: '1000', debit: 1000, credit: 0 }, { account_code: '4000', debit: 0, credit: 900 }]) ?? '',
    /does not balance/,
  );
  assert.match(
    entryProblem([{ account_code: '1000', debit: 500, credit: 500 }, { account_code: '4000', debit: 0, credit: 500 }]) ?? '',
    /either a debit or a credit/,
  );
  assert.match(
    entryProblem([{ account_code: '1000', debit: -500, credit: 0 }, { account_code: '4000', debit: 0, credit: -500 }]) ?? '',
    /negative/,
  );
  assert.match(
    entryProblem([{ account_code: '', debit: 500, credit: 0 }, { account_code: '4000', debit: 0, credit: 500 }]) ?? '',
    /needs an account/,
  );
});

/* ---------------------------------------------------------- depreciation */

const fridge = {
  cost: 240000,
  salvage_value: 0,
  method: 'straight_line' as const,
  life_months: 48,
  acquired_on: '2026-01-14',
};

test('straight line spreads the cost evenly and stops at nought', () => {
  const sched = depreciationSchedule(fridge, '2030-12');

  assert.equal(sched[0].month, '2026-01', 'a whole month for the month it arrived in');
  assert.equal(sched[0].amount, 5000, '240,000 over 48 months');
  assert.equal(sched.length, 48, 'and it stops when it is written off');
  assert.equal(sched[47].closingValue, 0);

  // Never below nothing, however far past its life you ask.
  assert.equal(bookValue(fridge, '2035-01'), 0);
});

test('reducing balance charges more early and never reaches nought', () => {
  const van = {
    cost: 1000000,
    method: 'reducing_balance' as const,
    rate_bp: 3000, // 30% a year
    acquired_on: '2026-01-01',
  };
  const sched = depreciationSchedule(van, '2026-12');

  assert.equal(sched.length, 12);
  assert.ok(sched[0].amount > sched[11].amount, 'more in the first month than the last');
  // A twelfth of 30% of a million.
  assert.equal(sched[0].amount, 25000);
  assert.ok(sched[11].closingValue > 0, 'a percentage of what is left never gets there');
});

test('an asset is never written below what it will be worth at the end', () => {
  const withSalvage = { ...fridge, salvage_value: 40000 };
  const sched = depreciationSchedule(withSalvage, '2032-01');
  assert.equal(sched[sched.length - 1].closingValue, 40000);
  assert.ok(sched.every((c) => c.closingValue >= 40000));
});

test('nothing is charged for the month an asset was sold in, or after it', () => {
  // It was not there to be used, and charging for it means depreciating
  // something the business no longer has.
  const sold = { ...fridge, disposed_on: '2026-06-10' };
  const sched = depreciationSchedule(sold, '2027-01');
  assert.equal(sched[sched.length - 1].month, '2026-05');
  assert.equal(chargeForMonth(sold, '2026-06'), 0);
  assert.equal(chargeForMonth(sold, '2026-12'), 0);
});

test('a month is asked for by name, and one month follows another across a year', () => {
  assert.equal(monthOf('2026-08-14T09:00:00.000Z'), '2026-08');
  assert.equal(nextMonth('2026-11'), '2026-12');
  assert.equal(nextMonth('2026-12'), '2027-01');
  assert.equal(chargeForMonth(fridge, '2026-03'), 5000);
  assert.equal(chargeForMonth(fridge, '2025-12'), 0, 'before it was bought');
});

test('a window includes the whole of its last day', () => {
  /**
   * A line is stamped with the moment it was written, and a month runs to the
   * end of its last day. Comparing against the start of that day is the
   * difference between a month's figures and a month minus its last day —
   * which is a whole trading day quietly missing from a report.
   */
  const rows = [
    { date: '2026-07-31T23:59:00.000Z' },
    { date: '2026-08-01T08:00:00.000Z' },
    { date: '2026-08-31T21:30:00.000Z' },
    { date: '2026-09-01T00:05:00.000Z' },
  ];
  const august = within(rows, '2026-08-01', '2026-08-31');
  assert.equal(august.length, 2);
  assert.equal(august[0].date, '2026-08-01T08:00:00.000Z');
  assert.equal(august[1].date, '2026-08-31T21:30:00.000Z');
});

/* ------------------------------------------------------- reconciliation */

test('a reconciliation agrees when what the bank saw matches what was ticked', () => {
  /**
   * The statement's closing balance should equal the postings the bank has
   * also seen. What is left over was written by the business and not yet
   * processed, and is not part of the check.
   */
  const lines: RecLine[] = [
    { line_id: 'a', date: '2026-08-02', memo: 'Takings banked', amount: 50000, cleared: true },
    { line_id: 'b', date: '2026-08-05', memo: 'Rent', amount: -20000, cleared: true },
    { line_id: 'c', date: '2026-08-31', memo: 'Cheque not yet presented', amount: -5000, cleared: false },
  ];
  const r = reconcile(lines, 30000);

  assert.equal(r.perBooks, 25000, 'what the business believes it has');
  assert.equal(r.cleared, 30000, 'what the bank has seen');
  assert.equal(r.outstanding, -5000, 'written, not yet processed');
  assert.equal(r.difference, 0);
  assert.equal(r.agreed, true);
});

test('a difference that will not go is the missing transaction, not a rounding', () => {
  // The whole point of the exercise: the gap points at what one side has and
  // the other does not.
  const lines: RecLine[] = [
    { line_id: 'a', date: '2026-08-02', memo: 'Takings banked', amount: 50000, cleared: true },
  ];
  const r = reconcile(lines, 48000);
  assert.equal(r.difference, -2000);
  assert.equal(r.agreed, false);
});

test('nothing ticked and nothing on the statement still agrees', () => {
  const r = reconcile([], 0);
  assert.equal(r.agreed, true);
  assert.equal(r.outstanding, 0);
});
