import test from 'node:test';
import assert from 'node:assert/strict';
import { billStatus, takenOn } from '../due.ts';

/*
  ORD0889: GH₵210, paid in full, showing "partial".

  The till decides this the moment it records a payment — it writes the row,
  then reads every payment back to see what the bill stands at. That read can
  fail, and a weak connection at the counter is the ordinary case: it happens
  precisely while somebody is settling a bill. A failed read came back as an
  EMPTY LIST, which is indistinguishable from "nothing has ever been paid on
  this", and the till wrote that conclusion onto the order.

  Nothing ever asked again. The money was in the drawer, the payment row
  existed, and the bill said partial for ever.
*/

test('a bill covered by its payments reads paid', () => {
  assert.equal(billStatus(21_000, 21_000), 'paid');
});

test('ORD0889: paid in full is paid, not partial', () => {
  const payments = [{ amount: 21_000, status: 'captured' }];
  assert.equal(billStatus(21_000, takenOn(payments)), 'paid');
});

test('a bill split across several payments is paid once they cover it', () => {
  const payments = [
    { amount: 10_000, status: 'captured' },
    { amount: 11_000, status: 'captured' },
  ];
  assert.equal(takenOn(payments), 21_000);
  assert.equal(billStatus(21_000, 21_000), 'paid');
});

test('a bill half settled is partial, which is the real case this must not lose', () => {
  assert.equal(billStatus(21_000, 10_000), 'partial');
});

test('a bill nobody has paid is unpaid, not partial', () => {
  // "Partial" on a bill with nothing against it says somebody paid something.
  assert.equal(billStatus(21_000, 0), 'unpaid');
});

test('more than the bill is still paid', () => {
  assert.equal(billStatus(21_000, 25_000), 'paid');
});

test('a bill that came to nothing is settled by being handed over', () => {
  // Left unpaid it looks like money still to come, on the close and on the
  // reports and to whoever is asked about it a week later.
  assert.equal(billStatus(0, 0), 'paid');
});

/* ------------------------------------------------- what counts as taken */

test('a tip is not part of what was owed', () => {
  // Counting it would leave the bill short by the tip and ask the next person
  // to pay that much again.
  assert.equal(takenOn([{ amount: 21_000, tip: 5_000, status: 'captured' }]), 21_000);
});

test('money that went back out is not money taken', () => {
  const payments = [
    { amount: 21_000, status: 'voided' },
    { amount: 21_000, status: 'refunded' },
    { amount: 21_000, status: 'captured' },
  ];
  assert.equal(takenOn(payments), 21_000);
});

test('a voided duplicate leaves the bill still paid by the row that stood', () => {
  /*
    The server voids a second identical payment. The bill must still read paid
    afterwards — from the row that came first, worked out rather than assumed.
  */
  const payments = [
    { amount: 21_000, status: 'captured' },
    { amount: 21_000, status: 'voided' },
  ];
  assert.equal(billStatus(21_000, takenOn(payments)), 'paid');
});

test('an odd row is worth nothing rather than breaking the sum', () => {
  assert.equal(takenOn([]), 0);
  assert.equal(takenOn([{ status: 'captured' }]), 0);
});

/* ------------------------------------------- the copy the server actually runs */

/*
  order-guard cannot import this file. A function is deployed on its own with
  no workspace around it, so functions/order-guard/src/settle-bill.js is a
  deliberate hand copy.

  If the two ever disagree, a bill reads one way on the till and another in the
  books — which is this whole fault again, with the two answers swapped.
*/
test('the server\'s copy of the rule has not drifted', async () => {
  const server = await import('../../../../functions/order-guard/src/settle-bill.js');
  const cases: [number, number][] = [
    [21_000, 21_000], [21_000, 10_000], [21_000, 0], [21_000, 25_000], [0, 0], [0, 500],
  ];
  for (const [total, taken] of cases) {
    assert.equal(server.billStatus(total, taken), billStatus(total, taken), `${total}/${taken}`);
  }
  const rows = [
    { amount: 10_000, status: 'captured' },
    { amount: 11_000, status: 'voided' },
    { amount: 1_000, tip: 500, status: 'captured' },
  ];
  assert.equal(server.takenOn(rows), takenOn(rows));
  assert.equal(server.takenOn([]), 0);
  assert.equal(server.takenOn(null), 0, 'and it survives what a database hands back');
});
