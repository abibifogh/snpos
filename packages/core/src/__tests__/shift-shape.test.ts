import test from 'node:test';
import assert from 'node:assert/strict';
import { ordersForSide, shelfCheckSummary } from '../../../../functions/notify/src/shift-shape.js';

/* --------------------------------------------- whose orders were they */

const order = (id: string, module?: string) => ({ $id: id, ...(module ? { module } : {}) });

test('the bar is not in the bistro’s closing summary', () => {
  /*
    The report: closing the bistro listed the bartender under "who did what",
    with the bar's bills against their name, on a summary headed with the
    bistro's takings. The window query asks for every order at the venue
    between two times, and the bar is open during the bistro's hours.
  */
  const inWindow = [
    order('a', 'kitchen'),
    order('b', 'bar'),
    order('c', 'craft'),
    order('d', 'kitchen'),
  ];
  const mine = ordersForSide(inWindow, [], 'kitchen').map((o) => o.$id);
  assert.deepEqual(mine, ['a', 'd']);

  // And the bar's own close sees the bar's, not the kitchen's.
  assert.deepEqual(ordersForSide(inWindow, [], 'bar').map((o) => o.$id), ['b']);
  assert.deepEqual(ordersForSide(inWindow, [], 'craft').map((o) => o.$id), ['c']);
});

test('an order stamped with this shift is kept whatever it says', () => {
  /*
    The stamp is put on by the payment, so it is the shift's own record of
    what it settled. Dropping it on the strength of a field would leave money
    in the takings with no order behind it.
  */
  const kept = ordersForSide([], [order('x', 'bar')], 'kitchen');
  assert.deepEqual(kept.map((o) => o.$id), ['x']);
});

test('an order that is both created and settled here is one order', () => {
  const both = ordersForSide([order('a', 'kitchen')], [order('a', 'kitchen')], 'kitchen');
  assert.equal(both.length, 1);
});

test('an order written before sides existed is the kitchen’s, which is what it was', () => {
  assert.deepEqual(ordersForSide([order('old')], [], 'kitchen').map((o) => o.$id), ['old']);
  assert.deepEqual(ordersForSide([order('old')], [], 'bar'), []);
  // And a shift with no side recorded reads as the kitchen too.
  assert.deepEqual(ordersForSide([order('old')], [], undefined).map((o) => o.$id), ['old']);
});

/* ------------------------------------------- what was on the shelves */

const names = new Map([['i1', 'Rice'], ['i2', 'Tomatoes'], ['i3', 'Momoni'], ['i4', 'Anchovies']]);
const check = (ingredient_id: string, status: string) => ({ ingredient_id, status });

test('the shelves are reported whatever the answer, including a good night', () => {
  /*
    The stock table lists exceptions only, so a shift where everything was
    fine printed nothing — which on the page reads the same as the section
    being broken, and the same as nobody having been asked. All three were
    printing the same silence.
  */
  const all = shelfCheckSummary([check('i1', 'OK'), check('i2', 'OK')], names);
  assert.deepEqual(all, { total: 2, ok: 2, low: 0, out: 0, lowNames: [], outNames: [] });
});

test('low and out are counted apart and named', () => {
  const s = shelfCheckSummary(
    [check('i1', 'OK'), check('i2', 'LOW'), check('i3', 'OUT'), check('i4', 'OUT')],
    names,
  );
  assert.equal(s.total, 4);
  assert.equal(s.ok, 1);
  assert.equal(s.low, 1);
  assert.equal(s.out, 2);
  // Alphabetical, so the same shelves read the same way every night.
  assert.deepEqual(s.outNames, ['Anchovies', 'Momoni']);
  assert.deepEqual(s.lowNames, ['Tomatoes']);
});

test('nothing filed is nothing claimed', () => {
  // Which the email says in words, rather than printing "0 ok" as if somebody
  // had looked and found nothing wrong.
  assert.deepEqual(shelfCheckSummary([], names), {
    total: 0, ok: 0, low: 0, out: 0, lowNames: [], outNames: [],
  });
});

test('an ingredient nobody can name is still counted', () => {
  // Deleted since, or a row pointing at nothing. Losing the count would
  // understate what was checked.
  const s = shelfCheckSummary([check('gone', 'OUT')], names);
  assert.equal(s.out, 1);
  assert.deepEqual(s.outNames, ['an item']);
});

test('a status nobody recognises is not silently counted as a shortage', () => {
  // Guessing "out" would raise an alarm nobody reported.
  const s = shelfCheckSummary([check('i1', 'something else')], names);
  assert.equal(s.ok, 1);
  assert.equal(s.out, 0);
  assert.equal(s.low, 0);
});
