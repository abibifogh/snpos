import test from 'node:test';
import assert from 'node:assert/strict';
import {
  plTable, previousPeriod, sameLastYear, monthsIn, generalLedger, cashFlow, taxReturn, ageBuckets, daysLate, deptOf, changeShare,
  type PostedLine,
} from '../ledger-reports.ts';
import { writeXlsx, colName, sheetName, crc32 } from '../xlsx-write.ts';
import { readXlsx } from '../xlsx.ts';
import type { AccountRow } from '../ledger-math.ts';

const accounts: AccountRow[] = [
  { code: '1000', name: 'Cash on hand', type: 'asset' },
  { code: '1020', name: 'Mobile money clearing', type: 'asset' },
  { code: '1040', name: 'Bank account', type: 'asset' },
  { code: '1210', name: 'Inventory - bar', type: 'asset' },
  { code: '2110', name: 'NHIL payable', type: 'liability' },
  { code: '3000', name: 'Owner equity', type: 'equity' },
  { code: '4000', name: 'Restaurant sales', type: 'revenue' },
  { code: '4010', name: 'Bar sales', type: 'revenue' },
  { code: '5010', name: 'Cost of drinks sold', type: 'expense' },
  { code: '6020', name: 'Utilities', type: 'expense' },
];
let n = 0;
const entry = (date: string, ...ls: [string, number, number][]): PostedLine[] => {
  const id = `e${++n}`;
  return ls.map(([account_code, debit, credit]) => ({ entry_id: id, date, account_code, debit, credit }));
};
const lines: PostedLine[] = [
  ...entry('2026-08-03', ['1000', 5000, 0], ['4010', 0, 5000]),
  ...entry('2026-09-02', ['1000', 6000, 0], ['1020', 2000, 0], ['4000', 0, 4000], ['4010', 0, 3800], ['2110', 0, 200]),
  ...entry('2026-09-05', ['5010', 900, 0], ['1210', 0, 900]),
  ...entry('2026-09-10', ['6020', 700, 0], ['1040', 0, 700]),
  ...entry('2026-09-12', ['1040', 3000, 0], ['1000', 0, 3000]),
  ...entry('2026-09-20', ['2110', 150, 0], ['1040', 0, 150]),
  ...entry('2026-09-25', ['1040', 1980, 0], ['1020', 0, 1980]),
];

