import { db, DB_ID, ID, Query, listAll } from './client';

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
  status?: 'pending' | 'approved' | 'refused' | 'cancelled';
  decided_note?: string;
  /** Anything the party said about the booking as a whole. See the schema. */
  note?: string;
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
  /** Anything they want said about the whole booking, in their own words. */
  note?: string;
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
    // Capped to what the column holds, like the order numbers above it: a
    // booking must not lose its whole row to somebody pasting an itinerary.
    note: (input.note ?? '').trim().slice(0, 1000),
    // Waiting, until somebody here agrees to it. See the schema note.
    status: 'pending',
  });
}

/* ------------------------------------------- asking for something to change */

export interface BookingChangeDoc {
  $id: string;
  venue_id: string;
  booking_id: string;
  contact_name?: string;
  reference?: string;
  email?: string;
  kind: string;
  note: string;
  first_at?: string;
  status: 'open' | 'done' | 'refused';
  decided_by?: string;
  decided_at?: string;
  reply?: string;
  $createdAt?: string;
}

/** One booking, by the id its orders carry. Null where it is not found. */
export async function loadGroupBooking(bookingId: string): Promise<GroupBookingDoc | null> {
  return db.getDocument(DB_ID, 'group_bookings', bookingId)
    .then((d) => d as unknown as GroupBookingDoc)
    .catch(() => null);
}

/**
 * Ask for a change. Writes a message; changes nothing.
 *
 * The cutoff is checked here as well as on the form, because a form's rule is
 * a suggestion to whoever is holding the page: the date is on the booking and
 * the clock is the browser's, and both are the guest's to set. See
 * changeProblem.
 */
export async function requestBookingChange(input: {
  booking: GroupBookingDoc;
  kind: string;
  note: string;
}): Promise<void> {
  await db.createDocument(DB_ID, 'booking_changes', ID.unique(), {
    venue_id: input.booking.venue_id,
    booking_id: input.booking.$id,
    contact_name: input.booking.contact_name ?? '',
    reference: input.booking.reference ?? '',
    email: input.booking.email ?? '',
    kind: input.kind,
    note: input.note.trim().slice(0, 2000),
    ...(input.booking.first_at ? { first_at: input.booking.first_at } : {}),
    status: 'open',
  });
}

/** Everything still waiting on somebody, oldest first. */
export async function openBookingChanges(): Promise<BookingChangeDoc[]> {
  const rows = await listAll<BookingChangeDoc>('booking_changes', [Query.equal('status', 'open')])
    .catch(() => [] as BookingChangeDoc[]);
  return rows.sort((a, b) => (a.$createdAt ?? '').localeCompare(b.$createdAt ?? ''));
}

/** Mark one dealt with, with a line back to the guest where there is one. */
export async function decideBookingChange(input: {
  id: string;
  status: 'done' | 'refused';
  by: string;
  reply?: string;
}): Promise<void> {
  await db.updateDocument(DB_ID, 'booking_changes', input.id, {
    status: input.status,
    decided_by: input.by,
    decided_at: new Date().toISOString(),
    reply: (input.reply ?? '').slice(0, 1000),
  });
}

/* --------------------------------------------------- calling the whole thing off */

/**
 * Cancel every sitting of a booking.
 *
 * Asked for, not done here. A guest cannot edit an order — they never could,
 * and giving them that would let anybody holding a link empty a pass — so this
 * writes the same cancellation request the two-minute "I pressed send too
 * fast" button writes, one per sitting, and the server decides. See
 * order-guard: it refuses anything inside five days of the first sitting,
 * whatever the page believed.
 *
 * One row per order rather than one for the booking, because a cancellation is
 * settled against an order: each is refused or cancelled on its own and says
 * which, and a booking that half-cancelled has to be readable afterwards.
 */
export async function cancelGroupBooking(bookingId: string): Promise<{ asked: number }> {
  const orders = await listAll<{ $id: string; venue_id: string; status: string }>(
    'orders',
    [Query.equal('group_booking_id', bookingId)],
  ).catch(() => []);

  const live = orders.filter((o) => !['CANCELLED', 'REJECTED'].includes(o.status));
  for (const o of live) {
    await db.createDocument(DB_ID, 'order_cancellations', ID.unique(), {
      venue_id: o.venue_id,
      order_id: o.$id,
      requested_at: new Date().toISOString(),
      status: 'requested',
    }).catch(() => undefined);
  }
  return { asked: live.length };
}

/** Whether the sittings of a booking are all off now. For the page to read back. */
export async function bookingIsCancelled(bookingId: string): Promise<boolean> {
  const orders = await listAll<{ status: string }>('orders', [Query.equal('group_booking_id', bookingId)])
    .catch(() => []);
  return orders.length > 0 && orders.every((o) => ['CANCELLED', 'REJECTED'].includes(o.status));
}

/** Bookings nobody has agreed to yet, soonest first. */
export async function pendingGroupBookings(): Promise<GroupBookingDoc[]> {
  const rows = await listAll<GroupBookingDoc>('group_bookings', [Query.equal('status', 'pending')])
    .catch(() => [] as GroupBookingDoc[]);
  return rows.sort((a, b) => (a.first_at ?? '').localeCompare(b.first_at ?? ''));
}

/**
 * Agree to a booking, or say it cannot be done.
 *
 * Writing the decision is what emails the guest: the function watches this
 * collection, so there is one place that decides and one place that tells
 * them, and the two cannot come apart.
 */
export async function decideGroupBooking(input: {
  id: string;
  status: 'approved' | 'refused';
  by: string;
  note?: string;
}): Promise<void> {
  await db.updateDocument(DB_ID, 'group_bookings', input.id, {
    status: input.status,
    decided_by: input.by,
    decided_at: new Date().toISOString(),
    decided_note: (input.note ?? '').slice(0, 1000),
  });
}
