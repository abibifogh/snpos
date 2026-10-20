import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countedOnSheet, checkOnly, countsOutAtClose, countsInAtOpen, countsAtBothEnds, openingCountOptional, kitchenCounts,
} from '../bar-count.ts';

test('the bar and the shop always count out on the sheet before closing', () => {
  assert.equal(countsOutAtClose('bar'), true);
  assert.equal(countsOutAtClose('craft'), true);
  assert.equal(countsOutAtClose('bar', { kitchen_stock_check: 'levels' }), true, 'the kitchen setting is the kitchen\'s');
  assert.equal(countsInAtOpen('bar'), true);
});

test('the kitchen says OK, Low or Out unless it has been set to count', () => {
  // Nobody has answered: the quick check, no sheet at either end.
  assert.equal(kitchenCounts(undefined), false);
  assert.equal(kitchenCounts({}), false);
  assert.equal(countsOutAtClose('kitchen'), false);
  assert.equal(countsInAtOpen('kitchen'), false);
  assert.equal(countsOutAtClose(undefined, { kitchen_stock_check: 'levels' }), false, 'an older row with no side is the kitchen');
  assert.equal(countsOutAtClose('kitchen', { kitchen_stock_check: null }), false);

  // Chosen: counted in and out on the sheet, asked of the kitchen, never forced.
  const counted = { kitchen_stock_check: 'count' };
  assert.equal(kitchenCounts(counted), true);
  assert.equal(countsOutAtClose('kitchen', counted), true);
  assert.equal(countsInAtOpen('kitchen', counted), true);
  assert.equal(countsAtBothEnds('kitchen'), false);
  assert.equal(openingCountOptional('kitchen'), true);
});

test('"just check it" items stay off the count sheet and are the only ones the close asks about', () => {
  const rows = [
    { $id: 'rice', check_only: false },
    { $id: 'salt', check_only: true },
    { $id: 'oil', check_only: true },
    { $id: 'chicken' },
  ];
  assert.deepEqual(countedOnSheet(rows).map((r) => r.$id), ['rice', 'chicken']);
  assert.deepEqual(checkOnly(rows).map((r) => r.$id), ['salt', 'oil']);
  // Nothing marked: everything is counted, and the close asks about nothing.
  assert.equal(checkOnly<{ $id: string; check_only?: boolean }>([{ $id: 'x' }]).length, 0);
});
