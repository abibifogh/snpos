import test from 'node:test';
import assert from 'node:assert/strict';
import { readQty, settleQty, QTY_MOST } from '../quantity.ts';

test('a number typed in is the number, and nothing else is', () => {
  assert.equal(readQty('40'), 40);
  assert.equal(readQty(' 12 '), 12);
  // Whatever a phone keypad or a paste puts in there.
  assert.equal(readQty('4a0'), 40);
  assert.equal(readQty('1.5'), 15);
  assert.equal(readQty('-3'), 3);
});

test('an empty box means “still typing”, never nought', () => {
  /*
    The difference that makes the field editable at all. Reading an empty box
    as nought takes the line off the order the instant somebody selects the
    number to replace it, and they never get to type the new one.
  */
  assert.equal(readQty(''), null);
  assert.equal(readQty('   '), null);
  assert.equal(readQty('abc'), null);
});

test('a stray keystroke cannot reach the kitchen', () => {
  // "12" with a finger resting on the key is 1222222, and that lands on a
  // ticket, in the books, and as a hole in the shelf.
  assert.equal(readQty('1222222'), QTY_MOST);
  assert.equal(readQty('99999', 40), 40);
  assert.equal(readQty('0'), 0);
});

test('leaving the box settles it on something orderable', () => {
  assert.equal(settleQty('40'), 40);
  // Empty, or nought, where nought is not allowed.
  assert.equal(settleQty(''), 1);
  assert.equal(settleQty('0'), 1);
  assert.equal(settleQty('abc'), 1);
  // And where it is: typing over a quantity is how a line comes off an order,
  // rather than pressing minus until it disappears.
  assert.equal(settleQty('0', { least: 0 }), 0);
  assert.equal(settleQty('', { least: 0 }), 0);
  assert.equal(settleQty('9999', { least: 0, most: 60 }), 60);
});
