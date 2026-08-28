import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitingPayment, billsToSettle, settleableTotal, billsToSettleLabel } from '../to-settle.ts';

const order = (over: Partial<Parameters<typeof awaitingPayment>[0]> = {}) => ({
  $id: 'o1',
  $createdAt: '2026-08-28T18:29:25.000Z',
  status: 'SERVED',
  payment_status: 'unpaid',
  total: 9000,
  ...over,
});

test('a served order that was made unpaid again comes back into view', () => {
  /**
   * The case that started this. A payment recorded against the wrong method is
   * voided so it can be redone, and the order — already served — had nowhere
   * left to appear: the board stops at READY, and the ticket went the moment
   * somebody pressed Collected. The money was real, owed, and invisible.
   */
  assert.equal(awaitingPayment(order()), true);
});

test('half a bill paid is half a bill owed', () => {
  // The remainder must not vanish because something was recorded against the
  // order once.
  assert.equal(awaitingPayment(order({ payment_status: 'partial' })), true);
});

test('a bill that is paid, or refunded, is not a debt', () => {
  assert.equal(awaitingPayment(order({ payment_status: 'paid' })), false);
  /*
    Money taken and given back is a finished story. Listing it under "still to
    pay" would send somebody to ask a customer for money they have already been
    told they do not owe.
  */
  assert.equal(awaitingPayment(order({ payment_status: 'refunded' })), false);
});

test('nothing still on the board is listed here', () => {
  /**
   * Everything from PENDING to READY already has a ticket with a payment
   * button on it. Listing them twice would put the same order in two places on
   * one screen, and two places is where an order gets paid for twice.
   */
  for (const status of ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SCHEDULED']) {
    assert.equal(awaitingPayment(order({ status })), false, `${status} should stay on the board`);
  }
});

test('an order that was rejected or cancelled owes nothing', () => {
  assert.equal(awaitingPayment(order({ status: 'REJECTED' })), false);
  assert.equal(awaitingPayment(order({ status: 'CANCELLED' })), false);
});

test('newest first, and nothing is aged off', () => {
  /*
    Newest first because the customer most likely to still be in the building,
    and so most likely to be able to pay, is the one served last. But an unpaid
    bill from Tuesday is still money — quietly dropping it would be the system
    deciding to forget a debt on the shop's behalf.
  */
  const rows = [
    order({ $id: 'tuesday', $createdAt: '2026-08-25T12:00:00.000Z' }),
    order({ $id: 'just-now', $createdAt: '2026-08-28T18:29:25.000Z' }),
    order({ $id: 'paid', payment_status: 'paid' }),
  ];
  assert.deepEqual(billsToSettle(rows).map((o) => o.$id), ['just-now', 'tuesday']);
});

test('what is owed is added up, so nobody has to', () => {
  const rows = [order({ $id: 'a', total: 9000 }), order({ $id: 'b', total: 500 }), order({ $id: 'c', payment_status: 'paid', total: 10_000 })];
  assert.equal(settleableTotal(rows), 9500);
});

test('the heading says the number out loud', () => {
  // A section somebody has to count is a section nobody counts.
  assert.match(billsToSettleLabel(1), /1 bill still to pay/);
  assert.match(billsToSettleLabel(3), /3 bills still to pay/);
});
