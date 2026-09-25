import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordedTotal, unrecordedPaid, canRecordMissing, unrecordedWords,
  placeByHand, canPlaceByHand, placeByHandWords, methodProblem,
} from '../paid-by-hand.ts';

const cash = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
const order = (over: Record<string, unknown> = {}) => ({
  total: 9000, payment_status: 'paid', ...over,
}) as Parameters<typeof unrecordedPaid>[0];

test('an order marked paid by hand has the whole total missing', () => {
  /**
   * The case somebody discovers when they go looking for the button to change
   * the payment method and there is none. Setting the word "paid" on an order
   * writes nothing else: the money is in no method, in no shift, and reaches
   * no total, while the order reads settled from every angle except the one
   * that matters.
   */
  assert.equal(unrecordedPaid(order(), []), 9000);
  assert.equal(canRecordMissing(order(), []), true);
});

test('an ordinary settled bill has no gap at all', () => {
  // The overwhelming majority. A payment taken at a till has the row to show
  // for it, and this must never offer to add a second one.
  assert.equal(unrecordedPaid(order(), [{ amount: 9000 }]), 0);
  assert.equal(canRecordMissing(order(), [{ amount: 9000 }]), false);
});

test('a bill split across two payments is explained by both', () => {
  assert.equal(unrecordedPaid(order(), [{ amount: 4000 }, { amount: 5000 }]), 0);
});

test('a voided payment explains nothing', () => {
  /*
    The row stays where it is — a shift that has been counted has to keep
    adding up — but it is not money the business holds, so it cannot stand
    behind a bill claiming to be paid. The same rule every other total uses.
  */
  assert.equal(unrecordedPaid(order(), [{ amount: 9000, status: 'voided' }]), 9000);
  assert.equal(recordedTotal([{ amount: 9000, status: 'refunded' }]), 0);
});

test('a part-recorded bill marked fully paid shows only what is short', () => {
  assert.equal(unrecordedPaid(order(), [{ amount: 4000 }]), 5000);
});

test('an unpaid bill is not offered a payment out of thin air', () => {
  /**
   * Inventing one would be marking the bill paid through a side door, which is
   * the mistake this exists to clean up rather than a second way to make it.
   */
  assert.equal(unrecordedPaid(order({ payment_status: 'unpaid' }), []), 0);
  assert.equal(canRecordMissing(order({ payment_status: 'unpaid' }), []), false);
});

test('a refunded bill is finished, not missing', () => {
  assert.equal(unrecordedPaid(order({ payment_status: 'refunded' }), []), 0);
});

test('a bill on a tab is unpaid on purpose', () => {
  /*
    The account carries it and the money genuinely has not arrived. Offering to
    record a payment here would invent takings for a debt somebody is still
    intending to settle.
  */
  assert.equal(unrecordedPaid(order({ tab_id: 't1', payment_status: 'paid' }), []), 0);
});

test('a partial bill with rows behind it is not treated as short', () => {
  // "Partial" already says the rest is owed. Only the word "paid" claims the
  // whole total, so only that can leave a gap.
  assert.equal(unrecordedPaid(order({ payment_status: 'partial' }), [{ amount: 4000 }]), 0);
});

test('the message asks for the missing fact without an accusation', () => {
  /**
   * Marking a bill paid by hand is usually the right call made in a hurry —
   * the money did arrive, somebody could not reach a till. The words assume
   * that.
   */
  const words = unrecordedWords(9000, cash);
  assert.match(words, /GH₵90\.00/);
  // And say why it matters, in the terms somebody counting a drawer will meet.
  assert.match(words, /in no shift and no method/);
  assert.match(words, /reads as over/);
  assert.match(words, /Say how it was paid/);
});

/* ----------------------------------------- asked at the moment of marking */

const marking = (over: Record<string, unknown> = {}) => ({
  order: { total: 9000, payment_status: 'unpaid', shift_id: 'sh1', ...over } as Parameters<typeof placeByHand>[0]['order'],
  payments: [] as { amount: number; status?: string }[],
  nextStatus: 'paid',
});

test('marking a bill paid offers to write the money down there and then', () => {
  /*
    The cleanup above relies on somebody coming back: the screen that made the
    gap said "open this order afterwards and say how it was paid", and a
    second step later is a second step that does not happen. So the question
    is asked where the word is written.
  */
  const p = placeByHand(marking());
  assert.equal(p.amount, 9000);
  assert.equal(p.shiftId, 'sh1');
  assert.equal(p.problem, null);
  assert.equal(canPlaceByHand(p), true);
});

test('a part-paid bill being settled claims only what is left', () => {
  // Not the total. Writing the whole bill again over a deposit already taken
  // charges the customer twice in the figures.
  const p = placeByHand({
    ...marking({ payment_status: 'partial' }),
    payments: [{ amount: 4000 }],
  });
  assert.equal(p.amount, 5000);
});

test('a voided payment does not explain anything', () => {
  // Money the business does not hold. The same rule every other total uses.
  const p = placeByHand({ ...marking(), payments: [{ amount: 9000, status: 'voided' }] });
  assert.equal(p.amount, 9000);
});

test('nothing is asked when the rows already cover the bill', () => {
  // A second row here would charge the bill twice.
  const p = placeByHand({ ...marking(), payments: [{ amount: 9000 }] });
  assert.equal(p.amount, 0);
  assert.equal(canPlaceByHand(p), false);
  assert.equal(p.problem, null, 'nothing missing is not a problem to report');
});

test('going the other way is a void, not a question', () => {
  // Taking money back out has its own screen and its own record.
  assert.equal(placeByHand({ ...marking({ payment_status: 'paid' }), nextStatus: 'unpaid' }).amount, 0);
  assert.equal(placeByHand({ ...marking(), nextStatus: 'partial' }).amount, 0);
  // Already paid and staying paid claims nothing new here.
  assert.equal(placeByHand(marking({ payment_status: 'paid' })).amount, 0);
});

test('a bill on a tab is refused rather than invented', () => {
  /*
    It is unpaid on purpose and the account carries it. A payment written
    here would clear the bill without anybody having handed money over.
  */
  const p = placeByHand(marking({ tab_id: 't1' }));
  assert.equal(p.amount, 0);
  assert.match(String(p.problem), /on a tab/);
  assert.match(String(p.problem), /Settle the tab/);
  assert.equal(canPlaceByHand(p), false);
});

test('an order on no shift says where the money cannot go, and still lets the word be written', () => {
  /*
    A payment has to be counted in some night, and picking one for it would
    put real money into a drawer that never held it. So it is said rather
    than guessed — and it does not refuse the status change, because marking
    a bill paid is sometimes the only honest option available.
  */
  const p = placeByHand(marking({ shift_id: undefined }));
  assert.equal(p.shiftId, '');
  assert.equal(canPlaceByHand(p), false);
  assert.match(String(p.problem), /not on any shift/);
  assert.match(String(p.problem), /marked paid with nothing behind it/);
  assert.equal(p.amount, 9000, 'the figure is still known, and still missing');
});

test('the words carry the figure and which night it lands in', () => {
  const words = placeByHandWords(9000, cash);
  assert.match(words, /GH₵90\.00/);
  assert.match(words, /not today/);
});

test('a payment with no method is refused', () => {
  assert.match(String(methodProblem('')), /Say where the money went/);
  assert.match(String(methodProblem(undefined)), /in no drawer/);
  assert.equal(methodProblem('m1'), null);
});
