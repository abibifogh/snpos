import { db, DB_ID, ID, Query, listAll } from './client';
import { claimPlace, releasePlace } from './slot-booking';
import { fireAtFor, sittingMoveProblem, spanOf } from './sitting-move';
import { APPROVAL_KIND } from './booking-approval';
import type { Sitting } from './sitting-move';

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
  /** Set when somebody has asked for the team's notice to go again. */
  notice_resend_at?: string | null;
  /*
    A revision sent to the party, and their answer to it. Two stamps rather
    than a flag, so "agreed to, and then changed again" is legible — which
    looks exactly like agreement and is not. See approvalState.
  */
  /** Asked for and not yet sent; the job clears it. */
  approval_send_at?: string | null;
  approval_requested_at?: string | null;
  approval_given_at?: string | null;
  /** What changed, in the words of whoever changed it. The party reads this. */
  approval_note?: string;
  $createdAt?: string;
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

/**
 * Every booking in a window, newest first.
 *
 * `pendingGroupBookings` below answers "what is waiting for me", which is the
 * right question for the Waiting page and the only question anything could
 * ask: a booking that had been approved, refused or cancelled was reachable
 * from no screen in the system. So when the notice to the team failed — and
 * it did — there was nothing to open and nothing to press.
 */
export async function groupBookingsBetween(fromIso: string, toIso: string): Promise<GroupBookingDoc[]> {
  const rows = await listAll<GroupBookingDoc>('group_bookings', [
    Query.greaterThanEqual('$createdAt', fromIso),
    Query.lessThanEqual('$createdAt', toIso),
  ]).catch(() => [] as GroupBookingDoc[]);
  return rows.sort((a, b) => (b.$createdAt ?? '').localeCompare(a.$createdAt ?? ''));
}

/**
 * Ask for the team's notice to go out again.
 *
 * A request, not a send. Nothing in a browser may write to order_notices —
 * it is the record of what was sent, and a screen able to edit it could
 * rewrite history — and the booking is already a row the background job
 * watches, so asking here needs no new trigger and no new permission. The
 * same shape as asking for a shift summary again.
 *
 * The job clears the field once it has gone, so a value here means somebody
 * is waiting rather than that somebody once asked.
 */
export async function resendBookingNotice(bookingId: string): Promise<void> {
  await db.updateDocument(DB_ID, 'group_bookings', bookingId, {
    notice_resend_at: new Date().toISOString(),
  });
}

/** Whether a resend is still waiting to go out. For the button to say so. */
export const resendPendingFor = (b: GroupBookingDoc): boolean => !!b.notice_resend_at;

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

/* ------------------------------------------------- moving a sitting's hour */

/** One sitting of a booking, with enough of its order to show and to move. */
export interface BookingSitting extends Sitting {
  order_no?: string;
  venue_id: string;
  guest_count?: number;
  total?: number;
  pickup_point_id?: string;
}

/** The sittings behind one booking, in the order they will be cooked. */
export async function sittingsOf(bookingId: string): Promise<BookingSitting[]> {
  const rows = await listAll<BookingSitting>('orders', [
    Query.equal('group_booking_id', bookingId),
  ]).catch(() => [] as BookingSitting[]);
  return rows.sort((a, b) => String(a.scheduled_for ?? '').localeCompare(String(b.scheduled_for ?? '')));
}

/**
 * Move one sitting to a different hour.
 *
 * THE PLACE IS TAKEN BEFORE THE OLD ONE IS GIVEN BACK, and that order matters
 * more than it looks. Release first and a slot that fills in the half second
 * between the two leaves this party holding neither time — their own hour gone
 * and the new one taken by somebody else, from a button that was meant to
 * help. Claim first and the worst case is one place held twice for an instant,
 * which costs nothing and gives itself back.
 *
 * The times on the booking row are then worked out again from the sittings, so
 * "first_at" is whatever the earliest sitting now is rather than whatever it
 * was when the party ordered. See spanOf.
 *
 * What it does NOT do is tell anybody. A move is usually one of several — a
 * coach is late and all four sittings shift — and a message per move would
 * reach the party four times with three of them wrong. Sending is its own
 * button, pressed once the diary is right. See resendBookingNotice.
 */
