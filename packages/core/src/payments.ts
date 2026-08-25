import { db, DB_ID, ID, Query, listAll } from './client';
import { createOrQueue, updateOrQueue } from './offline';
import type { Doc } from './types';
import type { Order } from './orders';
// Pure, so the same rule can be checked without a database in front of it.
import { isLivePayment } from './shift-rules';
// Which shift a settled sale is filed under, which is not always the one that
// took the money. Pure, for the same reason.
import { shiftStampForPayment } from './shift-move';
// What a bill still owes, and what counts as paying more than that. Pure.
import { overpaying } from './due';

export { isLivePayment };

interface PaymentRow extends Doc {
  order_id: string;
  amount: number;
  tip: number;
  status: string;
}

/**
 * What is still owed on a bill.
 *
 * Worked out from the payments already recorded rather than tracked on the
 * order, so a bill split four ways cannot drift out of step with the four rows
 * that prove it. Tips are excluded; a tip is not part of what was owed.
 */
export async function amountOutstanding(order: Pick<Order, '$id' | 'total'>): Promise<number> {
  const paid = await listAll<PaymentRow>('payments', [Query.equal('order_id', order.$id)]).catch(
    () => [] as PaymentRow[],
  );
  const taken = paid
    .filter(isLivePayment)
    .reduce((sum, p) => sum + (p.amount ?? 0), 0);
  return Math.max(0, order.total - taken);
}

/**
 * Recording that a bill was settled.
 *
 * One function because there are two screens that settle bills, the till and
 * the kitchen display in combined mode, and they were two separate pieces of
 * code writing the same row. The kitchen's copy omitted `change_given`, which
 * the database requires, so settling from the pass failed every time while the
 * till worked perfectly. A second implementation of a write is a second chance
 * to get its required fields wrong.
 *
 * This system never takes money. It records that money was taken.
 */
export interface RecordPaymentInput {
  venueId: string;
  order: Pick<Order, '$id' | 'total' | 'customer_email' | 'shift_id' | 'module'>;
  shiftId: string;
  /**
   * Which side's till is taking the money.
   *
   * Read only to decide whether settling should move the SALE onto this shift
   * as well as the money. Within one side it should; across two it must not —
   * see shiftStampForPayment for what that cost.
   */
  shiftModule?: string;
  methodId: string;
  methodKind: string;
  /** What this order's share of the tender was, in minor units. */
  amount: number;
  tip?: number;
  changeGiven?: number;
  reference?: string;
  takenBy: string;
  /** Where the order lands once fully paid. The till closes it; the pass has
      just handed it over. Ignored while a balance remains. */
  orderStatus?: 'CLOSED' | 'SERVED';
  /** Added or corrected at the point of payment, if the guest gives one. */
  customerEmail?: string;
}

/**
 * Records one payment against a bill, and returns what is still owed.
 *
 * A bill can be settled in several goes, a table splitting it, somebody
 * paying half in cash and half by mobile money, a deposit against a booking.
 * So this counts what has actually been taken rather than assuming one payment
 * clears the whole thing: the order is only marked paid and closed once the
 * balance reaches zero, and stays open and visible until then.
 */
export async function recordPayment(input: RecordPaymentInput): Promise<number> {
  const now = new Date().toISOString();
  const stamp = shiftStampForPayment({
    order: input.order,
    shiftId: input.shiftId,
    shiftModule: input.shiftModule,
  });

  /*
    MORE MONEY THAN THE BILL COMES TO IS NOT RECORDED AGAINST THE BILL.

    Checked here, where the row is written, and not only on the screen that
    typed it. The screen that produced GH₵30 against a GH₵20 bracelet WAS
    capping the figure — against a number with the un-rung cart folded into it,
    so the cap agreed with it and let it through. A guard has to measure
    against the bill itself or it is measuring the same mistake twice.

    Refused rather than trimmed. Trimming would take the money the customer
    handed over and quietly lose the difference, which is the worse of the two
    and impossible to notice afterwards. The counter has an answer for the
    excess — ring the rest up, or put it in the tip box — and both belong to
    the person standing there, not to this function.

    A tip is not measured. It was never owed on the bill and has its own field.

    FAILS OPEN. If what is outstanding cannot be read — the till is offline,
    which is a case this system supports and queues writes through — the sale
    goes ahead. A guard against a rare mistake must not become a till that
    cannot take money in a power cut, and the screen has already refused the
    thing this is here to catch.
  */
  const outstanding = await amountOutstanding(input.order).catch(() => null);
  if (outstanding !== null && overpaying(outstanding, input.amount) > 0) {
    throw new Error(
      'That is more than this bill still owes. Anything else the customer is buying has to be rung up '
      + 'first — otherwise the money goes down against the wrong sale and the item never leaves the shelf, '
      + 'so nobody is paid for it. A genuine extra belongs in the tip box.',
    );
  }

  await createOrQueue('payments', ID.unique(), {
    venue_id: input.venueId,
    order_id: input.order.$id,
    shift_id: input.shiftId,
    method_id: input.methodId,
    method_kind_snapshot: input.methodKind,
    amount: input.amount,
    tip: input.tip ?? 0,
    // Required by the database and easy to forget, which is the whole reason
    // this function exists.
    change_given: input.changeGiven ?? 0,
    reference: input.reference ?? '',
    status: 'captured',
    taken_by: input.takenBy,
  });

  // Read back after writing, so two people settling different halves at the
  // same moment both see the true remaining balance rather than the one they
  // started from.
  const remaining = await amountOutstanding(input.order);
  const settled = remaining <= 0;

  await updateOrQueue('orders', input.order.$id, {
    payment_status: settled ? 'paid' : 'partial',
    // A part-paid order keeps its place: still on the pass, still blocking the
    // shift close, still visibly owed. Only a cleared bill moves on.
    ...(settled
      ? {
          status: input.orderStatus ?? 'CLOSED',
          marked_paid_by: input.takenBy,
          marked_paid_at: now,
          ...(input.orderStatus === 'SERVED' ? { served_at: now } : {}),
        }
      : {}),
    /*
      Settling files the sale under the shift that took the money — within one
      side. Across two it must not: a bar bill settled at the craft counter was
      being restamped onto the shop's shift, which put the sale on no shift's
      list at all while its money stayed in the shop's takings. See
      shiftStampForPayment.
    */
    ...(stamp ? { shift_id: stamp } : {}),
    customer_email: input.customerEmail?.trim() || input.order.customer_email || '',
  });

  return remaining;
}

