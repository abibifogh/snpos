import { db, DB_ID, Query, Permission, Role, account, listAll } from './client';
import { NO_LIMIT, SlotFull, placeOrder, seatId, slotIsFull, slotStamp } from './slots';

/**
 * Taking a place in a pre-order time slot, and giving it back.
 *
 * The reasoning is in slots.ts. In short: a place is a row whose id is worked
 * out from the slot and the place number, so claiming one is a create that
 * either succeeds or collides, and two people cannot both take the last one.
 */

export interface SlotSeat {
  $id: string;
  venue_id: string;
  pickup_point_id?: string;
  slot_start: string;
  place: number;
}

const COLLECTION = 'preorder_seats';

/** Appwrite's word for "that id is taken", which here means somebody beat us to the place. */
const isTaken = (e: unknown): boolean => {
  const code = (e as { code?: number })?.code;
  const type = (e as { type?: string })?.type;
  return code === 409 || type === 'document_already_exists';
};

/** How many places are booked in one exact slot. */
export async function placesTaken(venueId: string, at: Date): Promise<number> {
  const rows = await listAll<SlotSeat>(COLLECTION, [
    Query.equal('venue_id', venueId),
    Query.equal('slot_start', at.toISOString()),
  ]).catch(() => [] as SlotSeat[]);
  return rows.length;
}

/**
 * How many places are booked in each slot across a stretch of time.
 *
 * One read for the whole picker rather than one per time offered, keyed by
 * the slot's stamp so the caller can look a time up without matching strings
 * that may differ in their milliseconds.
 */
export async function placesBySlot(venueId: string, from: Date, to: Date): Promise<Map<string, number>> {
  const rows = await listAll<SlotSeat>(COLLECTION, [
    Query.equal('venue_id', venueId),
    Query.greaterThanEqual('slot_start', from.toISOString()),
    Query.lessThanEqual('slot_start', to.toISOString()),
  ]).catch(() => [] as SlotSeat[]);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = slotStamp(new Date(r.slot_start));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Take a place, or say the time is full.
 *
 * Returns the row's id so the order can hold on to it and give it back if it
 * is cancelled, or null where there is no cap and so nothing to claim.
 *
 * The count is only a starting guess at which place is free. It is never
 * trusted: the claim is the create, and a create that collides means somebody
 * else has that place, so the next one is tried. The count being stale is
 * therefore a slower claim, never a double booking.
 */
export async function claimPlace(opts: {
  venueId: string;
  pickupPointId?: string;
  at: Date;
  capacity: number;
}): Promise<string | null> {
  const { venueId, pickupPointId, at, capacity } = opts;
  if (capacity <= NO_LIMIT) return null;

  const taken = await placesTaken(venueId, at);
  if (slotIsFull(taken, capacity)) throw new SlotFull();

  // The guest gets delete on their own place, so cancelling within the
  // window gives the time back to the next customer. Staff can delete any.
  const me = await account.get().catch(() => null);
  const mine = me ? [Permission.delete(Role.user(me.$id))] : [];

  for (const place of placeOrder(taken, capacity)) {
    const id = seatId(venueId, pickupPointId, at, place);
    try {
      const row = await db.createDocument(DB_ID, COLLECTION, id, {
        venue_id: venueId,
        pickup_point_id: pickupPointId ?? '',
        slot_start: at.toISOString(),
        place,
      }, mine);
      return row.$id;
    } catch (e) {
      // Somebody else holds that place. Any other failure is a real one and
      // must not be read as a full slot: telling a customer the time is gone
      // when the network dropped sends them away for no reason.
      if (!isTaken(e)) throw e;
    }
  }
  throw new SlotFull();
}

/**
 * Give a place back.
 *
 * Deliberately quiet about failing. It is called when an order could not be
 * created and when one is cancelled, and in both cases the thing the customer
 * cares about has already happened; a place that stays claimed costs one
 * booking at one time, and shouting about it would replace a real message
 * with a meaningless one.
 */
export async function releasePlace(seatDocId?: string | null): Promise<void> {
  if (!seatDocId) return;
  await db.deleteDocument(DB_ID, COLLECTION, seatDocId).catch(() => undefined);
}
