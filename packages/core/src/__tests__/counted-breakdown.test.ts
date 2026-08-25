import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countedParts, partLines, partsWords, unexplained,
  type SpendRow,
} from '../counted-breakdown.ts';
import type { MoneyKind, TotalledShift } from '../shift-totals.ts';

/** The one thing this needs to know about a method: which bucket it is in. */
const kindFor = (id: string): MoneyKind => (id === 'm-card' ? 'card' : id === 'm-cash' ? 'cash' : 'other');

const money = (n: number) => `GHS ${(n / 100).toFixed(2)}`;

const shift = (over: Partial<TotalledShift> = {}): TotalledShift => ({
  $id: 'sh1',
  status: 'closed',
  ...over,
});

test('a counted drawer walks back to the sales that filled it', () => {
  /**
   * The worked example this was written for. A drawer opens with GHS 200,
   * takes GHS 1,000 in cash, GHS 150 goes out of it on a market run, and the
   * count at close finds GHS 1,045 — five short.
   *
   *   expected = 200 + 1000 − 150 = 1050
   *   variance = 1045 − 1050     = −5
   *   taken    = 1045 − 200 + 150 − (−5) = 1000
   *
   * Which is the point: the headline is 1,045 and the sales under it come to
   * 1,000, and every step between the two is a real thing that happened.
   */
  const parts = countedParts({
    shifts: [shift({
      counted: JSON.stringify({ 'm-cash': 104_500 }),
      opening_floats: JSON.stringify({ 'm-cash': 20_000 }),
      variance: JSON.stringify({ 'm-cash': -500 }),
    })],
    kindFor,
    expenses: [{ shift_id: 'sh1', amount: 15_000, paid_from_method_id: 'm-cash' }],
    kind: 'cash',
  });

  assert.equal(parts.counted, 104_500);
  assert.equal(parts.floats, 20_000);
  assert.equal(parts.spent, 15_000);
  assert.equal(parts.variance, -500);
  assert.equal(parts.taken, 100_000);
});

test('a card figure is the same arithmetic with the middle terms empty', () => {
  /*
    No float sits in a card machine overnight and nothing is paid out of one,
    so a card count that balances IS its sales. Worth being able to see rather
    than take on trust.
  */
  const parts = countedParts({
    shifts: [shift({ counted: JSON.stringify({ 'm-card': 259_500 }) })],
    kindFor,
    expenses: [],
    kind: 'card',
  });
  assert.equal(parts.taken, 259_500);
  assert.equal(parts.floats, 0);
  assert.equal(parts.spent, 0);

  // And the table shows only the two ends, rather than three noughts.
  assert.deepEqual(partLines(parts).map((r) => r.label), ['Counted at close']);
});

test('petty cash never reduced this drawer, so it is not in this sum', () => {
  /**
   * A cook given money from the till has spent the till's money. A cook given
   * petty cash has spent something this shift never took — and subtracting it
   * here would invent sales that were never rung up, to explain money that was
   * never missing.
   */
  const parts = countedParts({
    shifts: [shift({ counted: JSON.stringify({ 'm-cash': 100_000 }) })],
    kindFor,
    expenses: [
      { shift_id: 'sh1', amount: 5_000, paid_from_method_id: 'm-cash', from_takings: false },
      // Absent means yes: every row written before the question existed came
      // out of the drawer and has been counted that way all along.
      { shift_id: 'sh1', amount: 3_000, paid_from_method_id: 'm-cash' },
    ],
    kind: 'cash',
  });
  assert.equal(parts.spent, 3_000);
  assert.equal(parts.taken, 103_000);
});

test('spending from another drawer belongs to that drawer', () => {
  const expenses: SpendRow[] = [{ shift_id: 'sh1', amount: 4_000, paid_from_method_id: 'm-card' }];
  const cash = countedParts({
    shifts: [shift({ counted: JSON.stringify({ 'm-cash': 100_000 }) })],
    kindFor,
    expenses,
    kind: 'cash',
  });
  assert.equal(cash.spent, 0, 'the cash drawer did not pay for it');
});

