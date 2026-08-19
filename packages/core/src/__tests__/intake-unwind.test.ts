import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pieceFate, planUnwind, describeUnwind, stockDelta, changed,
} from '../intake-unwind.ts';

const piece = (over: Record<string, unknown>) => ({ $id: 'p', name: 'Bowl', ...over });

test('only a sale saves a piece from deletion', () => {
  assert.equal(pieceFate(true), 'archive');
  assert.equal(pieceFate(false), 'delete');
});

test('stock on the shelf is NOT a reason to keep a piece here', () => {
  // The opposite of the ordinary product-deletion rule, and deliberately so.
  // The delivery is being undone because it did not happen, so the pieces were
  // never there and the count must stop saying they were. Protecting stock on
  // hand would leave a mistaken delivery's stock behind for ever.
  const plan = planUnwind([piece({ $id: 'a', on_hand: 5 })], () => false);
  assert.deepEqual(plan.remove.map((p) => p.$id), ['a']);
  assert.deepEqual(plan.keep, []);
});

test('a piece that has sold stays, because the sale points at it', () => {
  const plan = planUnwind([piece({ $id: 'a' }), piece({ $id: 'b' })], (id) => id === 'b');
  assert.deepEqual(plan.remove.map((p) => p.$id), ['a']);
  assert.deepEqual(plan.keep.map((p) => p.$id), ['b']);
});

test('the plan is said in words before anybody agrees to it', () => {
  const plan = planUnwind([piece({ $id: 'a', on_hand: 3 }), piece({ $id: 'b' })], (id) => id === 'b');
  const said = describeUnwind(plan);
  assert.match(said, /1 piece deleted, taking 3 off the shelf/);
  assert.match(said, /1 has already sold/);
});

test('nothing on the shelf is not mentioned as coming off it', () => {
  const said = describeUnwind(planUnwind([piece({ $id: 'a', on_hand: 0 })], () => false));
  assert.equal(/off the shelf/.test(said), false);
});

test('an empty delivery says so rather than saying nothing', () => {
  assert.match(describeUnwind(planUnwind([], () => false)), /no pieces left/);
});

test('a correction downwards is a negative movement', () => {
  assert.equal(stockDelta(5, 3), -2);
  assert.equal(stockDelta(3, 5), 2);
  assert.equal(stockDelta(4, 4), 0);
});

test('an edit that changes nothing writes nothing', () => {
  assert.equal(changed(4, 4), false);
  assert.equal(changed(4, 5), true);
});
