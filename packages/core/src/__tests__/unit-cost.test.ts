import test from 'node:test';
import assert from 'node:assert/strict';
import { weightedUnitCost } from '../unit-cost.ts';

test('a dear bottle moves the average by one bottle’s worth', () => {
  /*
    Forty on the shelf at 850, one bought at 1,200. The shelf used to be
    revalued at 1,200 outright, and the night's cost of sales jumped with it.
  */
  assert.equal(weightedUnitCost({ onHand: 40, currentCost: 850, boughtQty: 1, boughtCost: 1200 }), 859);
});

test('a big delivery at a new price mostly becomes the new price', () => {
  assert.equal(weightedUnitCost({ onHand: 2, currentCost: 850, boughtQty: 48, boughtCost: 1000 }), 994);
});

test('an empty shelf takes the delivery’s price outright', () => {
  assert.equal(weightedUnitCost({ onHand: 0, currentCost: 850, boughtQty: 12, boughtCost: 1000 }), 1000);
  // Oversold: the shelf shows less than nothing. A negative weight is nonsense.
  assert.equal(weightedUnitCost({ onHand: -3, currentCost: 850, boughtQty: 12, boughtCost: 1000 }), 1000);
});

test('a shelf that was never costed takes the first real price', () => {
  assert.equal(weightedUnitCost({ onHand: 30, currentCost: 0, boughtQty: 12, boughtCost: 1000 }), 1000);
});

test('a delivery with no price leaves the cost alone', () => {
  // A gift, a transfer, a stock adjustment: nothing was paid, so nothing
  // about what the shelf is worth has been learned.
  assert.equal(weightedUnitCost({ onHand: 30, currentCost: 850, boughtQty: 12, boughtCost: 0 }), 850);
  assert.equal(weightedUnitCost({ onHand: 30, currentCost: 850, boughtQty: 0, boughtCost: 1000 }), 850);
});
