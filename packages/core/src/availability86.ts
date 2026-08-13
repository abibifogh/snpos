import { db, DB_ID, ID, Query, listAll } from './client';
import type { Doc, MenuItem } from './types';

/**
 * Taking a dish off the menu mid-service, and putting it back.
 *
 * Called "86ing" in most kitchens. The person who discovers the chicken has
 * run out is whoever opened the fridge, so anyone working can do it, making
 * them find a manager first is exactly how a sold-out dish keeps being ordered
 * for another hour.
 *
 * Each event is logged rather than only flipping a flag on the dish, because
 * the useful questions are historical: what did we run out of during that
 * shift, and what has been off for two days without anybody noticing.
 */

export interface AvailabilityEvent extends Doc {
  venue_id: string;
  menu_item_id: string;
  name_snapshot: string;
  shift_id?: string;
  marked_off_at: string;
  marked_off_by?: string;
  marked_off_name?: string;
  reason?: string;
  restored_at?: string;
  restored_by?: string;
  alerted_at?: string;
}

/**
 * Fields this write does not care about but has to carry anyway.
 *
 * `is_one_off` was added to the menu table for the craft shop, and was added as
 * required. Appwrite checks a document against the requirements as they stand
 * now, not as they stood when it was written, so every dish that existed before
 * that day fails the check on ANY change — and marking one sold out came back
 * as "missing required attribute is_one_off", which is a craft shop field being
 * quoted at a cook who has run out of chicken.
 *
 * The attribute is no longer required in the schema, which is the actual fix,
 * but that only takes effect when the project is next provisioned. Passing the
 * item's own value through means the pass keeps working tonight either way.
 * Its own value, never a flat false: a handmade one-off is still a one-off
 * after it sells out, and quietly turning that off would lose it.
 */
const carried = (item: Pick<MenuItem, 'is_one_off'>) => ({ is_one_off: item.is_one_off ?? false });

/** Take a dish off the menu now. */
export async function markUnavailable(opts: {
  venueId: string;
  item: Pick<MenuItem, '$id' | 'name' | 'is_one_off'>;
  userId?: string;
  userName?: string;
  shiftId?: string;
  reason?: string;
}): Promise<void> {
  const now = new Date().toISOString();

  await db.updateDocument(DB_ID, 'menu_items', opts.item.$id, {
    // Far enough ahead that it stays off until somebody puts it back. A dish
    // that quietly returns to the menu at midnight is worse than one that
    // needs a tap, because nobody checked whether the chicken arrived.
    sold_out_until: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
    unavailable_since: now,
    unavailable_by: opts.userId ?? '',
    unavailable_reason: opts.reason ?? '',
    ...carried(opts.item),
  });

  await db.createDocument(DB_ID, 'item_availability', ID.unique(), {
    venue_id: opts.venueId,
    menu_item_id: opts.item.$id,
    name_snapshot: opts.item.name,
    shift_id: opts.shiftId ?? '',
    marked_off_at: now,
    marked_off_by: opts.userId ?? '',
    marked_off_name: opts.userName ?? '',
    reason: opts.reason ?? '',
  });
}

/** Put it back on the menu. */
export async function markAvailable(opts: {
  item: Pick<MenuItem, '$id' | 'is_one_off'>;
  userId?: string;
}): Promise<void> {
  const now = new Date().toISOString();

  await db.updateDocument(DB_ID, 'menu_items', opts.item.$id, {
    sold_out_until: '',
    unavailable_since: '',
    unavailable_by: '',
    unavailable_reason: '',
    // See the note on `carried`. Putting a dish back had the same fault as
    // taking it off, and would have been found an hour later.
    ...carried(opts.item),
  });

  // Close the open log row rather than writing a second one, so one absence
  // reads as one absence however many times the page was refreshed.
  const open = await listAll<AvailabilityEvent>('item_availability', [
    Query.equal('menu_item_id', opts.item.$id),
    Query.isNull('restored_at'),
  ]).catch(() => [] as AvailabilityEvent[]);

  for (const row of open) {
    await db
      .updateDocument(DB_ID, 'item_availability', row.$id, {
        restored_at: now,
        restored_by: opts.userId ?? '',
      })
      .catch(() => undefined);
  }
}

/** Is this dish off the menu right now? */
export const isUnavailable = (item: MenuItem): boolean =>
  !!item.sold_out_until && new Date(item.sold_out_until) > new Date();

/** Everything taken off during one shift, for that shift's summary. */
export const unavailableDuringShift = (shiftId: string): Promise<AvailabilityEvent[]> =>
  listAll<AvailabilityEvent>('item_availability', [Query.equal('shift_id', shiftId)]);

/**
 * Items still off after the configured wait.
 *
 * Only those not yet alerted about: an admin told once will act or decide not
 * to, and telling them hourly until they do is how a warning becomes noise.
 */
export async function overdueUnavailable(hours: number): Promise<AvailabilityEvent[]> {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  const open = await listAll<AvailabilityEvent>('item_availability', [Query.isNull('restored_at')]).catch(
    () => [] as AvailabilityEvent[],
  );
  return open.filter((r) => !r.alerted_at && r.marked_off_at < cutoff);
}
