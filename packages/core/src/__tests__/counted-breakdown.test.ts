import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countedParts, partLines, partsWords, unexplained,
  drawerMakeup, makeupWords, driftWords, spendSplit, splitWords,
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

/* -------------------------------- one drawer, on one shift, term by term */

const spend = (over: Partial<SpendRow> = {}): SpendRow =>
  ({ amount: 5_000, paid_from_method_id: 'm-cash', ...over });

test('the gap between what was taken and what was expected is named, not left to be noticed', () => {
  /*
    The real shift this was written for. Twelve cash sales adding to GH₵835,
    an expected figure of GH₵652, and a sentence saying "anything paid out of
    it comes off again" without saying how much — which asks the reader to
    spot a gap of 183, guess what it is, and take it on trust.
  */
  const m = drawerMakeup({
    methodId: 'm-cash',
    float: 0,
    taken: 83_500,
    expected: 65_200,
    spends: [spend({ amount: 12_000 }), spend({ amount: 6_300 })],
  });
  assert.equal(m.paidOut, 18_300);
  assert.equal(m.works, 65_200, 'float + taken − paid out is the expected figure');
  assert.equal(m.drift, 0);
  assert.equal(m.spends.length, 2, 'and the rows behind it, so it can be checked rather than believed');
});

test('only what came out of this drawer comes off this drawer', () => {
  /*
    Petty cash is money the shift never took. Deducting it would make the
    drawer look short by an amount that was never in it — the accusation that
    stops people recording expenses at all. Another method's spending is not
    this drawer's either.
  */
  const m = drawerMakeup({
    methodId: 'm-cash',
    float: 0,
    taken: 10_000,
    expected: 7_000,
    spends: [
      spend({ amount: 3_000 }),
      spend({ amount: 4_000, from_takings: false }),
      spend({ amount: 9_000, paid_from_method_id: 'm-card' }),
    ],
  });
  assert.equal(m.paidOut, 3_000);
  assert.equal(m.works, 7_000);
});

test('a row written before the question existed is money out of the drawer', () => {
  // Absent means yes. Every one of them was, and has been counted that way.
  const m = drawerMakeup({
    methodId: 'm-cash', float: 0, taken: 10_000, expected: 5_000, spends: [spend({ amount: 5_000 })],
  });
  assert.equal(m.paidOut, 5_000);
});

test('a float is part of the drawer and not part of the takings', () => {
  const m = drawerMakeup({
    methodId: 'm-cash', float: 20_000, taken: 50_000, expected: 65_000, spends: [spend()],
  });
  assert.equal(m.works, 65_000);
  assert.match(makeupWords(m, money, 'Cash'), /float of GHS 200\.00/);
});

test('a stored figure that no longer matches the rows is said, not papered over', () => {
  /*
    The close stored what it knew at the time and that figure never moves on
    its own, so the two drifting apart is a real event — a spend recorded or
    refiled after the close, a payment moved onto the shift. Showing an
    equation that does not add up and leaving the reader to pick a side is
    worse than saying which is which.
  */
  const m = drawerMakeup({
    methodId: 'm-cash', float: 0, taken: 50_000, expected: 45_000, spends: [spend({ amount: 3_000 })],
  });
  assert.equal(m.works, 47_000);
  assert.equal(m.drift, -2_000);
  const words = String(driftWords(m, money));
  assert.match(words, /stored GHS 450\.00/);
  assert.match(words, /GHS 20\.00 less/);
  assert.match(words, /changed after it closed/);
  // And which figure the difference against the count was built from, since
  // that is the reader's next question.
  assert.match(words, /worked out from the stored figure/);
});

test('a shift nobody has touched since says nothing about drift', () => {
  const m = drawerMakeup({
    methodId: 'm-cash', float: 0, taken: 50_000, expected: 50_000, spends: [],
  });
  assert.equal(driftWords(m, money), null);
});

test('a card drawer with nothing in either term says so rather than listing noughts', () => {
  /*
    "No float and nothing paid out" is the answer to why taken and expected
    are the same number. A reader who cannot see that has to take it on trust.
  */
  const m = drawerMakeup({ methodId: 'm-card', float: 0, taken: 40_000, expected: 40_000, spends: [] });
  const words = makeupWords(m, money, 'Card');
  assert.match(words, /no float and nothing paid out/);
  assert.match(words, /GHS 400\.00 expected in it at close/);
  assert.equal(/less GHS 0/.test(words), false, 'a nought term is noise');
});

test('the sentence carries every term it mentions', () => {
  const m = drawerMakeup({
    methodId: 'm-cash', float: 10_000, taken: 83_500, expected: 75_200, spends: [spend({ amount: 18_300 })],
  });
  const words = makeupWords(m, money, 'Cash');
  assert.match(words, /GHS 835\.00 taken through Cash/);
  assert.match(words, /float of GHS 100\.00/);
  assert.match(words, /less GHS 183\.00 paid out of the drawer/);
  assert.match(words, /GHS 752\.00 expected/);
});

