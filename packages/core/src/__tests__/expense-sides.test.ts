import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoriesForSide, CATEGORY_SIDES } from '../expense-rules.ts';

const rows = [
  { key: 'transport', module: 'general' },
  { key: 'bar_stock', module: 'bar' },
  { key: 'kitchen_stock', module: 'kitchen' },
  { key: 'craft_stock', module: 'craft' },
  { key: 'supplies' },                                  // written before sides existed
  { key: 'old_bar', module: 'bar', active: false },     // archived
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
  assert.deepEqual(CATEGORY_SIDES.map((s) => s.value), ['general', 'kitchen', 'bar', 'craft']);
});
