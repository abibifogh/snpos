import test from 'node:test';
import assert from 'node:assert/strict';
import { surplusPayment } from '../../../../functions/order-guard/src/duplicate-payment.js';

const pay = (id: string, amount: number, at: string, over: Record<string, unknown> = {}) => ({
  $id: id, amount, $createdAt: at, status: 'captured', ...over,
});

test('the same bill paid three times keeps the first and voids the rest', () => {
  /*
    THE REPORT. A GH₵270 order came back with three GH₵270 cash payments on
    it and the night's takings were over by GH₵540. The till refuses to take
    more than a bill owes, but to know what it owes it has to read what is
    already on the bill — and when that read fails it takes the money anyway,
    deliberately, so a restaurant can sell in a power cut. On a bad connection
    the check is skipped exactly when somebody is most likely to press again.
  */
  const a = pay('p1', 27_000, '2026-09-14T19:31:01.000Z');
  const b = pay('p2', 27_000, '2026-09-14T19:31:02.000Z');
  const c = pay('p3', 27_000, '2026-09-14T19:31:03.000Z');
  const all = [a, b, c];

  assert.equal(surplusPayment({ payment: a, payments: all, orderTotal: 27_000 }).surplus, false);
  assert.equal(surplusPayment({ payment: b, payments: all, orderTotal: 27_000 }).surplus, true);
  assert.equal(surplusPayment({ payment: c, payments: all, orderTotal: 27_000 }).surplus, true);
});

test('three landing in the same millisecond still leaves one standing', () => {
  /*
    THE FAILURE THAT WOULD BE WORSE THAN THE BUG. The guard runs once per
    payment and the runs can overlap. If each simply asked "do the others
    cover this bill?", all three would answer yes, all three would void
    themselves, and a paid order would be left with no payment on it at all.

    Counting only what came strictly BEFORE makes the first safe by
    construction — and when the clock cannot separate them, the ids do.
    Whatever order the three runs happen in, exactly one survives.
  */
  const same = '2026-09-14T19:31:00.000Z';
  const all = [pay('pC', 27_000, same), pay('pA', 27_000, same), pay('pB', 27_000, same)];

  const kept = all.filter(
    (p) => !surplusPayment({ payment: p, payments: all, orderTotal: 27_000 }).surplus,
  );
  assert.equal(kept.length, 1, 'exactly one payment survives');
  assert.equal(kept[0].$id, 'pA', 'and it is the same one every time');
});

test('a bill split between two people is not a duplicate', () => {
  // The commonest thing in a restaurant. Neither half covers the bill alone,
  // so neither is surplus to it.
  const all = [
    pay('p1', 15_000, '2026-09-14T19:31:01.000Z'),
    pay('p2', 12_000, '2026-09-14T19:31:40.000Z'),
  ];
  for (const p of all) {
    assert.equal(surplusPayment({ payment: p, payments: all, orderTotal: 27_000 }).surplus, false);
  }
});

test('a payment that merely overshoots is left alone', () => {
  /*
    GH₵200 against GH₵100 outstanding is a real tender somebody handed over.
    The screen already refuses it, and voiding it here would take a customer's
    money out of the record entirely. Only the unambiguous case — the bill was
    settled in full BEFORE this row existed — is touched.
  */
  const all = [
    pay('p1', 17_000, '2026-09-14T19:31:01.000Z'),
    pay('p2', 20_000, '2026-09-14T19:31:09.000Z'),
  ];
  assert.equal(surplusPayment({ payment: all[1], payments: all, orderTotal: 27_000 }).surplus, false);
});

test('a voided row does not cover a bill, so paying again is allowed', () => {
  // Somebody voided a payment recorded in error; the bill is owed again.
  const all = [
    pay('p1', 27_000, '2026-09-14T19:31:01.000Z', { status: 'voided' }),
    pay('p2', 27_000, '2026-09-14T19:40:00.000Z'),
  ];
  assert.equal(surplusPayment({ payment: all[1], payments: all, orderTotal: 27_000 }).surplus, false);
});

test('a refunded row is money that left the drawer again', () => {
  const all = [
    pay('p1', 27_000, '2026-09-14T19:31:01.000Z', { status: 'refunded' }),
    pay('p2', 27_000, '2026-09-14T19:40:00.000Z'),
  ];
  assert.equal(surplusPayment({ payment: all[1], payments: all, orderTotal: 27_000 }).surplus, false);
});

test('an order for nothing has nothing to be surplus to', () => {
  // A comped table, or a total not worked out yet. Voiding here would be
  // inventing a rule nobody asked for.
  const all = [pay('p1', 0, '2026-09-14T19:31:01.000Z'), pay('p2', 0, '2026-09-14T19:31:02.000Z')];
  assert.equal(surplusPayment({ payment: all[1], payments: all, orderTotal: 0 }).surplus, false);
});

test('a row already voided is not voided a second time', () => {
  const all = [
    pay('p1', 27_000, '2026-09-14T19:31:01.000Z'),
    pay('p2', 27_000, '2026-09-14T19:31:02.000Z', { status: 'voided' }),
  ];
  assert.equal(surplusPayment({ payment: all[1], payments: all, orderTotal: 27_000 }).surplus, false);
});

test('the reason says what was already on the bill', () => {
  const all = [
    pay('p1', 27_000, '2026-09-14T19:31:01.000Z'),
    pay('p2', 27_000, '2026-09-14T19:31:02.000Z'),
  ];
  const verdict = surplusPayment({ payment: all[1], payments: all, orderTotal: 27_000 });
  assert.equal(verdict.covered, 27_000);
  assert.match(verdict.why, /already settled in full/);
});

test('a payment nobody sent is not a payment', () => {
  assert.equal(surplusPayment({ payment: null, payments: [], orderTotal: 100 }).surplus, false);
});
