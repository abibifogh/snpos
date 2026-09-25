import test from 'node:test';
import assert from 'node:assert/strict';
import {
  batchQty, usedInputs, batchProblem, shortInputs, batchCost, batchUnitCost, crossSideValue,
  prefillFrom, storedInputs, batchWords, type BatchInput,
} from '../batch-rules.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

/** Sugar from the kitchen's store room, at GH₵12 a kilo. */
const input = (over: Partial<BatchInput> = {}): BatchInput => ({
  ingredientId: 'sugar', name: 'Sugar', unit: 'kg', module: 'kitchen',
  locationId: 'kitchen-store', available: 10, unitCost: 1_200, qtyText: '3', ...over,
});

test('a batch needs what was made, how much, and where it went', () => {
  assert.match(String(batchProblem({ inputs: [] })), /what was made/);
  assert.match(String(batchProblem({ madeId: 'sobolo', inputs: [] })), /how much was made/);
  assert.match(String(batchProblem({ madeId: 'sobolo', madeQtyText: '24', inputs: [] })), /store room or the bar/);
  assert.equal(batchProblem({ madeId: 'sobolo', madeQtyText: '24', locationId: 'bar', inputs: [] }), null);
});

test('what went in is optional', () => {
  /*
    A drink whose ingredients were bought at the market and never stocked has
    nothing on any shelf to take off. Refusing it would leave it off the shelf
    altogether, which is the problem this exists to fix.
  */
  assert.equal(batchProblem({ madeId: 'sobolo', madeQtyText: '24', locationId: 'bar', inputs: [] }), null);
});

test('a batch cannot use the drink it makes', () => {
  const p = batchProblem({
    madeId: 'sobolo', madeQtyText: '24', locationId: 'bar',
    inputs: [input({ ingredientId: 'sobolo', name: 'Sobolo' })],
  });
  assert.match(String(p), /cannot use the drink it makes/);
});

test('the same thing from the same place twice is one line, not two', () => {
  const p = batchProblem({
    madeId: 'sobolo', madeQtyText: '24', locationId: 'bar',
    inputs: [input(), input({ qtyText: '1' })],
  });
  assert.match(String(p), /Sugar is listed twice/);
  // From two different places is two honest lines.
  assert.equal(batchProblem({
    madeId: 'sobolo', madeQtyText: '24', locationId: 'bar',
    inputs: [input(), input({ locationId: 'bar-store' })],
  }), null);
});

test('a blank row is a row nobody used', () => {
  assert.deepEqual(usedInputs([input({ qtyText: '' }), input({ qtyText: '0' }), input({ qtyText: 'x' })]), []);
  assert.equal(batchQty(' 2.5 '), 2.5);
  assert.equal(batchQty('-1'), null);
});

test('using more than the shelf says it holds is warned about, not refused', () => {
  // The person with the sugar in front of them is looking at the answer.
  assert.deepEqual(shortInputs([input({ qtyText: '12', available: 10 })]).map((i) => i.name), ['Sugar']);
  assert.deepEqual(shortInputs([input()]), []);
});

test('the batch costs what went into it, spread over what came out', () => {
  // 3 kg sugar at 12, 2 kg hibiscus at 40: GH₵116 for 24 bottles.
  const inputs = [input(), input({ ingredientId: 'hib', name: 'Hibiscus', unitCost: 4_000, qtyText: '2' })];
  const total = batchCost(inputs);
  assert.equal(total, 11_600);
  assert.equal(batchUnitCost(total, 24), 483, 'GH₵4.83 a bottle, rounded to the pesewa');
  assert.equal(batchUnitCost(0, 24), 0, 'nothing listed, nothing to spread');
  assert.equal(batchUnitCost(11_600, 0), 0);
});

test('only value that crosses sides needs posting', () => {
  /*
    Kitchen sugar made into a bar drink leaves the kitchen's inventory and
    joins the bar's. Without the entry, the bar's account is credited drink by
    drink for value it was never given and runs below nothing.
  */
  const inputs = [
    input(),                                                      // kitchen, 3 x 1200
    input({ ingredientId: 'hib', unitCost: 4_000, qtyText: '2' }), // kitchen, 2 x 4000
    input({ ingredientId: 'rum', module: 'bar', unitCost: 9_000, qtyText: '1' }),
  ];
  assert.deepEqual(crossSideValue(inputs, 'bar'), [{ module: 'kitchen', value: 11_600 }]);
  // The bar's own rum moves within the bar's account: nothing to post.
  assert.deepEqual(crossSideValue([input({ module: 'bar' })], 'bar'), []);
});

test('an input from before sides existed counts as the kitchen\'s', () => {
  assert.deepEqual(crossSideValue([input({ module: undefined })], 'bar'), [{ module: 'kitchen', value: 3_600 }]);
});

/* ------------------------------------------------------ the next batch */

test('the next batch starts from the last one, scaled', () => {
  // A recipe nobody had to type: last week 3 kg for 24 bottles, now 30.
  const last = { made_qty: 24, inputs: storedInputs([input()]) };
  const rows = prefillFrom(last, 30);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.ingredientId, 'sugar');
  assert.equal(rows[0]?.qtyText, '3.75');
  assert.equal(rows[0]?.locationId, 'kitchen-store', 'from the same place as last time');
});

test('scaled figures are rounded, not sixteen decimals long', () => {
  const last = { made_qty: 24, inputs: storedInputs([input({ qtyText: '2' })]) };
  assert.equal(prefillFrom(last, 30)[0]?.qtyText, '2.5');
  assert.equal(prefillFrom(last, 7)[0]?.qtyText, '0.583');
});

test('before a quantity is typed, last time\'s amounts are offered as they were', () => {
  const last = { made_qty: 24, inputs: storedInputs([input()]) };
  assert.equal(prefillFrom(last, null)[0]?.qtyText, '3');
});

test('no previous batch, or a damaged one, starts empty rather than failing', () => {
  assert.deepEqual(prefillFrom(null, 24), []);
  assert.deepEqual(prefillFrom({ made_qty: 24, inputs: 'not json' }, 24), []);
  assert.deepEqual(prefillFrom({ made_qty: 24, inputs: '{}' }, 24), []);
});

test('what is stored keeps the cost each input was taken at', () => {
  const stored = JSON.parse(storedInputs([input(), input({ ingredientId: 'x', qtyText: '' })]));
  assert.equal(stored.length, 1, 'blank rows are not kept');
  assert.deepEqual(stored[0], {
    ingredient_id: 'sugar', name: 'Sugar', unit: 'kg', qty: 3, location_id: 'kitchen-store',
    module: 'kitchen', unit_cost: 1_200,
  });
});

/* -------------------------------------------------------------- the words */

test('the summary says what it cost, each', () => {
  const w = batchWords({
    madeName: 'Sobolo', madeQty: 24, unit: 'bottle', placeName: 'Bar store', total: 11_600, inputsCount: 2, money,
  });
  assert.match(w, /24 bottle of Sobolo into Bar store/);
  assert.match(w, /costing GH₵116\.00 \(GH₵4\.83 each\)/);
  assert.match(w, /2 ingredients come off the shelf/);
});

test('a batch with nothing listed says what that does to its margin', () => {
  // Not a guessed figure: the honest consequence, so a report reading 100%
  // margin is not a mystery to whoever reads it.
  const w = batchWords({
    madeName: 'Sobolo', madeQty: 24, unit: 'bottle', placeName: 'Bar', total: 0, inputsCount: 0, money,
  });
  assert.match(w, /at no cost/);
  assert.match(w, /margin will read as all profit/);
});
