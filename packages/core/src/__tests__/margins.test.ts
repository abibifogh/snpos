import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemCost, marginOf, marginIsThin, bpAsPercent, MARGIN_WARN_BP_DEFAULT,
} from '../margins.ts';

const gin = { $id: 'gin', base_unit_cost: 2000 };      // 20.00 a shot
const tonic = { $id: 'tonic', base_unit_cost: 500 };   // 5.00 a bottle
const stock = [gin, tonic];

test('a cost is the recipe priced at what the shelf is carried at', () => {
  const lines = [
    { ingredientId: 'gin', qtyPerUnit: 1, wastageBp: 0 },
    { ingredientId: 'tonic', qtyPerUnit: 1, wastageBp: 0 },
  ];
  assert.equal(itemCost(lines, stock), 2500);
});

test('wastage counts, because the measure that missed the glass was poured', () => {
  const lines = [{ ingredientId: 'gin', qtyPerUnit: 1, wastageBp: 500 }];
  assert.equal(itemCost(lines, stock), 2100, '5% over 20.00');
});

test('an ingredient that no longer exists is skipped rather than counted as free', () => {
  const lines = [
    { ingredientId: 'gin', qtyPerUnit: 1, wastageBp: 0 },
    { ingredientId: 'deleted', qtyPerUnit: 5, wastageBp: 0 },
  ];
  assert.equal(itemCost(lines, stock), 2000);
});

test('margin is the share of the PRICE kept, not the markup on cost', () => {
  // 50.00 sold, 25.00 to make: half the takings stay, so 50%.
  // Profit over cost would be 100% for the same drink, which is a markup and
  // is how a bar talks itself into thinking it is doing better than it is.
  const lines = [
    { ingredientId: 'gin', qtyPerUnit: 1, wastageBp: 0 },
    { ingredientId: 'tonic', qtyPerUnit: 1, wastageBp: 0 },
  ];
  const m = marginOf(5000, lines, stock);
  assert.equal(m.cost, 2500);
  assert.equal(m.profit, 2500);
  assert.equal(m.bp, 5000);
  assert.equal(m.unknown, false);
});

test('a drink sold under what it costs shows a negative margin rather than nothing', () => {
  const lines = [{ ingredientId: 'gin', qtyPerUnit: 2, wastageBp: 0 }];  // 40.00
  const m = marginOf(3000, lines, stock);
  assert.equal(m.profit, -1000);
  assert.equal(m.bp, -3333);
  assert.equal(marginIsThin(m), true);
});

test('no recipe is an unanswered question, not a thin margin', () => {
  // Colouring these red would train people to ignore the colour on the real
  // ones.
  const m = marginOf(5000, [], stock);
  assert.equal(m.unknown, true);
  assert.equal(marginIsThin(m), false);
  assert.equal(marginIsThin(m, 9000), false, 'not even at a punishing threshold');
});

test('the line is thirty percent unless the house moves it', () => {
  assert.equal(MARGIN_WARN_BP_DEFAULT, 3000);
  const lines = [{ ingredientId: 'tonic', qtyPerUnit: 1, wastageBp: 0 }]; // 5.00
  const thin = marginOf(700, lines, stock);   // 2.00 of 7.00 = 28.5%
  const fine = marginOf(800, lines, stock);   // 3.00 of 8.00 = 37.5%
  assert.equal(marginIsThin(thin), true);
  assert.equal(marginIsThin(fine), false);
  // And the house can demand more.
  assert.equal(marginIsThin(fine, 5000), true);
});

test('exactly on the line is not below it', () => {
  const lines = [{ ingredientId: 'tonic', qtyPerUnit: 1, wastageBp: 0 }]; // 5.00
  const m = marginOf(1000, lines, stock);  // 5.00 of 10.00 = 50%
  assert.equal(m.bp, 5000);
  assert.equal(marginIsThin(m, 5000), false, '50% does not fail a 50% rule');
  assert.equal(marginIsThin(m, 5001), true);
});

test('a free item has no margin rather than an impossible one', () => {
  const m = marginOf(0, [{ ingredientId: 'gin', qtyPerUnit: 1, wastageBp: 0 }], stock);
  assert.equal(m.bp, 0, 'not a division by zero');
  assert.equal(m.profit, -2000, 'it still costs what it costs');
});

test('percentages read as percentages', () => {
  assert.equal(bpAsPercent(3000), '30%');
  assert.equal(bpAsPercent(-3333), '-33%');
});
