import test from 'node:test';
import assert from 'node:assert/strict';
import {
  median, flagPurchase, anyFlagged, describeFlag, isOutstanding,
  MIN_HISTORY, PRICE_RISE_BP, QTY_RISE_BP,
  type PastPurchase,
} from '../purchase-flags.ts';

const buy = (unitCost: number, qty = 10, at = '2026-08-01T10:00:00.000Z'): PastPurchase =>
  ({ at, qty, unitCost });

test('the baseline is the middle, so one silly entry cannot hide the next three', () => {
  /**
   * A purchase entered with an extra nought drags a mean far enough to hide
   * every mistake behind it. The median shrugs it off — which matters most
   * because the first thing a business finds with a new flag is the wrong
   * entry that has been sitting in the history all along.
   */
  assert.equal(median([100, 110, 120]), 110);
  assert.equal(median([100, 110, 120, 100_000]), 115, 'the outlier does not move it');
  assert.equal(median([100, 200]), 150);
  assert.equal(median([]), 0);
  // Nothing and negatives are not prices; they would drag the middle down and
  // stop real rises from ever clearing the threshold.
  assert.equal(median([0, 0, 100, 110, 120]), 110);
});

test('two purchases is not a pattern', () => {
  /**
   * With one prior purchase every second purchase of anything would be
   * measured against a single figure that might itself be the mistake — and a
   * warning firing on the second delivery of everything is one people learn to
   * dismiss before it ever means something.
   */
  assert.equal(MIN_HISTORY, 3);
  const dear = { unitCost: 100_000, qty: 10, name: 'Tomatoes' };
  assert.deepEqual(flagPurchase({ ...dear, history: [buy(100), buy(100)] }), []);
  assert.equal(flagPurchase({ ...dear, history: [buy(100), buy(100), buy(100)] }).length, 1);
});

test('a price well above the usual is asked about', () => {
  const flags = flagPurchase({
    unitCost: 300,
    qty: 10,
    name: 'Tomatoes',
    history: [buy(100), buy(110), buy(100), buy(105)],
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'price');
  // [100, 100, 105, 110] → the two middle values, 100 and 105, averaged.
  assert.equal(flags[0].typical, 103);
  assert.equal(flags[0].seen, 4);
  assert.match(flags[0].message, /Tomatoes normally costs about %TYPICAL% a unit/);
  // Never an instruction. It may well be right, and the words say so.
  assert.match(flags[0].message, /it may well be right/);
});

test('a price a little above the usual is not', () => {
  // Prices move. A threshold that fires on every rise fires every week, and a
  // warning that fires every week is one nobody reads.
  assert.equal(PRICE_RISE_BP, 4_000);
  assert.deepEqual(
    flagPurchase({ unitCost: 130, qty: 10, history: [buy(100), buy(100), buy(100)] }),
    [],
  );
  assert.equal(
    flagPurchase({ unitCost: 141, qty: 10, history: [buy(100), buy(100), buy(100)] }).length,
    1,
  );
});

test('buying far more than usual is its own question', () => {
  /**
   * A different mistake from a wrong price — "kg" typed where "g" was meant —
   * and invisible in the price figure, because the unit cost can be perfectly
   * ordinary while the quantity is out by a thousand.
   */
  const flags = flagPurchase({
    unitCost: 100,
    qty: 500,
    name: 'Rice',
    history: [buy(100, 10), buy(100, 12), buy(100, 10)],
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'qty');
  assert.equal(flags[0].typical, 10);
  assert.match(flags[0].message, /Check the unit and the quantity/);
});

test('quantities are allowed to be lumpier than prices', () => {
  // A kitchen buys one sack this week and three before a function, and neither
  // is a mistake. What this looks for is the missing decimal point.
  assert.equal(QTY_RISE_BP, 10_000);
  assert.deepEqual(
    flagPurchase({ unitCost: 100, qty: 18, history: [buy(100, 10), buy(100, 10), buy(100, 10)] }),
    [],
  );
  assert.equal(
    flagPurchase({ unitCost: 100, qty: 21, history: [buy(100, 10), buy(100, 10), buy(100, 10)] }).length,
    1,
  );
});

test('both surprises are reported, not the worst of them', () => {
  /**
   * A line three times the price AND ten times the quantity is almost
   * certainly a unit mix-up. Saying only one would send somebody to check the
   * wrong half of it.
   */
  const flags = flagPurchase({
    unitCost: 400,
    qty: 400,
    name: 'Oil',
    history: [buy(100, 10), buy(100, 10), buy(100, 10)],
  });
  assert.deepEqual(flags.map((f) => f.kind), ['price', 'qty']);
  assert.equal(anyFlagged([[], flags]), true);
  assert.equal(anyFlagged([[], []]), false);
});

test('a bargain is not a mistake worth interrupting anybody over', () => {
  // Only ever looks up. Flagging cheap purchases would double how often this
  // fires while halving what it means.
  assert.deepEqual(
    flagPurchase({ unitCost: 10, qty: 1, history: [buy(100, 10), buy(100, 10), buy(100, 10)] }),
    [],
  );
});

test('an ingredient with no usable history is never flagged', () => {
  // Prices of nothing are not prices. Reading them as a baseline would make
  // every first real purchase look like a hundredfold rise.
  assert.deepEqual(
    flagPurchase({ unitCost: 5_000, qty: 10, history: [buy(0), buy(0), buy(0), buy(0)] }),
    [],
  );
});

test('the alert reads the same next week as the question did at the market', () => {
  const money = (n: number) => `GH¢${(n / 100).toFixed(2)}`;
  assert.equal(
    describeFlag({ kind: 'price', value: 300, typical: 103, name: 'Tomatoes', unit: 'kg', money }),
    'Tomatoes was bought at GH¢3.00 a kg, against a usual GH¢1.03.',
  );
  assert.equal(
    describeFlag({ kind: 'qty', value: 500, typical: 10, name: 'Rice', unit: 'kg', money }),
    '500 kg of Rice was bought, against a usual 10 kg.',
  );
});

test('an alert nobody has ticked is outstanding, including old ones', () => {
  // Absent means yes. Reading a missing field as "already handled" would
  // quietly empty the list the day the field was added.
  assert.equal(isOutstanding({}), true);
  assert.equal(isOutstanding({ acknowledged: false }), true);
  assert.equal(isOutstanding({ acknowledged: true }), false);
});
