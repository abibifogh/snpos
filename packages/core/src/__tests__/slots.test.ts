import test from 'node:test';
import assert from 'node:assert/strict';
import {
  seatId, placeKey, slotStamp, slotIsFull, placesLeft, slotWords, placeOrder,
  SlotFull, isSlotFull, NO_LIMIT,
} from '../slots.ts';

const noon = new Date('2026-09-10T12:00:00.000Z');

test('the same slot works out the same place id everywhere, and different slots never share one', () => {
  assert.equal(seatId('main', 'counter', noon, 7), seatId('main', 'counter', new Date(noon), 7));
  // Under Appwrite's 36 characters, and letters, digits and hyphens only.
  const id = seatId('main', 'counter', noon, 7);
  assert.ok(id.length <= 36, id);
  assert.match(id, /^[A-Za-z0-9][A-Za-z0-9-]*$/);
  // The minute is spelt out, so two times cannot collide however the hash falls.
  assert.equal(slotStamp(noon), '202609101200');
  assert.notEqual(seatId('main', 'counter', noon, 7), seatId('main', 'counter', new Date('2026-09-10T12:15:00Z'), 7));
  assert.notEqual(seatId('main', 'counter', noon, 7), seatId('main', 'counter', noon, 8));
  assert.notEqual(seatId('main', 'counter', noon, 7), seatId('main', 'window', noon, 7));
  assert.notEqual(seatId('main', 'counter', noon, 7), seatId('other', 'counter', noon, 7));
});

test('a place id does not depend on the device’s clock being set to Accra', () => {
  // Same instant written two ways. A phone in another timezone must claim the
  // same place as the till standing in the restaurant.
  assert.equal(
    seatId('main', undefined, new Date('2026-09-10T12:00:00Z'), 1),
    seatId('main', undefined, new Date('2026-09-10T14:00:00+02:00'), 1),
  );
});

test('the hash is stable, so an id written today is the same id next year', () => {
  assert.equal(placeKey('main', 'counter'), placeKey('main', 'counter'));
  assert.equal(placeKey('main', ''), placeKey('main', undefined));
  assert.equal(placeKey('main', 'counter').length, 7);
});

test('a capacity of nought is no limit at all', () => {
  assert.equal(slotIsFull(999, NO_LIMIT), false);
  assert.equal(placesLeft(999, NO_LIMIT), Infinity);
  assert.equal(slotWords(999, NO_LIMIT), '');
  assert.deepEqual(placeOrder(3, NO_LIMIT), []);
});

test('a slot fills up and says so', () => {
  assert.equal(slotIsFull(19, 20), false);
  assert.equal(slotIsFull(20, 20), true);
  // Over capacity, which a released and re-taken place could briefly produce.
  assert.equal(slotIsFull(21, 20), true);
  assert.equal(placesLeft(20, 20), 0);
});

test('the picker says something only when it changes what you would pick', () => {
  assert.equal(slotWords(0, 20), '');
  assert.equal(slotWords(16, 20), '');
  assert.equal(slotWords(17, 20), '3 places left');
  assert.equal(slotWords(19, 20), '1 place left');
  assert.equal(slotWords(20, 20), 'full');
});

test('places are tried after the ones already booked, then from the start for a gap', () => {
  assert.deepEqual(placeOrder(0, 3), [1, 2, 3]);
  assert.deepEqual(placeOrder(2, 3), [3, 1, 2]);
  // A cancelled booking leaves a hole, and the count no longer names a free
  // place; every place is still tried, so the hole gets used.
  assert.deepEqual(placeOrder(1, 3), [2, 1, 3]);
  // A count past the cap still names a place inside it rather than none.
  assert.deepEqual(placeOrder(9, 3), [3, 1, 2]);
});

test('a full slot is told apart from something going wrong', () => {
  assert.equal(isSlotFull(new SlotFull()), true);
  assert.equal(isSlotFull(new Error('the network went away')), false);
  assert.equal(isSlotFull(null), false);
  assert.match(new SlotFull().message, /pick another time/);
});
