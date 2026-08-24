import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inRun, numberIn, nextInRun, formatOrderNo } from '../order-numbers.ts';

test('two sides sharing a prefix share the run', () => {
  /*
    THE BUG THIS FILE EXISTS FOR.

    The bar had no prefix of its own, so it shared the kitchen's — and counted
    only its own orders. The kitchen was at ORD0222; the bar asked for ORD0006
    on its sixth drink, which the kitchen used months ago. The database refuses
    a number twice, so the bar could not take money at all.

    The run is everything carrying the prefix, whichever side rang it up.
  */
  const kitchenAndBar = ['ORD0222', 'ORD0221', 'ORD0006', 'ORD0005'];
  assert.equal(nextInRun(kitchenAndBar, 'ORD'), 223);
});

test('a side with its own prefix keeps its own run', () => {
  // Which is the thing the original split got right, and this keeps: a shop
  // receipt and a restaurant receipt should not look alike or sort together.
  const all = ['ORD0222', 'S0004', 'S0003'];
  assert.equal(nextInRun(all, 'S'), 5);
  assert.equal(nextInRun(all, 'ORD'), 223);
});

test('an empty prefix does not swallow a prefixed run', () => {
  /*
    The case that needs care. "Starts with an empty string" is true of every
    number ever issued, so a business with no prefix would count the craft
    shop's S0004 as its own and jump to 5 — or, worse, read the letter as part
    of a number.
  */
  assert.equal(inRun('S0004', ''), false);
  assert.equal(inRun('0006', ''), true);
  assert.equal(nextInRun(['S0009', '0006'], ''), 7);
});

test('the highest wins, not the newest', () => {
  /*
    A run only ever goes up. Reading the most recently created row assumes the
    clock and the counter agree about order, and they do not: two tills ring up
    a sale in the same second, and a guest's order is settled by the server a
    moment after a later one was typed at the counter.
  */
  assert.equal(nextInRun(['ORD0007', 'ORD0100', 'ORD0009'], 'ORD'), 101);
});

test('a number the server has not settled counts towards nothing', () => {
  // A placeholder is not a number. Counting one would hand the next customer
  // an order number derived from a mark, and lose the real sequence.
  assert.equal(inRun('~abc123', 'ORD'), false);
  assert.equal(nextInRun(['~abc123'], 'ORD', 1), 1);
});

test('an empty run starts where the business said', () => {
  // A house moving over from a paper book carries on from where the book
  // stopped, rather than starting again at one beside it.
  assert.equal(nextInRun([], 'ORD', 500), 500);
  assert.equal(nextInRun([], 'ORD'), 1);
  // And never below one, whatever is in the setting.
  assert.equal(nextInRun([], 'ORD', 0), 1);
});

test('a retry steps past the number that was refused', () => {
  /*
    How the retry gets anywhere. Without this a second attempt works out the
    same number as the first and fails in exactly the same way — which is what
    turned one collision into five identical failures and an error message
    about attribute constraints.
  */
  assert.equal(nextInRun(['ORD0006'], 'ORD', 1, 0), 7);
  assert.equal(nextInRun(['ORD0006'], 'ORD', 1, 1), 8);
  assert.equal(nextInRun(['ORD0006'], 'ORD', 1, 3), 10);
});

test('a prefix with digits in it is not counted as part of the number', () => {
  // "B2-" is a legitimate prefix. Reading the 2 as part of the count would
  // put every order in the two-thousands and never repeat the same way twice.
  assert.equal(numberIn('B2-0004', 'B2-'), 4);
  assert.equal(nextInRun(['B2-0004'], 'B2-'), 5);
});

test('the printed number is padded to the house width', () => {
  assert.equal(formatOrderNo('ORD', 7, 4), 'ORD0007');
  assert.equal(formatOrderNo('', 7, 4), '0007');
  // A number wider than the padding is not truncated: an order number that
  // loses a digit is a different order.
  assert.equal(formatOrderNo('ORD', 12345, 4), 'ORD12345');
});
