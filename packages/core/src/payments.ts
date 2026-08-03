import { ID, Query, listAll } from './client';
import { createOrQueue, updateOrQueue } from './offline';
import type { Doc } from './types';
import type { Order } from './orders';

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
 * that prove it. Tips are excluded — a tip is not part of what was owed.
 */
export async function amountOutstanding(order: Pick<Order, '$id' | 'total'>): Promise<number> {
  const paid = await listAll<PaymentRow>('payments', [Query.equal('order_id', order.$id)]).catch(
    () => [] as PaymentRow[],
  );
  const taken = paid
    .filter((p) => p.status !== 'voided' && p.status !== 'refunded')
    .reduce((sum, p) => sum + (p.amount ?? 0), 0);
  return Math.max(0, order.total - taken);
}

/**
 * Recording that a bill was settled.
 *
 * One function because there are two screens that settle bills — the till and
 * the kitchen display in combined mode — and they were two separate pieces of
 * code writing the same row. The kitchen's copy omitted `change_given`, which
 * the database requires, so settling from the pass failed every time while the
 * till worked perfectly. A second implementation of a write is a second chance
 * to get its required fields wrong.
 *
 * This system never takes money. It records that money was taken.
 */
export interface RecordPaymentInput {
  venueId: string;
  order: Pick<Order, '$id' | 'total' | 'customer_email'>;
  shiftId: string;
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
 * A bill can be settled in several goes — a table splitting it, somebody
 * paying half in cash and half by mobile money, a deposit against a booking.
 * So this counts what has actually been taken rather than assuming one payment
 * clears the whole thing: the order is only marked paid and closed once the
 * balance reaches zero, and stays open and visible until then.
 */
export async function recordPayment(input: RecordPaymentInput): Promise<number> {
  const now = new Date().toISOString();

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
    shift_id: input.shiftId,
    customer_email: input.customerEmail?.trim() || input.order.customer_email || '',
  });

  return remaining;
}
