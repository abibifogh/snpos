import test from 'node:test';
import assert from 'node:assert/strict';
import {
  purchaseLocation, saleLocation, openIn, levelFor, totalFor,
  transferQty, transferProblem, overdrawn, locationForMovement, transferMovements,
  type StockLocation, type LocationStock, type TransferLine,
} from '../locations.ts';

const store: StockLocation = { $id: 'L1', name: 'Store room', kind: 'store', module: 'bar', sort: 1 };
const bar: StockLocation = { $id: 'L2', name: 'The bar', kind: 'counter', module: 'bar', sort: 2 };
const kitchen: StockLocation = { $id: 'L3', name: 'Larder', kind: 'store', module: 'kitchen' };
const all = [store, bar, kitchen];

test('a delivery lands in the store and a sale comes off the counter', () => {
  assert.equal(purchaseLocation(all, 'bar')?.$id, 'L1');
  assert.equal(saleLocation(all, 'bar')?.$id, 'L2');
  // Each side keeps its own places: a bar delivery never lands in the larder.
  assert.equal(purchaseLocation(all, 'kitchen')?.$id, 'L3');
});

test('one place answers both questions, which is how nothing has to be set up', () => {
  /**
   * A kitchen that has never heard of a store room has one location, and every
   * rule here resolves to it. That is what lets locations be added to a live
   * system without anybody configuring anything first.
   */
  const only = [{ $id: 'X', name: 'Kitchen', kind: 'counter' as const }];
  assert.equal(purchaseLocation(only)?.$id, 'X', 'no room labelled store, so the counter takes the delivery');
  assert.equal(saleLocation(only)?.$id, 'X');

  // And no places at all is not a crash; the caller falls back to the old
  // single-number behaviour.
  assert.equal(purchaseLocation([], 'bar'), null);
  assert.equal(saleLocation([], 'bar'), null);
});

test('archived places are off every list that offers a choice', () => {
  const shut = { ...store, active: false };
  assert.deepEqual(openIn([shut, bar], 'bar').map((l) => l.$id), ['L2']);
  assert.equal(purchaseLocation([shut, bar], 'bar')?.$id, 'L2', 'falls through to what is open');
});

test('a level is per place, and the total is the sum of them', () => {
  /**
   * The ordering that matters. A total kept as its own number drifts away from
   * the places it claims to add up, and the drift is invisible because both
   * figures look authoritative.
   */
  const levels: LocationStock[] = [
    { ingredient_id: 'tonic', location_id: 'L1', qty: 33 },
    { ingredient_id: 'tonic', location_id: 'L2', qty: 9 },
    { ingredient_id: 'gin', location_id: 'L2', qty: 2 },
  ];
  assert.equal(levelFor(levels, 'tonic', 'L2'), 9, 'what the bar has');
  assert.equal(totalFor(levels, 'tonic'), 42, 'what the business has');
  // Absent means none, not unknown: a place that has never held a thing holds
  // none of it.
  assert.equal(levelFor(levels, 'gin', 'L1'), 0);
  assert.equal(totalFor(levels, 'rum'), 0);
});

test('a transfer to the place it already is, is refused', () => {
  const line: TransferLine = { ingredientId: 'i', name: 'Tonic', unit: 'bottle', available: 10, qtyText: '4' };
  assert.equal(transferProblem(store, bar, [line]), null);
  assert.match(transferProblem(store, store, [line]) ?? '', /both ends/);
  assert.match(transferProblem(null, bar, [line]) ?? '', /coming from/);
  assert.match(transferProblem(store, bar, [{ ...line, qtyText: '' }]) ?? '', /Nothing to move/);
});

test('moving more than the book says is warned about, never refused', () => {
  /**
   * Somebody standing in the store room holding four cases the system says are
   * three is looking at the answer. A system that argues is one they route
   * around by not recording the transfer at all, and an unrecorded transfer is
   * worse than an optimistic one — the count settles it either way.
   */
  const lines: TransferLine[] = [
    { ingredientId: 'a', name: 'Tonic', unit: 'bottle', available: 3, qtyText: '4' },
    { ingredientId: 'b', name: 'Soda', unit: 'bottle', available: 10, qtyText: '2' },
  ];
  assert.equal(transferProblem(store, bar, lines), null, 'it still goes through');
  assert.deepEqual(overdrawn(lines).map((l) => l.name), ['Tonic']);
});

test('a quantity has to be a positive number somebody typed', () => {
  const l = (qtyText?: string): TransferLine => ({ ingredientId: 'a', name: 'x', unit: 'bottle', available: 5, qtyText });
  assert.equal(transferQty(l('4')), 4);
  assert.equal(transferQty(l('0.5')), 0.5, 'half a bottle is a real transfer');
  assert.equal(transferQty(l()), null);
  assert.equal(transferQty(l('  ')), null);
  assert.equal(transferQty(l('0')), null, 'moving nothing is not moving');
  assert.equal(transferQty(l('-2')), null, 'a transfer has a direction already');
  assert.equal(transferQty(l('lots')), null);
});

test('one rule decides where each kind of movement lands', () => {
  /**
   * The alternative is each screen deciding for itself, and the day the till
   * decides a sale comes off the store while the count checks the counter is
   * the day the two stop being reconcilable, with nothing on screen to say
   * which is wrong.
   */
  assert.equal(locationForMovement('purchase', all, 'bar')?.$id, 'L1');
  assert.equal(locationForMovement('sale_depletion', all, 'bar')?.$id, 'L2');
  assert.equal(locationForMovement('waste', all, 'bar')?.$id, 'L2');
  // A count names its own place: somebody was standing somewhere, and guessing
  // the room would move stock they never looked at.
  assert.equal(locationForMovement('count_correction', all, 'bar'), null);
  assert.equal(locationForMovement('adjustment', all, 'bar'), null);
});

test('a transfer is one act with two ends, never a subtraction and an addition', () => {
  /**
   * Produced as a pair from one description so neither can exist without the
   * other. A transfer recorded as two independent movements can half-fail, and
   * stock that exists in neither place is the hardest discrepancy to find:
   * every individual number looks plausible and only the total is wrong.
   */
  const pair = transferMovements({ fromId: 'L1', toId: 'L2', ingredientId: 'i', qty: 4, unitCost: 100 });
  assert.equal(pair.length, 2);
  assert.deepEqual(pair.map((m) => m.qty_delta), [-4, 4]);
  assert.equal(pair[0].location_id, 'L1');
  assert.equal(pair[0].to_location_id, 'L2');
  assert.equal(pair[1].location_id, 'L2');
  assert.equal(pair.reduce((s, m) => s + m.qty_delta, 0), 0, 'the business owns exactly as much as before');

  // A negative quantity cannot reverse it: direction is the from and the to.
  assert.deepEqual(
    transferMovements({ fromId: 'L1', toId: 'L2', ingredientId: 'i', qty: -4, unitCost: 0 }).map((m) => m.qty_delta),
    [-4, 4],
  );
});
