import test from 'node:test';
import assert from 'node:assert/strict';
import { yearEndLines, yearStart, openingLines, isClosingEntry, plTable, type PostedLine } from '../ledger-reports.ts';
import { entryProblem } from '../ledger-math.ts';
import type { AccountRow } from '../ledger-math.ts';
import { nextMonthly, recurringLines } from '../../../../functions/notify/src/books.js';

const accounts: AccountRow[] = [
  { code: '1000', name: 'Cash', type: 'asset' },
  { code: '1040', name: 'Bank', type: 'asset' },
  { code: '2300', name: 'Accounts payable', type: 'liability' },
  { code: '3000', name: 'Owner equity', type: 'equity' },
  { code: '3100', name: 'Retained earnings', type: 'equity' },
  { code: '4000', name: 'Sales', type: 'revenue' },
  { code: '6020', name: 'Utilities', type: 'expense' },
];
const l = (entry_id: string, date: string, account_code: string, debit: number, credit: number): PostedLine => ({ entry_id, date, account_code, debit, credit });
const lines = [
  l('a', '2025-03-01', '1000', 9000, 0), l('a', '2025-03-01', '4000', 0, 9000),
  l('b', '2025-06-01', '6020', 2500, 0), l('b', '2025-06-01', '1040', 0, 2500),
  l('c', '2026-01-10', '1000', 400, 0), l('c', '2026-01-10', '4000', 0, 400),
];

test('the year end brings income and costs to nought, and the profit into retained earnings', () => {
  const plan = yearEndLines(accounts, lines, { from: '2025-01-01', to: '2025-12-31', retained: '3100' });
  assert.equal(plan.profit, 6500);
  assert.deepEqual(plan.lines.map((x) => [x.account_code, x.debit, x.credit]), [['4000', 9000, 0], ['6020', 0, 2500], ['3100', 0, 6500]]);
  assert.equal(entryProblem(plan.lines), null, 'it balances');
  // Posted, the closed year still reads on the P&L, and next year starts clean.
  const closing = plan.lines.map((x) => l('ye', '2025-12-31', x.account_code, x.debit, x.credit));
  const all = [...lines, ...closing];
  const t = plTable(accounts, all, { by: 'single', from: '2025-01-01', to: '2025-12-31', exclude: new Set(['ye']) });
  assert.equal(t.profit[t.profit.length - 1], 6500);
  assert.equal(yearStart([{ date: '2025-12-31T23:59:00Z', source: 'adjustment', source_id: 'year_end:2025-12-31' }], all), '2026-01-01');
  assert.equal(isClosingEntry({ source: 'adjustment', source_id: 'year_end:2025-12-31' }), true);
  assert.equal(isClosingEntry({ source: 'adjustment', source_id: 'opening:2025-01-01' }), false);
  assert.deepEqual(yearEndLines(accounts, all, { from: '2026-01-01', to: '2026-12-31', retained: '3100', exclude: new Set(['ye']) }).profit, 400);
});

test('opening balances post as one balanced entry, the rest to owner equity', () => {
  const o = openingLines(accounts, { '1000': 5000, '1040': 20000, '2300': 3000 }, '3000');
  assert.deepEqual(o.lines.map((x) => [x.account_code, x.debit, x.credit]), [
    ['1000', 5000, 0], ['1040', 20000, 0], ['2300', 0, 3000], ['3000', 0, 22000],
  ]);
  assert.equal(entryProblem(o.lines), null);
  // An overdrawn bank is a negative asset: a credit.
  const od = openingLines(accounts, { '1040': -1500, '3000': -1500 }, '3000');
  assert.deepEqual(od.lines.map((x) => [x.account_code, x.debit, x.credit]), [['1040', 0, 1500], ['3000', 1500, 0]]);
});

test('a recurring entry moves on a month, to the last day of a short one', () => {
  assert.equal(nextMonthly('2026-01-31', 31), '2026-02-28');
  assert.equal(nextMonthly('2026-02-28', 31), '2026-03-31');
  assert.equal(nextMonthly('2026-12-05', 5), '2027-01-05');
  assert.deepEqual(recurringLines('[{"account_code":"6020","debit":100,"credit":0},{"account_code":"1040","debit":0,"credit":100},{"account_code":"","debit":5}]'), [
    { account_code: '6020', debit: 100, credit: 0, memo: '' }, { account_code: '1040', debit: 0, credit: 100, memo: '' },
  ]);
  assert.deepEqual(recurringLines('not json'), []);
});