/**
 * Undoing a payment that should never have been recorded.
 *
 * The message on the order screen used to say "fix the payment separately",
 * and there was no separately: nothing anywhere in the system could reverse a
 * payment, so an order marked paid in error could be set back to unpaid while
 * the money it never received stayed in the takings for ever. Being told to go
 * and do something there is no way to do is worse than being told no.
 *
 * Marked, not deleted, and deliberately.
 *
 * The shift it was taken in was counted against these rows. A cashier counts
 * the drawer at the end of the night and the system says what it should hold;
 * deleting a payment silently changes the answer to a question that was
 * already settled, and the person who counted has no way to see why they are
 * suddenly short. A voided row keeps the history readable — it says money was
 * recorded here and then taken back out, by somebody, for a reason.
 *
 * Two consequences the caller has to deal with, because neither is this
 * function's to decide:
 *
 *  - the ORDER's payment status is recomputed here, since it follows directly
 *    from what is left and nobody would want it to disagree;
 *  - the SHIFT's stored totals do not move if it has already closed. Those are
 *    a snapshot of a night that was signed off. `recomputeClosedShift` will
 *    redo them when that is what somebody wants, and the screen offering this
 *    says so rather than pretending the books quietly fixed themselves.
 */
export async function voidPayment(
  payment: Pick<PaymentRow, '$id' | 'order_id'>,
  order: Pick<Order, '$id' | 'total'>,
): Promise<{ outstanding: number; paymentStatus: 'unpaid' | 'partial' | 'paid' }> {
  await updateOrQueue('payments', payment.$id, { status: 'voided' });

  // Read back rather than subtracting: a bill split four ways must not drift
  // out of step with the rows that prove it.
  const outstanding = await amountOutstanding(order);
  const paymentStatus =
    outstanding <= 0 ? 'paid' : outstanding >= order.total ? 'unpaid' : 'partial';

  await updateOrQueue('orders', order.$id, { payment_status: paymentStatus });

  return { outstanding, paymentStatus };
}

/**
 * Correcting which drawer a payment went into.
 *
 * Not the amount, and not the order — only how the money arrived. This is the
 * one thing about a payment that is routinely got wrong and that nobody could
 * fix: somebody settles a bill on the pass, taps Cash because it is first in
 * the list, and the customer actually paid by card. Nothing is missing and
 * nothing is stolen, but at the end of the night the cash drawer is over by
 * that amount and the card takings are short by it, and the person counting is
 * left explaining a discrepancy they can see and cannot correct.
 *
 * `method_kind_snapshot` moves with the method. It is what the shift's cash
 * figures read, so leaving it behind would fix the label and not the number,
 * which is the worst of the three possible outcomes.
 */
export async function changePaymentMethod(
  paymentId: string,
  method: { $id: string; kind: string },
): Promise<void> {
  await updateOrQueue('payments', paymentId, {
    method_id: method.$id,
    method_kind_snapshot: method.kind,
  });
}

/**
 * The record that somebody moved money from one drawer to another.
 *
 * Written down because this is not a cosmetic edit: cash and card are two
 * piles that two different people count and answer for, and moving an amount
 * between them changes what each of them is expected to hold. A correction
 * nobody can trace is indistinguishable from a till being quietly rebalanced
 * to cover a shortage, and the point of allowing the correction at all is that
 * the honest version should be the easy one.
 *
 * Never allowed to fail the correction it describes. A log entry that could
 * block the fix would teach people to stop asking for the fix.
 */
export async function logPaymentMethodChange(p: {
  venueId: string;
  paymentId: string;
  actorId: string;
  actorRole: string;
  from: string;
  to: string;
  amount: number;
}): Promise<void> {
  await db
    .createDocument(DB_ID, 'audit_log', ID.unique(), {
      venue_id: p.venueId,
      actor_id: p.actorId,
      actor_role: p.actorRole,
      action: 'payment_method_changed',
      entity_type: 'payments',
      entity_id: p.paymentId,
      before: JSON.stringify({ method: p.from, amount: p.amount }),
      after: JSON.stringify({ method: p.to }),
    })
    .catch(() => undefined);
}
