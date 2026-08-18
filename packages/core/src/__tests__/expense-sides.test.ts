import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoriesForSide, canSeePrivateExpenses, CATEGORY_SIDES } from '../expense-rules.ts';

const rows = [
  { key: 'transport', module: 'general' },
  { key: 'bar_stock', module: 'bar' },
  { key: 'kitchen_stock', module: 'kitchen' },
  { key: 'craft_stock', module: 'craft' },
  { key: 'supplies' },                                  // written before sides existed
  { key: 'old_bar', module: 'bar', active: false },     // archived
  { key: 'rent', module: 'admin_only' },
];

test('a side sees its own and the shared ones, and nobody else’s', () => {
  assert.deepEqual(
    categoriesForSide(rows, 'bar').map((r) => r.key),
    ['transport', 'bar_stock', 'supplies'],
  );
  assert.deepEqual(
    categoriesForSide(rows, 'kitchen').map((r) => r.key),
    ['transport', 'kitchen_stock', 'supplies'],
  );
});

test('a category with no side reads as everywhere, not as the kitchen’s', () => {
  // Every category written before sides existed was used by all three.
  // Narrowing them to the kitchen would empty the other two lists overnight.
  for (const side of ['kitchen', 'bar', 'craft']) {
    assert.ok(categoriesForSide(rows, side).some((r) => r.key === 'supplies'), side);
  }
});

test('archived categories stay out unless asked for', () => {
  assert.equal(categoriesForSide(rows, 'bar').some((r) => r.key === 'old_bar'), false);
  assert.equal(
    categoriesForSide(rows, 'bar', { includeArchived: true }).some((r) => r.key === 'old_bar'),
    true,
  );
});

test('the sides on offer start with the shared one', () => {
  // "Everywhere" is the right default for anything somebody adds in a hurry:
  // a category on the wrong side is invisible, which reads as a bug.
  assert.equal(CATEGORY_SIDES[0].value, 'general');
  assert.deepEqual(
    CATEGORY_SIDES.map((s) => s.value),
    ['general', 'kitchen', 'bar', 'craft', 'admin_only'],
  );
});

test('the rent stays off the till', () => {
  // The point of the setting: real spending that has to be recorded and that
  // a bartender should not read off a dropdown while a customer waits.
  for (const side of ['kitchen', 'bar', 'craft']) {
    assert.equal(categoriesForSide(rows, side).some((r) => r.key === 'rent'), false, side);
  }
});

test('an admin-only category shows on every side, once it is allowed', () => {
  // Not one trade's — it is the office's — so it turns up wherever the person
  // who may see it happens to be working.
  for (const side of ['kitchen', 'bar', 'craft']) {
    assert.equal(
      categoriesForSide(rows, side, { canSeePrivate: true }).some((r) => r.key === 'rent'),
      true,
      side,
    );
  }
});

test('an admin-only category is still archived when archived', () => {
  const archived = [{ key: 'legal', module: 'admin_only', active: false }];
  assert.deepEqual(categoriesForSide(archived, 'bar', { canSeePrivate: true }), []);
});

test('admins always see them; everybody else only when granted', () => {
  assert.equal(canSeePrivateExpenses({ role: 'admin' }), true);
  assert.equal(canSeePrivateExpenses({ role: 'manager' }), false);
  assert.equal(canSeePrivateExpenses({ role: 'manager', can_see_private_expenses: true }), true);
  assert.equal(canSeePrivateExpenses({ role: 'waiter', can_see_private_expenses: false }), false);
  // Nobody signed in is nobody allowed.
  assert.equal(canSeePrivateExpenses(null), false);
  assert.equal(canSeePrivateExpenses(undefined), false);
});
