import test from 'node:test';
import assert from 'node:assert/strict';
import { fromTakings, expenseMethods, payeeLabel } from '../expense-rules.ts';

/**
 * Whose money paid for it decides whether a drawer is short.
 *
 * Two things were filed as one: money out of the till, which the count must
 * expect less of, and money out of somebody's own pocket, which the till never
 * held. The second deducted made the drawer look short by an amount that was
 * never in it, and the person who lent the money answered for the shortage.
 */
test('an expense with nothing said about it came out of the drawer', () => {
  // Everything written before the question existed. Deducting these is what
  // has always happened and must keep happening; a silent change of meaning on
  // historic rows would move every shift's figures at once.
  assert.equal(fromTakings({}), true);
  assert.equal(fromTakings({ from_takings: undefined }), true);
  assert.equal(fromTakings({ from_takings: true }), true);
});

test('own money is spending, but it is not the drawer being short', () => {
  assert.equal(fromTakings({ from_takings: false }), false);
});

test('the drawer expects less only for what actually left it', () => {
  // The sum expectedTakings does, in the small: two expenses, one from the
  // till and one from a cook's pocket, and only the first moves the count.
  const expenses = [
    { amount: 5000, paid_from_method_id: 'cash', from_takings: true },
    { amount: 2000, paid_from_method_id: 'cash', from_takings: false },
    { amount: 1000, paid_from_method_id: 'cash' },
  ];
  const deducted = expenses.filter(fromTakings).reduce((a, e) => a + e.amount, 0);
  const spent = expenses.reduce((a, e) => a + e.amount, 0);

  assert.equal(deducted, 6000, 'the till paid for two of the three');
  assert.equal(spent, 8000, 'the business paid for all three');
  assert.equal(spent - deducted, 2000, 'and owes that back to whoever covered it');
});

test('cash only, unless the restaurant says otherwise', () => {
  const methods = [{ $id: 'c', kind: 'cash' }, { $id: 'm', kind: 'mobile_money' }];
  assert.deepEqual(expenseMethods(methods), [{ $id: 'c', kind: 'cash' }]);
  assert.deepEqual(expenseMethods(methods, { expense_paid_from: 'any' }), methods);
  // A form with an empty dropdown teaches staff the screen is broken.
  assert.deepEqual(expenseMethods([{ $id: 'm', kind: 'mobile_money' }]), [{ $id: 'm', kind: 'mobile_money' }]);
});

test('who the money went to reads as words, whichever way it went out', () => {
  assert.equal(payeeLabel('supplier', { supplierName: 'Kofi Farms' }), 'Kofi Farms');
  assert.equal(payeeLabel('staff', { staffName: 'Ama' }), 'Ama');
  // Somebody not on the list is still somebody the money went to.
  assert.equal(payeeLabel('staff', { payee: 'Yaw, casual' }), 'Yaw, casual');
  assert.equal(payeeLabel('open_market', {}), 'Open market');
});
