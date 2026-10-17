import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMoneyCode, newMoneyAccountProblem, moneyTransferProblem, transferLines, moneyKindOf } from '../banks.ts';
import { moneyAccounts, payFromAccounts, entryProblem, type AccountRow } from '../ledger-math.ts';
import { cashFlow } from '../ledger-reports.ts';

const chart: AccountRow[] = [
  { code: '1000', name: 'Cash on hand', type: 'asset' },
  { code: '1010', name: 'Card clearing', type: 'asset' },
  { code: '1030', name: 'Petty cash', type: 'asset' },
  { code: '1040', name: 'Bank account', type: 'asset' },
  { code: '1041', name: 'Second bank ··4471', type: 'asset', cash_kind: 'bank' },
  { code: '1042', name: 'MoMo wallet', type: 'asset', cash_kind: 'momo' },
  { code: '1100', name: 'Owed by customers', type: 'asset' },
  { code: '4000', name: 'Sales', type: 'revenue' },
];

test('each bank and the MoMo wallet is a money account, numbered after the bank', () => {
  assert.deepEqual(moneyAccounts(chart).map((a) => a.code), ['1000', '1030', '1040', '1041', '1042']);
  assert.deepEqual(payFromAccounts(chart).map((a) => a.code), ['1040', '1000', '1041', '1042'], 'the bank first, never petty cash');
  assert.equal(nextMoneyCode(chart), '1043');
  assert.equal(moneyKindOf(chart[4]), 'bank');
  assert.equal(moneyKindOf(chart[5]), 'momo');
  assert.equal(moneyKindOf(chart[0]), 'cash');
  assert.equal(moneyKindOf(chart[6]), null);
  assert.match(newMoneyAccountProblem('momo wallet', chart) ?? '', /already/);
  assert.equal(newMoneyAccountProblem('Third bank', chart), null);
});

test('a transfer moves money and nothing else, and leaves the cash flow alone', () => {
  assert.match(moneyTransferProblem('1040', '1040', 100) ?? '', /same/);
  assert.match(moneyTransferProblem('1040', '1042', 0) ?? '', /amount/);
  const t = transferLines('1042', '1040', 5000);
  assert.equal(entryProblem(t), null);
  const lines = [
    { entry_id: 's', date: '2026-10-02', account_code: '1042', debit: 5000, credit: 0 },
    { entry_id: 's', date: '2026-10-02', account_code: '4000', debit: 0, credit: 5000 },
    ...t.map((x) => ({ entry_id: 't', date: '2026-10-03', account_code: x.account_code, debit: x.debit, credit: x.credit })),
  ];
  const f = cashFlow(chart, lines, { from: '2026-10-01', to: '2026-10-31', cashCodes: moneyAccounts(chart).map((a) => a.code) });
  assert.deepEqual(f.inflows.map((g) => [g.key, g.amount]), [['sales', 5000]]);
  assert.equal(f.outflows.length, 0);
});