test('spending that could not be read is not reported as nothing paid out', () => {
  /*
    THE BUG CLASS THIS SYSTEM KEEPS MEETING. A failed read and a shift that
    spent nothing arrive as the same empty list. "Nothing was paid out of this
    drawer" and "I could not find out" are different claims about somebody's
    money, and only one of them is safe to make confidently.
  */
  const m = drawerMakeup({
    methodId: 'm-cash', float: 0, taken: 83_500, expected: 65_200, spends: [], spendsKnown: false,
  });
  assert.equal(m.known, false);
  const words = makeupWords(m, money, 'Cash');
  assert.match(words, /could not be read/);
  assert.equal(/nothing paid out/.test(words), false);
  // The stored figure is still quoted, because it is the one thing that IS
  // known — it just cannot be broken down.
  assert.match(words, /GHS 652\.00 expected/);

  // And no drift is claimed. Worked out from an unasked nought it would be
  // the size of the spending, reported as somebody having changed the shift.
  assert.equal(m.drift, 0);
  assert.equal(driftWords(m, money), null);
});

test('a read that worked and found nothing still says so plainly', () => {
  const m = drawerMakeup({
    methodId: 'm-cash', float: 0, taken: 50_000, expected: 50_000, spends: [],
  });
  assert.equal(m.known, true, 'absent means the read worked');
  assert.match(makeupWords(m, money, 'Cash'), /nothing paid out of it/);
});

/* ------------------------- the whole spending list, split by which purse */

const nameOf = (id: string) => (id === 'm-cash' ? 'Cash' : id === 'm-card' ? 'Card' : 'A method no longer listed');

test('the spending list is totalled by purse, because the two behave differently', () => {
  /*
    Read as one list they cannot be told apart: money out of the till makes a
    drawer's expected figure smaller, petty cash makes no count anywhere
    smaller. Somebody looking for the figure that shrank a drawer adds every
    row and gets a number matching nothing on the screen above — which is
    worse than no total, because it looks like an answer.
  */
  const split = spendSplit([
    spend({ amount: 12_000 }),
    spend({ amount: 6_300 }),
    spend({ amount: 4_000, from_takings: false }),
  ]);
  assert.equal(split.outOfTakings, 18_300);
  assert.equal(split.ownMoney, 4_000);
  assert.equal(split.total, 22_300);
});

test('each drawer is totalled separately, since one figure would explain neither', () => {
  const split = spendSplit([
    spend({ amount: 3_000, paid_from_method_id: 'm-cash' }),
    spend({ amount: 9_000, paid_from_method_id: 'm-card' }),
    spend({ amount: 2_000, paid_from_method_id: 'm-cash' }),
  ]);
  // Biggest first: the drawer somebody is most likely asking about.
  assert.deepEqual(split.drawers.map((d) => [d.methodId, d.amount, d.count]), [
    ['m-card', 9_000, 1],
    ['m-cash', 5_000, 2],
  ]);
});

test('a spend out of takings that names no drawer is still counted', () => {
  // A row left out of a total is a row nobody notices is missing, and this
  // one is the difference between a drawer that adds up and one that does not.
  const split = spendSplit([spend({ amount: 5_000, paid_from_method_id: undefined })]);
  assert.equal(split.outOfTakings, 5_000);
  assert.equal(split.drawers[0]?.methodId, '');
});

test('the sentence ties the list back to the figures above it', () => {
  const words = splitWords(
    spendSplit([spend({ amount: 18_300 }), spend({ amount: 4_000, from_takings: false })]),
    money,
    nameOf,
  );
  assert.match(words, /GHS 183\.00 came out of the Cash drawer/);
  assert.match(words, /expected figure above is that much less than what was taken/);
  // And the other half said as spending rather than as a shortage, which is
  // the distinction that stops people quietly not recording petty cash.
  assert.match(words, /GHS 40\.00 came from petty cash/);
  assert.match(words, /it is spending, not a shortage/);
});

test('two drawers are not described as one', () => {
  // Naming either would be a sentence that is wrong about the other.
  const words = splitWords(
    spendSplit([spend({ amount: 3_000 }), spend({ amount: 9_000, paid_from_method_id: 'm-card' })]),
    money,
    nameOf,
  );
  assert.match(words, /GHS 120\.00 came out of the takings/);
  assert.equal(/Cash drawer/.test(words), false);
});

test('a shift that spent nothing says so, rather than showing an empty total', () => {
  assert.match(splitWords(spendSplit([]), money, nameOf), /no drawer is short anything/);
});

test('spending that could not be read is not totalled as nothing', () => {
  const split = spendSplit([], false);
  assert.equal(split.known, false);
  assert.match(splitWords(split, money, nameOf), /could not be read/);
});
