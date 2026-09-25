import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countsAtBothEnds, countsInAtOpen, openingCountOptional, countSide, countName,
} from '../bar-count.ts';
import { waitingList } from '../waiting.ts';
import {
  countWhat, countSubject, countBody, fromBarChecks,
  // Plain JavaScript, importing nothing at runtime.
} from '../../../../functions/notify/src/approvals.js';

/*
  The kitchen counts IN at the start of a shift on the same sheet as the bar,
  and a difference it finds is held and emailed the same way. What changes is
  whose shelf it is — and everything downstream has to know, or approving a
  kitchen count moves the bar's shelf and the email calls it the bar's.
*/

test('the kitchen now counts in at the start of a shift, and only in', () => {
  assert.equal(countsInAtOpen('kitchen'), true);
  assert.equal(countsInAtOpen(undefined), true, 'no side named is the kitchen');
  assert.equal(countsInAtOpen('bar'), true);
  assert.equal(countsInAtOpen('craft'), true);
  // Its close is still the larder check on the closing screen, not a second
  // sheet: the kitchen does not count at BOTH ends.
  assert.equal(countsAtBothEnds('kitchen'), false);
});

test('the kitchen\'s opening count can be left for later; the bar\'s rules are unchanged', () => {
  // A kitchen opening at six with deliveries arriving is not held up by it.
  assert.equal(openingCountOptional('kitchen'), true);
  assert.equal(openingCountOptional(undefined), true);
  assert.equal(openingCountOptional('bar'), false);
});

test('a count knows whose shelf it was from its rows', () => {
  assert.equal(countSide([{ module: 'kitchen' }, { module: 'kitchen' }]), 'kitchen');
  // Rows from before sides were recorded were the bar's — it was the only
  // side that counted this way — so approving one still moves the bar's shelf.
  assert.equal(countSide([{}, { module: null }]), 'bar');
  assert.equal(countSide([]), 'bar');
});

test('it is named for its side, on the screen and in the email alike', () => {
  for (const side of ['bar', 'kitchen']) {
    for (const phase of ['open', 'close'] as const) {
      assert.equal(countWhat(side, phase), countName(side, phase), `${side} ${phase}`);
    }
  }
  assert.equal(countName('kitchen', 'open'), 'Kitchen count, counting in');
  assert.equal(countWhat(undefined, 'close'), 'Bar count, counting out');
});

test('the email for a kitchen count says it is the kitchen\'s', () => {
  const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
  assert.equal(
    countSubject({ phase: 'open', lines: 2, shortValue: 1_500, side: 'kitchen', money }),
    '2 differences on the kitchen count (counting in), GH₵15.00 short',
  );
  const html = countBody({
    lines: [{ name: 'Rice', variance: -2, value: 1_500, expected: 10, counted: 8 }],
    who: 'Ama', phase: 'open', side: 'kitchen', money,
  });
  assert.match(html, /Ama counted the kitchen in at the start of the shift/);
  assert.match(html, /The stock figures have not moved/);
  // And a count with no side said is still the bar's, word for word as before.
  assert.equal(
    countSubject({ phase: 'close', lines: 1, shortValue: 0, money }),
    '1 difference on the bar count (counting out)',
  );
});

test('the hourly digest and the day-late alert name the kitchen too', () => {
  const items = fromBarChecks([
    { shift_id: 'k1', phase: 'open', applied: false, module: 'kitchen', variance_value: 500, $createdAt: 'x' },
  ]);
  assert.equal(items[0]?.what, 'Kitchen count, counting in');
});

test('Waiting for you lists a kitchen count as the kitchen\'s', () => {
  const [item] = waitingList({
    barCounts: [{ shiftId: 'k1', phase: 'open', at: 'x', worth: 500, changed: 1, pending: 1, side: 'kitchen' }],
    shopCounts: [],
    spends: [],
    tabShifts: [],
    shiftCodes: { k1: 'KIT20260925-a1' },
    money: (n: number) => String(n),
  });
  assert.equal(item?.title, 'Kitchen count, counted in on KIT20260925-a1');
  const [bar] = waitingList({
    barCounts: [{ shiftId: 'b1', phase: 'close', at: 'x', worth: 500, changed: 1, pending: 1 }],
    shopCounts: [],
    spends: [],
    tabShifts: [],
    money: (n: number) => String(n),
  });
  assert.equal(bar?.title, 'Bar count, counted out');
});

test('approving a kitchen count can never move the bar\'s shelf', async () => {
  /*
    Approval finds the place a count's differences move from its side:
    saleLocation(places, side). A kitchen with no places of its own must come
    back with NO place — its one running figure is then what moves — and never
    with the bar's counter, which is what the old fallback to 'bar' did.
  */
  const { saleLocation } = await import('../locations.ts');
  const places = [
    { $id: 'bar-counter', name: 'The bar', kind: 'counter' as const, module: 'bar' },
    { $id: 'bar-store', name: 'Bar store', kind: 'store' as const, module: 'bar' },
  ];
  assert.equal(saleLocation(places, countSide([{ module: 'kitchen' }])), null);
  // A kitchen that does have a place of its own uses it.
  const withKitchen = [...places, { $id: 'pass', name: 'The pass', kind: 'counter' as const, module: 'kitchen' }];
  assert.equal(saleLocation(withKitchen, countSide([{ module: 'kitchen' }]))?.$id, 'pass');
  // And a bar count, old or new, still lands on the bar's counter.
  assert.equal(saleLocation(places, countSide([{}]))?.$id, 'bar-counter');
});
