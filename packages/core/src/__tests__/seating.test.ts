import test from 'node:test';
import assert from 'node:assert/strict';
import { seatName, seatFor } from '../seating.ts';

test('a place with a name keeps its name, whatever the record says', () => {
  /**
   * The owner's seating is "Lounge", "Poolside", "Notice board area". The
   * `kind` field defaults to 'table', so a place added quickly carries that
   * default and would otherwise be announced as "Table Notice board area".
   * The label the owner typed is the better evidence of what they meant.
   */
  assert.equal(seatName({ label: 'Lounge' }), 'Lounge');
  assert.equal(seatName({ label: 'Poolside', kind: 'table' }), 'Poolside');
  assert.equal(seatName({ label: 'Notice board area', kind: 'table' }), 'Notice board area');
  assert.equal(seatName({ label: 'Bar' , kind: 'area' }), 'Bar');
});

test('a table number is still called a table', () => {
  // "7" alone on a ticket has to be interpreted before it can be acted on.
  assert.equal(seatName({ label: '7' }), 'Table 7');
  assert.equal(seatName({ label: '12b' }), 'Table 12b');
  assert.equal(seatName({ label: 'A4', kind: 'table' }), 'Table A4');
  assert.equal(seatName({ label: ' 7 ' }), 'Table 7', 'a stray space is not a name');
});

test('the part of the room comes after the place, because names repeat', () => {
  assert.equal(seatName({ label: 'Lounge', zone: 'Upstairs' }), 'Lounge · Upstairs');
  assert.equal(seatName({ label: '3', zone: 'Garden' }), 'Table 3 · Garden');
});

test('an order with nowhere to sit says what it actually is', () => {
  assert.equal(seatFor({ fulfilment: 'takeaway' }, {}), 'Takeaway');
  assert.equal(seatFor({ fulfilment: 'delivery' }, {}), 'Delivery');
  // A table that cannot be looked up is still a table order; better thin than
  // silent, and far better than inventing a name.
  assert.equal(seatFor({ table_id: 'gone', fulfilment: 'dine_in' }, {}), 'Table order');
  assert.equal(seatName({ label: '' }), 'Table order');
});

test('the ticket says exactly what the guest picked', () => {
  // The dropdown and the ticket call seatName on the same row, so this is the
  // whole of the promise: one name, chosen once, read at the pass.
  const seating = { t1: { label: 'Poolside', zone: 'Garden' }, t2: { label: '7' } };
  assert.equal(seatFor({ table_id: 't1' }, seating), seatName(seating.t1));
  assert.equal(seatFor({ table_id: 't2' }, seating), 'Table 7');
});