test('an open shift is in neither the headline nor its explanation', () => {
  /**
   * A shift still open has been counted by nobody and adds nothing to the
   * figure being explained. Its payments must not appear in the explanation
   * either, or the list would hold more sales than the number above it.
   */
  const parts = countedParts({
    shifts: [
      shift({ counted: JSON.stringify({ 'm-cash': 50_000 }) }),
      shift({ $id: 'sh2', status: 'open', counted: JSON.stringify({ 'm-cash': 99_900 }) }),
    ],
    kindFor,
    expenses: [{ shift_id: 'sh2', amount: 7_000, paid_from_method_id: 'm-cash' }],
    kind: 'cash',
  });
  assert.equal(parts.counted, 50_000);
  assert.equal(parts.spent, 0, 'nor its spending');
});

test('several nights add up as one', () => {
  const parts = countedParts({
    shifts: [
      shift({
        counted: JSON.stringify({ 'm-cash': 60_000 }),
        opening_floats: JSON.stringify({ 'm-cash': 10_000 }),
      }),
      shift({
        $id: 'sh2',
        counted: JSON.stringify({ 'm-cash': 40_000 }),
        opening_floats: JSON.stringify({ 'm-cash': 10_000 }),
        variance: JSON.stringify({ 'm-cash': 200 }),
      }),
    ],
    kindFor,
    expenses: [],
    kind: 'cash',
  });
  assert.equal(parts.counted, 100_000);
  assert.equal(parts.floats, 20_000);
  assert.equal(parts.variance, 200);
  assert.equal(parts.taken, 79_800);
});

test('a figure that will not parse is left out, not read as nought', () => {
  // A row that cannot be read is not a count of nothing. Adding a wrong number
  // to an explanation is worse than leaving a gap in it.
  const parts = countedParts({
    shifts: [shift({ counted: 'not json', opening_floats: '{oops' })],
    kindFor,
    expenses: [],
    kind: 'cash',
  });
  assert.equal(parts.counted, 0);
  assert.equal(parts.floats, 0);
});

test('the sentence says which terms are doing the work', () => {
  const parts = countedParts({
    shifts: [shift({
      counted: JSON.stringify({ 'm-cash': 104_500 }),
      opening_floats: JSON.stringify({ 'm-cash': 20_000 }),
      variance: JSON.stringify({ 'm-cash': -500 }),
    })],
    kindFor,
    expenses: [{ shift_id: 'sh1', amount: 15_000, paid_from_method_id: 'm-cash' }],
    kind: 'cash',
  });
  const words = partsWords(parts, money);
  assert.match(words, /GHS 200\.00 of it was the float/);
  assert.match(words, /GHS 150\.00 was spent out of the drawer/);
  assert.match(words, /GHS 5\.00 short/);
  assert.match(words, /GHS 1000\.00 taken on the sales below/);
});

test('nothing to explain is said plainly rather than as an empty table', () => {
  const parts = countedParts({
    shifts: [shift({ counted: JSON.stringify({ 'm-card': 25_900 }) })],
    kindFor,
    expenses: [],
    kind: 'card',
  });
  assert.equal(partsWords(parts, money), 'GHS 259.00 counted, and all of it came from the sales below.');
});

test('a list that falls short of its own total says so', () => {
  /**
   * The check on all of the above, and the reason this is not just a filtered
   * list. A payment stamped to one of these shifts whose sale is counted
   * elsewhere leaves the arithmetic predicting more than the list holds — and
   * a list quietly short of its own total is worse than no list.
   *
   * No tolerance: these are whole minor units and every term is an integer, so
   * any difference at all is a real one.
   */
  const parts = countedParts({
    shifts: [shift({ counted: JSON.stringify({ 'm-cash': 100_000 }) })],
    kindFor,
    expenses: [],
    kind: 'cash',
  });
  assert.equal(unexplained(parts, 100_000), 0);
  assert.equal(unexplained(parts, 74_400), 25_600);
  assert.equal(unexplained(parts, 100_001), -1);
});