test('the profit and loss splits by department: sales exactly, overheads as shared', () => {
  const t = plTable(accounts, lines, { by: 'department', from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(t.columns, ['Bistro', 'Bar', 'Shop', 'Shared']);
  assert.deepEqual(t.income.map((r) => [r.code, r.cells]), [['4000', [4000, 0, 0, 0]], ['4010', [0, 3800, 0, 0]]]);
  assert.deepEqual(t.costs.map((r) => [r.code, r.cells]), [['5010', [0, 900, 0, 0]], ['6020', [0, 0, 0, 700]]]);
  assert.deepEqual(t.profit, [4000, 2900, 0, -700, 6200]);
  assert.equal(deptOf('6100'), 'shared');
});

test('by month, and compared with the month before', () => {
  const t = plTable(accounts, lines, {
    by: 'month', from: '2026-08-01', to: '2026-09-30',
    compareLines: lines.filter((l) => l.date < '2026-08-01'),
  });
  assert.deepEqual(t.columns, ['2026-08', '2026-09']);
  assert.deepEqual(t.income.find((r) => r.code === '4010')?.cells, [5000, 3800]);
  const prev = previousPeriod('2026-09-01', '2026-09-30');
  assert.deepEqual(prev, { from: '2026-08-01', to: '2026-08-31' });
  const c = plTable(accounts, lines, {
    by: 'single', from: '2026-09-01', to: '2026-09-30',
    compareLines: lines.filter((l) => l.date >= prev.from && l.date <= `${prev.to}￿`),
  });
  assert.equal(c.income.find((r) => r.code === '4010')?.compare, 5000);
  assert.deepEqual(c.compare, { income: 5000, costs: 0, profit: 5000 });
  assert.equal(changeShare(6200, 5000), 0.24);
  assert.equal(changeShare(10, 0), null);
  assert.deepEqual(sameLastYear('2028-02-01', '2028-02-29'), { from: '2027-02-01', to: '2027-02-28' });
  assert.deepEqual(previousPeriod('2026-09-10', '2026-09-19'), { from: '2026-08-31', to: '2026-09-09' });
  assert.deepEqual(monthsIn('2026-11-15', '2027-02-01'), ['2026-11', '2026-12', '2027-01', '2027-02']);
});

test('the year-end closing entry is left out of the profit and loss', () => {
  const close = entry('2026-09-30', ['4000', 4000, 0], ['3000', 0, 4000]);
  const t = plTable(accounts, [...lines, ...close], {
    by: 'single', from: '2026-09-01', to: '2026-09-30', exclude: new Set([close[0].entry_id]),
  });
  assert.equal(t.income.find((r) => r.code === '4000')?.total, 4000);
});

test('the general ledger opens with what came before and runs a balance', () => {
  const g = generalLedger(accounts[0], lines, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(g.opening, 5000);
  assert.deepEqual(g.rows.map((r) => r.balance), [11000, 8000]);
  assert.equal(g.closing, 8000);
  assert.equal(g.debit, 6000);
  assert.equal(g.credit, 3000);
  const empty = generalLedger(accounts[0], lines, { from: '2026-10-01' });
  assert.equal(empty.closing, 8000, 'nothing in the window still carries the balance');
});

test('cash flow groups add up exactly to the change in cash', () => {
  const f = cashFlow(accounts, lines, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(f.opening, 5000);
  const groups = [...f.inflows, ...f.outflows];
  assert.equal(groups.reduce((s, g) => s + g.amount, 0), f.closing - f.opening);
  assert.deepEqual(Object.fromEntries(groups.map((g) => [g.key, g.amount])), {
    sales: 7800, settle: -20, overheads: -700, tax: 50,
  });
  // Banking the drawer moved nothing in or out.
  assert.equal(f.net, 7130);
});

test('the tax return is the levy accounts over the period, and what is still owed', () => {
  const r = taxReturn(accounts, lines, { from: '2026-09-01', to: '2026-09-30', taxCodes: ['2110'] });
  assert.equal(r.sales, 7800);
  assert.deepEqual(r.rows.map((x) => [x.code, x.collected, x.paid, x.owed]), [['2110', 200, 150, 50]]);
});

test('amounts owed sort into how overdue they are', () => {
  const b = ageBuckets([
    { amount: 100, due: '2026-10-20' }, { amount: 200, due: '2026-10-01' },
    { amount: 300, due: '2026-08-30' }, { amount: 400, due: '2026-07-01' },
  ], '2026-10-17');
  assert.deepEqual(b, { current: 100, d30: 200, d60: 300, over: 400, total: 1000 });
  assert.equal(daysLate('2026-10-10', '2026-10-17'), 7);
  assert.equal(daysLate('2026-10-20', '2026-10-17'), 0);
});

test('a written workbook reads back cell for cell', async () => {
  const bytes = writeXlsx([
    { name: 'Profit & loss', rows: [['Account', 'Amount'], ['Sales', 1234.5], ['Note <a> & "b"', null]] },
    { name: 'Profit & loss', rows: [['Second sheet']] },
  ]);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK');
  const grid = await readXlsx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  assert.deepEqual(grid, [['Account', 'Amount'], ['Sales', '1234.5'], ['Note <a> & "b"']]);
  assert.equal(colName(0), 'A');
  assert.equal(colName(27), 'AB');
  const taken = new Set<string>();
  assert.equal(sheetName('Profit & loss', taken), 'Profit & loss');
  assert.equal(sheetName('Profit & loss', taken), 'Profit & loss 2');
  assert.equal(sheetName('a/b:c', taken), 'a b c');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
