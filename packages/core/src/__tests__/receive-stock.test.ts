import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stillOwed, owedBySupplier, payProblem } from '../owed-spends.ts';
import { spendWords } from '../spend-kind.ts';
import { ACCOUNTS } from '../accounts.ts';
import { ACCOUNTS as SERVER } from '../../../../functions/notify/src/books.js';
import { SYSTEM_ACCOUNT_CODES, SEED_ACCOUNTS } from '../../../../scripts/schema.mjs';

const row = (o: Record<string, unknown>) => ({ $id: 'x', amount: 1000, pay_later: true, ...o });

test('still owed is what was received on account, not refused and not yet paid, oldest first', () => {
  const rows = [
    row({ $id: 'b', $createdAt: '2026-10-12', payee: 'Kasapreko' }),
    row({ $id: 'a', $createdAt: '2026-10-10', payee: 'Kasapreko' }),
    row({ $id: 'paid', paid_at: '2026-10-13' }),
    row({ $id: 'refused', approval_status: 'rejected' }),
    row({ $id: 'cash', pay_later: false }),
  ];
  assert.deepEqual(stillOwed(rows).map((r) => r.$id), ['a', 'b']);
  assert.deepEqual(owedBySupplier(rows), [{ payee: 'Kasapreko', amount: 2000, count: 2 }]);
});

test('a payment needs something owed and somewhere it came from', () => {
  assert.equal(payProblem(null, 'bank'), 'Pick what is being paid.');
  assert.match(payProblem(row({ paid_at: 'x' }), 'bank') ?? '', /already been paid/);
  assert.match(payProblem(row({ approval_status: 'rejected' }), 'bank') ?? '', /refused/);
  assert.match(payProblem(row({}), '') ?? '', /where the money came from/);
  assert.equal(payProblem(row({}), 'cash'), null);
});

test('a spend not paid yet says so, and says when it has been', () => {
  assert.equal(spendWords({ pay_later: true, source: 'own' }).source, 'Not paid yet');
  assert.equal(spendWords({ pay_later: true, paid_at: '2026-10-14' }).source, 'Paid later');
  assert.equal(spendWords({ source: 'own' }).source, 'Own money, to be paid back');
});

test('accounts payable is one account on both sides of the books, protected and seeded', () => {
  assert.equal(ACCOUNTS.accountsPayable, '2300');
  assert.equal(SERVER.accountsPayable, '2300');
  assert.ok(SYSTEM_ACCOUNT_CODES.includes('2300'));
  assert.ok(SEED_ACCOUNTS.some((a) => a[0] === '2300'));
});
