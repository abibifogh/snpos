/**
 * The same bill paid twice, caught on the server.
 *
 * A GH₵270 order came back with three GH₵270 cash payments on it, and the
 * night's takings were over by GH₵540. Nobody did anything wrong at the
 * counter; the till is built to keep working when it cannot reach the server,
 * and that is the right decision — a restaurant must be able to take money in
 * a power cut. But it has a cost that had never been paid.
 *
 * `recordPayment` refuses to take more than a bill still owes. To know what a
 * bill owes it has to READ the payments already on it, and when that read
 * fails it deliberately fails open and takes the money anyway. So on a bad
 * connection the guard is not merely bypassed, it is bypassed exactly when
 * somebody is most likely to press the button again: the screen hangs, the
 * cashier taps once more, and each attempt writes a row of its own with an id
 * of its own — which is also why the offline queue's "already sent this"
 * check does not help. Three presses, three payments, and nothing anywhere
 * ever looked again.
 *
 * This is the look-again. It runs where the client cannot: on the server, once
 * per payment, with every row already written in front of it.
 *
 * Pure. Imports nothing.
 */

/** Money that is still in the drawer. A voided or refunded row is not. */
const live = (p) => p && p.status !== 'voided' && p.status !== 'refunded';

/**
 * Deterministic order, so "earlier" means the same thing to every run.
 *
 * This matters more than it looks. The guard fires once per payment, and when
 * three land together the three runs may overlap — so if each simply asked
 * "do the others already cover this bill?", all three would answer yes and
 * all three would void themselves, leaving a paid order with no payment on it
 * at all. That is a worse failure than the one being fixed.
 *
 * Counting only what came STRICTLY BEFORE makes the first payment safe by
 * construction: nothing precedes it, so it is never the surplus one, however
 * many runs are in flight.
 */
const before = (a, b) => {
  const at = String(a.$createdAt ?? '');
  const bt = String(b.$createdAt ?? '');
  if (at !== bt) return at < bt;
  // Same instant to the millisecond. Ids are stable and unique, so they settle
  // it — arbitrary, but arbitrary and CONSISTENT is all this needs.
  return String(a.$id ?? '') < String(b.$id ?? '');
};

/**
 * Is this payment money the bill did not owe?
 *
 * Only when the bill was ALREADY fully covered without it. A payment that
 * merely overshoots — GH₵200 against GH₵100 outstanding — is left alone on
 * purpose: that is a real tender somebody handed over, the screen already
 * refuses it, and voiding it here would take a customer's money out of the
 * record entirely. A duplicate is the narrow case where the order was settled
 * before this row existed, and that case is unambiguous.
 *
 * @typedef {object} PaymentRow
 * @property {string} [$id]
 * @property {string} [$createdAt]
 * @property {string} [status]
 * @property {number} [amount]
 *
 * @param {object} input
 * @param {PaymentRow | null} input.payment
 * @param {PaymentRow[]} [input.payments]
 * @param {number} [input.orderTotal]
 * @returns {{ surplus: boolean, covered: number, why: string }}
 */
export function surplusPayment({ payment, payments = [], orderTotal = 0 }) {
  if (!payment || !live(payment)) {
    return { surplus: false, why: 'Not a live payment.', covered: 0 };
  }
  if (!(orderTotal > 0)) {
    // Nothing was owed, so nothing can be surplus to it. A free order, a
    // comped table, a row whose total has not been worked out yet.
    return { surplus: false, why: 'The order is not for anything.', covered: 0 };
  }

  const covered = payments
    .filter((p) => live(p) && String(p.$id) !== String(payment.$id) && before(p, payment))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

  if (covered >= orderTotal) {
    return {
      surplus: true,
      covered,
      why: `The bill was already settled in full before this row: ${covered} of ${orderTotal} `
        + 'was on it. This is the same payment recorded more than once.',
    };
  }

  return { surplus: false, covered, why: `${covered} of ${orderTotal} was on the bill before this.` };
}
