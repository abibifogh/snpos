import { db, DB_ID, ID, Query, listAll, listByIds } from './client';
import { recomputeOrderTotals } from './orders';
import { recomputeClosedShift, repostShiftAccounts } from './shifts';
import { restorePlan } from './till-charged';
import type { Restore, RestorableOrder, RestorableLine, RestorePayment, RewriteLog } from './till-charged';
import type { Order } from './orders';
import type { Settings } from './types';

/**
 * Read everything the plan needs. See till-charged.ts for what it decides.
 *
 * A read that fails throws rather than coming back empty: "nothing to put
 * back" must never be the answer to "could not look".
 */
export async function loadRestorePlan(venueId: string): Promise<Restore[]> {
  const logs = await listAll<RewriteLog & { $id: string }>('audit_log', [
    Query.equal('action', 'order_price_corrected'),
    Query.equal('venue_id', venueId),
  ]);
  const ids = [...new Set(logs.map((l) => l.entity_id ?? '').filter(Boolean))];
  if (ids.length === 0) return [];
  const [orders, lines, payments] = await Promise.all([
    listByIds<RestorableOrder>('orders', '$id', ids),
    listByIds<RestorableLine>('order_items', 'order_id', ids),
    listByIds<RestorePayment>('payments', 'order_id', ids),
  ]);
  return restorePlan({ logs, orders, lines, payments });
}

/**
 * Put the plan's lines back, then everything worked out from them.
 *
 * The lines, then each bill's totals through the same recompute every other
 * correction uses, then each shift those bills sit on — its stored figures,
 * and its books reposted so the tax split follows the bills. The sales in the
 * books were already posted from the payments, which were right all along.
 */
export async function applyRestorePlan(opts: {
  plan: Restore[];
  settings: Settings;
  userId: string;
  role: string;
  venueId: string;
}): Promise<{ lines: number; bills: number; shifts: number; notes: string[] }> {
  const notes: string[] = [];
  let lines = 0;
  for (const r of opts.plan) {
    await db.updateDocument(DB_ID, 'order_items', r.lineId, {
      unit_price: r.qty > 0 ? Math.round(r.to / r.qty) : r.to,
      line_total: r.to,
    });
    lines += 1;
  }

  const orderIds = [...new Set(opts.plan.map((r) => r.orderId))];
  const orders = await listByIds<Order>('orders', '$id', orderIds);
  for (const o of orders) {
    await recomputeOrderTotals(o, opts.settings).catch(() => null);
  }

  const shiftIds = [...new Set(opts.plan.map((r) => r.shiftId).filter(Boolean))];
  for (const id of shiftIds) {
    await recomputeClosedShift(id).catch(() => null);
    const done = await repostShiftAccounts({
      shiftId: id, userId: opts.userId, reason: 'Bills put back to what the till charged',
    }).catch((e) => ({ changed: false, note: e instanceof Error ? e.message : String(e) }));
    if (done.note) notes.push(done.note);
  }

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: opts.venueId,
    actor_id: opts.userId,
    actor_role: opts.role,
    action: 'order_till_price_restored',
    entity_type: 'orders',
    entity_id: orderIds[0] ?? '',
    after: JSON.stringify(opts.plan.map((r) => [r.orderNo, r.name, r.from, r.to])).slice(0, 3900),
    reason: 'The server had rewritten prices the till charged and the customer paid',
  }).catch(() => undefined);

  return { lines, bills: orderIds.length, shifts: shiftIds.length, notes };
}
