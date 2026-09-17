/**
 * What a bill reads as, decided where every payment can be seen.
 *
 * ORD0889: GH₵210, paid in full, showing "partial".
 *
 * The till decides this the moment it records a payment: it writes the row,
 * then READS every payment back to see what the bill now stands at. That read
 * can fail — a weak connection at the counter is the ordinary case, and it
 * happens precisely while somebody is settling a bill — and a failed read came
 * back as an empty list, which is indistinguishable from "nothing has ever
 * been paid on this". So the order was marked part-paid on the strength of a
 * question that was never answered. Worse, nothing ever asked again: the money
 * was in the drawer, the payment row existed, and the bill said partial for
 * ever.
 *
 * The same thing happens with no network at all. The payment is queued on the
 * device, the read fails, the order is written as partial, and when the queue
 * finally flushes the payment lands against an order that still says it is
 * owed for.
 *
 * So the server settles it. This runs on every payment, holds the only
 * guaranteed view of every row against the bill, and writes what they add up
 * to. The till's own answer becomes a convenience that makes the screen move
 * at once; this is the record.
 *
 * A DELIBERATE COPY of billStatus and takenOn in packages/core/src/due.ts. A
 * function is deployed on its own and cannot import the workspace, and if the
 * two ever disagree a bill reads one way on the till and another in the books.
 * A test holds them together.
 */

/** Money that went back out is not money taken. */
const live = (p) => p?.status !== 'voided' && p?.status !== 'refunded';

/** Everything taken against a bill. Tips are not part of what was owed. */
export const takenOn = (payments) =>
  (payments || []).filter(live).reduce((sum, p) => sum + (Number(p?.amount) || 0), 0);

/** What the bill should read, given what has been taken against it. */
export function billStatus(total, taken) {
  // A bill that came to nothing is settled by being handed over.
  if ((Number(total) || 0) <= 0) return 'paid';
  if (taken <= 0) return 'unpaid';
  return taken >= Number(total) ? 'paid' : 'partial';
}

/**
 * Put the order's status back in step with its payments.
 *
 * Re-reads rather than trusting a list gathered earlier in the request: a
 * duplicate may have been voided since, and settling a bill from the rows as
 * they were a moment ago is the same class of mistake this exists to fix.
 *
 * Writes only when the answer has changed, so an ordinary payment on an
 * ordinary bill costs one read and no write, and the audit trail does not fill
 * with rows saying nothing happened.
 */
export async function settleBill({ db, DB_ID, Query, orderId, log, error }) {
  if (!orderId) return { skipped: 'no order' };

  const order = await db.getDocument(DB_ID, 'orders', orderId).catch(() => null);
  if (!order) return { skipped: 'no order' };

  /*
    A refunded bill is not re-settled. The money went back deliberately and
    somebody recorded that; re-deriving it from the rows would quietly
    overwrite a decision with arithmetic.
  */
  if (order.payment_status === 'refunded') return { skipped: 'refunded' };

  const rows = await db.listDocuments(DB_ID, 'payments', [
    Query.equal('order_id', orderId),
    Query.limit(100),
  ]).then((r) => r.documents).catch(() => null);

  /*
    A read that failed is not an empty drawer. This is the whole fault being
    fixed — coming back with "no payments" when the question could not be
    asked is what marked a settled bill part-paid — so nothing is written.
  */
  if (rows === null) {
    error?.(`Could not read the payments on ${order.order_no || orderId}; leaving its status alone.`);
    return { skipped: 'unreadable' };
  }

  const taken = takenOn(rows);
  const should = billStatus(order.total, taken);
  if (should === order.payment_status) return { ok: true, status: should, changed: false };

  await db.updateDocument(DB_ID, 'orders', orderId, { payment_status: should });
  log?.(`${order.order_no || orderId}: ${order.payment_status} → ${should} (${taken} of ${order.total}).`);
  return { ok: true, status: should, was: order.payment_status, changed: true };
}
