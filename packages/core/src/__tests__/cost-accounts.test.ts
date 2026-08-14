import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCostAccounts, serialiseCostAccounts, hasCostChoice, countsAsCost,
  splitCosts, costCodeFor, startingCostChoice, UNCATEGORISED_COST_CODE,
} from '../cost-accounts.ts';

const CATEGORIES = [
  { key: 'market', account_code: '6000' },
  { key: 'gas', account_code: '6010' },
  { key: 'rent', account_code: '6200' },
  // A category somebody added without saying where it posts.
  { key: 'sundry' },
];

test('no choice means every expense counts', () => {
  /**
   * The setting arrives after the dashboard did. Reading an empty value as
   * "count nothing" would rewrite every venue's Costs to zero on the deploy
   * that shipped it, which is not a change anybody asked for.
   */
  assert.deepEqual(parseCostAccounts(undefined), []);
  assert.deepEqual(parseCostAccounts(''), []);
  assert.equal(hasCostChoice([]), false);
  assert.equal(countsAsCost('6200', []), true, 'rent counts until somebody says otherwise');
  assert.equal(countsAsCost('anything at all', []), true);
});

test('a choice counts what was chosen and nothing else', () => {
  const chosen = ['6000', '6010'];
  assert.equal(hasCostChoice(chosen), true);
  assert.equal(countsAsCost('6000', chosen), true);
  assert.equal(countsAsCost('6200', chosen), false, 'rent was left out');
});

test('the list survives a round trip, and tolerates what a person types', () => {
  assert.deepEqual(parseCostAccounts('6000, 6010 ,6200'), ['6000', '6010', '6200']);
  // Duplicates and blanks are not a state worth carrying around.
  assert.deepEqual(parseCostAccounts('6000,,6000, ,6010'), ['6000', '6010']);
  assert.equal(serialiseCostAccounts(['6010', '6000', '6010']), '6000,6010');
  assert.deepEqual(parseCostAccounts(serialiseCostAccounts(['6200', '6000'])), ['6000', '6200']);
});

test('what is left out is reported, not silently dropped', () => {
  /**
   * The whole reason this returns two halves. A headline that quietly
   * excludes money is one somebody eventually compares against the bank and
   * cannot explain — and the explanation is a setting they may not have made
   * themselves.
   */
  const rows = [
    { code: '6000', amount: 12000 },
    { code: '6000', amount: 3000 },
    { code: '6200', amount: 90000 },   // rent
    { code: '6300', amount: 40000 },   // equipment
  ];
  const split = splitCosts(rows, ['6000']);

  assert.equal(split.counted, 15000);
  assert.equal(split.excluded, 130000);
  assert.equal(split.excludedCount, 2);
  // Named and biggest first, so the page can say what is missing.
  assert.deepEqual(split.excludedByCode, [
    { code: '6200', amount: 90000 },
    { code: '6300', amount: 40000 },
  ]);
});

test('with no choice made, nothing is excluded', () => {
  const rows = [{ code: '6000', amount: 12000 }, { code: '6200', amount: 90000 }];
  const split = splitCosts(rows, []);
  assert.equal(split.counted, 102000);
  assert.equal(split.excluded, 0);
  assert.equal(split.excludedCount, 0);
});

test('an expense with no account still lands somewhere it can be chosen', () => {
  /**
   * Falling to no code at all would mean money that matches no account, so it
   * could never be selected into Costs however the house set things up — it
   * would simply never appear, in either half. Other expenses is a place
   * somebody can see it and decide.
   */
  assert.equal(costCodeFor({ category_key: 'market' }, CATEGORIES), '6000');
  assert.equal(costCodeFor({ category_key: 'sundry' }, CATEGORIES), UNCATEGORISED_COST_CODE);
  assert.equal(costCodeFor({ category_key: 'never heard of it' }, CATEGORIES), UNCATEGORISED_COST_CODE);
  assert.equal(costCodeFor({}, CATEGORIES), UNCATEGORISED_COST_CODE);
  // The old column is read when the newer one is empty.
  assert.equal(costCodeFor({ category: 'gas' }, CATEGORIES), '6010');
});

test('the picker opens on what the figure is already showing', () => {
  const all = ['6000', '6010', '6200'];
  // Nobody has chosen: everything is ticked, because everything is counted.
  assert.deepEqual(startingCostChoice(all, []), all);
  // A choice exists: it is what is ticked.
  assert.deepEqual(startingCostChoice(all, ['6000']), ['6000']);
  // A stored code whose account has since been deleted does not resurrect a
  // tick for a row that is not on screen.
  assert.deepEqual(startingCostChoice(all, ['6000', '9999']), ['6000']);
});
