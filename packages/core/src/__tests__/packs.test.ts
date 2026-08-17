import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasPack, packSize, buyOptions, defaultBuyOption,
  toCountingUnits, costPerCountingUnit, convertPurchase, describePurchase, packProblem,
} from '../packs.ts';

/*
  28 rather than the house's real 15, on purpose.

  The point of these numbers is a division that does NOT come out even:
  GHS 300 over 28 shots is 10.7142..., which is what proves the money is
  rounded once and the remainder handled. 300 over 15 is exactly 20, and
  swapping it in would leave the rounding assertions passing while testing
  nothing.
*/
const havana = { unit: 'shot', pack_size: 28, pack_name: 'bottle' };
const rice = { unit: 'kg' };

test('an ingredient with no pack behaves exactly as it always did', () => {
  assert.equal(hasPack(rice), false);
  assert.equal(packSize(rice), 1);
  // One option means the form has nothing worth asking.
  assert.deepEqual(buyOptions(rice), [{ key: 'unit', label: 'kg', per: 1 }]);
});

test('a pack of one is not a pack', () => {
  // Somebody setting 1 means "I buy them singly", not "ask me every time".
  assert.equal(hasPack({ unit: 'each', pack_size: 1, pack_name: 'each' }), false);
});

test('buying is offered by the pack first, because that is why it was set', () => {
  assert.deepEqual(defaultBuyOption(havana), { key: 'pack', label: 'bottles', per: 28 });
  assert.deepEqual(buyOptions(havana)[1], { key: 'unit', label: 'shots', per: 1 });
});

test('two bottles reach the shelf as fifty-six shots', () => {
  assert.equal(toCountingUnits(2, 28), 56);
});

test('half a crate is a real thing somebody types', () => {
  assert.equal(toCountingUnits(0.5, 24), 12);
});

test('a price per bottle is stored as a price per shot', () => {
  // GHS 300 a bottle, 28 shots: 10.7142... a shot, to the pesewa.
  assert.equal(costPerCountingUnit(30_000, 28), 1071);
});

test('the money handed over is not the rounded unit price multiplied back', () => {
  const got = convertPurchase({ qty: 2, costPerBought: 30_000, per: 28 });
  assert.equal(got.qty, 56);
  assert.equal(got.unitCost, 1071);
  // 2 x GHS 300 exactly, not 56 x 10.71 = GHS 599.76. The receipt is the truth.
  assert.equal(got.lineTotal, 60_000);
});

test('the arithmetic is said out loud before it is saved', () => {
  const money = (m: number) => `GHS ${(m / 100).toFixed(2)}`;
  assert.equal(
    describePurchase({ qty: 2, option: defaultBuyOption(havana), ing: havana, money, unitCost: 1071 }),
    '2 bottles = 56 shots on the shelf, at GHS 10.71 a shot.',
  );
});

test('nothing is said when buying in the counting unit, because nothing converts', () => {
  const money = (m: number) => `GHS ${m}`;
  assert.equal(
    describePurchase({ qty: 5, option: buyOptions(havana)[1], ing: havana, money }),
    '',
  );
});

test('a pack of nought is refused rather than defaulted', () => {
  // Defaulting here divides a price by nothing and empties the shelf silently.
  assert.match(packProblem(0.5, 'shot', 'bottle') ?? '', /at least one/);
  assert.match(packProblem(-3, 'shot', 'bottle') ?? '', /less than none/);
  assert.match(packProblem(Number.NaN, 'shot', 'bottle') ?? '', /has to be a number/);
});

test('a pack needs a name, or the buying form has nothing to ask for', () => {
  assert.match(packProblem(28, 'shot', '  ') ?? '', /Say what the pack is called/);
});

test('a pack named after the counting unit is caught', () => {
  // "28 bottles in one bottle" is somebody misreading the form, and it would
  // multiply the shelf by 28 without ever looking wrong.
  assert.match(packProblem(28, 'bottle', 'bottle') ?? '', /Give the pack its own name/);
});

test('an ordinary pack passes', () => {
  assert.equal(packProblem(28, 'shot', 'bottle'), null);
  assert.equal(packProblem(0, 'kg', ''), null);
});

test('a nonsense pack size cannot divide a price to infinity', () => {
  assert.equal(costPerCountingUnit(30_000, 0), 0);
  assert.equal(toCountingUnits(2, 0), 0);
});
