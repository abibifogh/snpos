import { db, DB_ID, ID } from './client';
import type { Order } from './orders';

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
  /** Where the order lands. The till closes it; the pass has just handed it over. */
  orderStatus?: 'CLOSED' | 'SERVED';
  /** Added or corrected at the point of payment, if the guest gives one. */
  customerEmail?: string;
}

export async function recordPayment(input: RecordPaymentInput): Promise<void> {
  const now = new Date().toISOString();

  await db.createDocument(DB_ID, 'payments', ID.unique(), {
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

  await db.updateDocument(DB_ID, 'orders', input.order.$id, {
    payment_status: 'paid',
    status: input.orderStatus ?? 'CLOSED',
    marked_paid_by: input.takenBy,
    marked_paid_at: now,
    shift_id: input.shiftId,
    ...(input.orderStatus === 'SERVED' ? { served_at: now } : {}),
    customer_email: input.customerEmail?.trim() || input.order.customer_email || '',
  });
}
