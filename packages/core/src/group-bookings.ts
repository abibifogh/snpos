import { db, DB_ID } from './client';

/**
 * One record for a whole group booking.
 *
 * The kitchen's unit of work is a sitting. Tuesday lunch and Thursday dinner
 * are cooked two days apart and each needs its own ticket released at its own
 * hour, so the ORDERS stay one per sitting and always will — an order has one
 * fire time and cannot have four.
 *
 * What was missing is the thing above them. A hotel that booked four sittings
 * was handed four order numbers with nothing anywhere saying they were one
 * arrangement, the front desk had four rows to find, and the "a group has
 * ordered" email went out four times — once per order, which is exactly the
 * shape that teaches somebody to filter it.
 *
 * This is that record. Its id IS the booking id every one of those orders
 * carries, so the two are always walkable between. It is written LAST, once
 * every sitting has actually landed, because a booking row for sittings that
 * failed would be a confirmation of something that is not booked.
 *
 * Writing it is also what sends the two emails: the function watches this
 * collection, so one booking is one message to the owner and one to the person
 * who booked. See functions/notify.
 */
export interface GroupBookingDoc {
  $id: string;
  venue_id: string;
  reference?: string;
  contact_name: string;
  email: string;
  size?: number;
  sittings?: number;
  portions?: number;
  total?: number;
  currency_code?: string;
  order_nos?: string;
  first_at?: string;
  last_at?: string;
}

export async function recordGroupBooking(input: {
  /** The id the orders already carry. Used as this document's id. */
  bookingId: string;
  venueId: string;
  reference: string;
  contactName: string;
  email: string;
  size: number;
  sittings: number;
  portions: number;
  total: number;
  currencyCode: string;
  /** In the order they will be cooked. */
  orderNos: string[];
  firstAt: string;
  lastAt: string;
}): Promise<void> {
  await db.createDocument(DB_ID, 'group_bookings', input.bookingId, {
    venue_id: input.venueId,
    reference: input.reference.trim(),
    contact_name: input.contactName.trim(),
    email: input.email.trim(),
    size: Math.max(0, Math.round(input.size || 0)),
    sittings: input.sittings,
    portions: input.portions,
    total: input.total,
    currency_code: input.currencyCode,
    // Capped to what the column holds. A stay of many sittings must not lose
    // the whole row to a list that ran long.
    order_nos: input.orderNos.join(', ').slice(0, 400),
    first_at: input.firstAt,
    last_at: input.lastAt,
  });
}
