import test from 'node:test';
import assert from 'node:assert/strict';
import { countedOnSheet, checkOnly, countsOutAtClose, countsAtBothEnds, openingCountOptional } from '../bar-count.ts';

test('every side counts out on the sheet before closing; only the bar and shop must', () => {
  assert.equal(countsOutAtClose('bar'), true);
  assert.equal(countsOutAtClose('craft'), true);
  assert.equal(countsOutAtClose('kitchen'), true);
  assert.equal(countsOutAtClose(undefined), true, 'an older row with no side is the kitchen');
  // Asked of the kitchen, never forced: it is not a both-ends side.
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
