import test from 'node:test';
import assert from 'node:assert/strict';
import { owedTabs, owedRows } from '../receivables.ts';
import { stillOwed, leftToPay, dueOf, payProblem, owedBySupplier } from '../owed-spends.ts';
import { ageBuckets } from '../ledger-reports.ts';

const order = (o: Record<string, unknown>) => ({ $id: 'o', $createdAt: '2026-10-01T12:00:00Z', order_no: 'B-1', tab_id: 't1', total: 1000, status: 'SERVED', payment_status: 'unpaid', ...o });

test('owed to us is what is left on each tab, oldest bill first, most owed first', () => {
  const tabs = [{ $id: 't1', name: 'Room 4', status: 'open' }, { $id: 't2', name: 'Example Ltd', status: 'settled' }, { $id: 't3', name: 'Paid up', status: 'open' }];
  const orders = [
    order({ $id: 'a', $createdAt: '2026-10-05T12:00:00Z' }),
    order({ $id: 'b', $createdAt: '2026-09-20T12:00:00Z', total: 500 }),
    order({ $id: 'c', status: 'CANCELLED' }),
    order({ $id: 'd', tab_id: 't2', total: 4000 }),
    order({ $id: 'e', tab_id: 't3', total: 300 }),
  ];
  const paid: Record<string, number> = { a: 400, e: 300 };
  const got = owedTabs(tabs, orders as never, (id) => paid[id] ?? 0);
  assert.deepEqual(got.map((t) => [t.tab.name, t.owed, t.oldest.slice(0, 10)]), [
    ['Example Ltd', 4000, '2026-10-01'],
    ['Room 4', 1100, '2026-09-20'],
  ]);
  assert.deepEqual(ageBuckets(owedRows(got), '2026-10-17'), { current: 0, d30: 5100, d60: 0, over: 0, total: 5100 });
});

test('a bill can be paid in parts, and sorts by when it is due', () => {
  const bills = [
    { $id: 'rent', amount: 8500, pay_later: true, due_on: '2026-10-31', $createdAt: '2026-10-01', payee: 'Example Properties' },
    { $id: 'stock', amount: 1348, pay_later: true, paid_amount: 348, $createdAt: '2026-10-11', payee: 'Example Wholesale' },
    { $id: 'done', amount: 900, pay_later: true, paid_amount: 900, paid_at: '2026-10-12', $createdAt: '2026-10-02' },
  ];
  assert.deepEqual(stillOwed(bills).map((b) => b.$id), ['stock', 'rent']);
  assert.equal(leftToPay(bills[1]), 1000);
  assert.equal(dueOf(bills[1]), '2026-10-11', 'no due date is due on receipt');
  assert.match(payProblem(bills[1], 'bank', 1200) ?? '', /more than is left/);
  assert.match(payProblem(bills[1], 'bank', 0) ?? '', /amount/);
  assert.equal(payProblem(bills[1], '1041', 500), null, 'any money account will do');
  assert.match(payProblem(bills[2], 'bank') ?? '', /already been paid/);
  assert.deepEqual(owedBySupplier(bills).map((x) => [x.payee, x.amount]), [['Example Properties', 8500], ['Example Wholesale', 1000]]);
});
