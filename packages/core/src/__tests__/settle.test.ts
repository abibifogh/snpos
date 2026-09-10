import test from 'node:test';
import assert from 'node:assert/strict';
import {
  settlementLines, tipsPaidLines, taxRemittedLines, settlementProblem, paydownProblem,
} from '../settle.ts';

const acct = { clearingAccount: '1020', bankAccount: '1040', feesAccount: '6070' };
const sum = (lines: { debit: number; credit: number }[]) =>
  [lines.reduce((s, l) => s + l.debit, 0), lines.reduce((s, l) => s + l.credit, 0)];

test('a settlement clears what the customers paid, not only what arrived', () => {
  /*
    The provider kept 124 of 12,400. Crediting clearing by 12,276 would leave
    124 sitting there for ever, the residue no reconciliation can explain.
  */
  const lines = settlementLines({ received: 12_276, fee: 124, ...acct });
  assert.deepEqual(lines.map((l) => [l.account_code, l.debit, l.credit]), [
    ['1040', 12_276, 0],
    ['6070', 124, 0],
    ['1020', 0, 12_400],
  ]);
  assert.deepEqual(sum(lines), [12_400, 12_400]);
});

test('no fee, no fee line', () => {
  const lines = settlementLines({ received: 5_000, fee: 0, ...acct });
  assert.equal(lines.length, 2);
  assert.deepEqual(sum(lines), [5_000, 5_000]);
});

test('tips and tax pay a liability down and balance', () => {
  assert.deepEqual(sum(tipsPaidLines(1_240, '2200', '1000')), [1_240, 1_240]);
  assert.deepEqual(sum(taxRemittedLines(18_230, '2100', '1040')), [18_230, 18_230]);
  assert.deepEqual(tipsPaidLines(0, '2200', '1000'), []);
});

test('a settlement cannot clear more than is waiting', () => {
  // Clearing would go negative, which reads as the provider owing money it
  // never took.
  assert.equal(settlementProblem({ received: 12_276, fee: 124, outstanding: 12_400 }), null);
  assert.match(String(settlementProblem({ received: 12_300, fee: 124, outstanding: 12_400 })), /more than is waiting/);
  assert.match(String(settlementProblem({ received: 0, fee: 0, outstanding: 12_400 })), /Enter what/);
  assert.match(String(settlementProblem({ received: 100, fee: -1, outstanding: 12_400 })), /less than nothing/);
});

test('nor can tips or tax be paid past what is owed', () => {
  assert.equal(paydownProblem(1_240, 1_240, 'in tips'), null);
  assert.match(String(paydownProblem(1_241, 1_240, 'in tips')), /more in tips than is owed/);
  assert.match(String(paydownProblem(0, 1_240, 'tax')), /Enter how much tax/);
});