export async function moveSitting(input: {
  booking: GroupBookingDoc;
  sitting: BookingSitting;
  to: Date;
  /** Places per slot, from the preorders feature. Zero means uncapped. */
  slotCapacity?: number;
  /** Who moved it, for the audit log. */
  by: string;
  byRole?: string;
}): Promise<{ firstAt?: string; lastAt?: string }> {
  const { booking, sitting, to } = input;

  /*
    Checked here as well as on the form. The form's clock is the browser's and
    its copy of the sitting is however old the page is, so a rule enforced only
    there is a rule anybody with a stale tab can walk through.
  */
  const problem = sittingMoveProblem({ sitting, to });
  if (problem) throw new Error(problem);

  const capacity = input.slotCapacity ?? 0;
  const seat = capacity > 0
    ? await claimPlace({
      venueId: sitting.venue_id,
      pickupPointId: sitting.pickup_point_id,
      at: to,
      capacity,
    })
    : null;

  const was = sitting.scheduled_for;
  try {
    await db.updateDocument(DB_ID, 'orders', sitting.$id, {
      scheduled_for: to.toISOString(),
      fire_at: fireAtFor(sitting, to).toISOString(),
      ...(capacity > 0 ? { preorder_seat_id: seat ?? '' } : {}),
    });
  } catch (e) {
    // The order did not move, so the new place must not be kept: holding it
    // would quietly shrink a slot nobody is booked into.
    await releasePlace(seat);
    throw e;
  }

  // Only now, once the move is a fact.
  if (capacity > 0) await releasePlace(sitting.preorder_seat_id);

  const span = spanOf(
    (await sittingsOf(booking.$id)).map((s) => (s.$id === sitting.$id
      ? { ...s, scheduled_for: to.toISOString() }
      : s)),
  );
  if (span && (span.firstAt !== booking.first_at || span.lastAt !== booking.last_at)) {
    await db.updateDocument(DB_ID, 'group_bookings', booking.$id, {
      first_at: span.firstAt,
      last_at: span.lastAt,
    }).catch(() => undefined);
  }

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: sitting.venue_id,
    actor_id: input.by,
    actor_role: input.byRole ?? '',
    action: 'sitting_moved',
    entity_type: 'orders',
    entity_id: sitting.$id,
    before: JSON.stringify({ order_no: sitting.order_no, scheduled_for: was }),
    after: JSON.stringify({ order_no: sitting.order_no, scheduled_for: to.toISOString() }),
  }).catch(() => undefined);

  return { firstAt: span?.firstAt, lastAt: span?.lastAt };
}

/* --------------------------------- sending a revision back to be agreed to */

/**
 * Send the booking as it now stands to the party, to be agreed to.
 *
 * A request written on the row, not a message sent from here. The background
 * job watches this collection, builds the revised sheet and sends it — the
 * same route the first notice takes, so the party's copy and the kitchen's
 * copy can never be built by two different pieces of code.
 *
 * What is written is the ASKING. The job clears it and stamps when the email
 * actually went, so the row can never say "waiting on the party" about a
 * message that never left — which would send somebody to chase a guest who was
 * never written to.
 *
 * The old answer is left where it is rather than wiped, because the pair of
 * stamps is what carries the meaning: sent today, agreed to last week, so it is
 * waiting. Clearing would lose the fact that they ever agreed to anything, and
 * a row reading "party agreed" about a booking they have never seen is the
 * precise failure this exists to prevent either way. See approvalState.
 */
export async function sendBookingForApproval(input: {
  bookingId: string;
  /** What changed, in the words of whoever changed it. The party reads this. */
  note?: string;
}): Promise<void> {
  await db.updateDocument(DB_ID, 'group_bookings', input.bookingId, {
    approval_send_at: new Date().toISOString(),
    approval_note: (input.note ?? '').trim().slice(0, 1000),
  });
}

/**
 * The party agreeing to the revision, from the link they were sent.
 *
 * Written as a change request rather than onto the booking, because a guest
 * cannot write to a booking row and should not be able to: a link that could
 * edit a booking is a link that could empty a pass. The job reads this, stamps
 * the booking, and tells the house. See APPROVAL_KIND.
 */
export async function approveBookingRevision(input: {
  booking: GroupBookingDoc;
  /** Anything they want to say along with it. */
  note?: string;
}): Promise<void> {
  await db.createDocument(DB_ID, 'booking_changes', ID.unique(), {
    venue_id: input.booking.venue_id,
    booking_id: input.booking.$id,
    contact_name: input.booking.contact_name ?? '',
    reference: input.booking.reference ?? '',
    email: input.booking.email ?? '',
    kind: APPROVAL_KIND,
    // Never empty: the column is required, and "they pressed the button" is
    // the honest content of an approval with nothing typed on it.
    note: (input.note ?? '').trim().slice(0, 2000) || 'Agreed to the revised booking.',
    ...(input.booking.first_at ? { first_at: input.booking.first_at } : {}),
    status: 'open',
  });
}
