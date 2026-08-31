import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordedTotal, unrecordedPaid, canRecordMissing, unrecordedWords,
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
