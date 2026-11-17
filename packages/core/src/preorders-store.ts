import { db, DB_ID, Query, listAll, saveDropping } from './client';
import { releaseDue } from './preorders';
import type { Order, OrderItem } from './orders';

/**
 * Reading pre-orders for the till, and releasing one the server has not.
 *
 * The rules are in preorders.ts.
 */

/** Pre-orders still waiting, and those released in the last few hours, for this venue. */
export async function loadBooked(venueId: string): Promise<Order[]> {
  const since = new Date(Date.now() - 4 * 3_600_000).toISOString();
  const [waiting, recent] = await Promise.all([
    listAll<Order>('orders', [Query.equal('venue_id', venueId), Query.equal('status', 'SCHEDULED')]),
    listAll<Order>('orders', [
      Query.equal('venue_id', venueId),
      Query.equal('is_preorder', true),
      Query.greaterThanEqual('fire_at', since),
    ]).catch(() => [] as Order[]),
  ]);
  const seen = new Set(waiting.map((o) => o.$id));
  return [...waiting, ...recent.filter((o) => !seen.has(o.$id))];
}

export const bookedItems = (orderIds: string[]): Promise<OrderItem[]> =>
  orderIds.length === 0
    ? Promise.resolve([])
    : listAll<OrderItem>('order_items', [Query.equal('order_id', orderIds.slice(0, 100))]);

/**
 * Send a pre-order to the kitchen now: early, from the till's Send button,
 * or late, because the server has not. Read again first, so an order the
 * server or another screen released a moment ago is left alone.
 */
export async function releaseBooked(orderId: string, by: string): Promise<boolean> {
  const now = await db.getDocument(DB_ID, 'orders', orderId).catch(() => null) as unknown as Order | null;
  if (!now || now.status !== 'SCHEDULED') return false;
  await saveDropping('orders', orderId, {
    status: 'PENDING',
    alert_level: 0,
    fired_at: new Date().toISOString(),
    released_by: by.slice(0, 40),
  });
  return true;
}

/**
 * The backup: release every pre-order still waiting two minutes past its
 * start time. Run by any till or kitchen screen that is open, once a minute.
 * Returns the order numbers it released, so the screen can say so.
 */
export async function releaseOverdue(venueId: string, by: string): Promise<string[]> {
  const waiting = await listAll<Order>('orders', [
    Query.equal('venue_id', venueId),
    Query.equal('status', 'SCHEDULED'),
    Query.lessThanEqual('fire_at', new Date().toISOString()),
  ]).catch(() => [] as Order[]);
  const released: string[] = [];
  for (const o of waiting.filter((x) => releaseDue(x))) {
    if (await releaseBooked(o.$id, by).catch(() => false)) released.push(o.order_no);
  }
  return released;
}
