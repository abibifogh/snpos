import { db, DB_ID, Query, listAll, saveDropping } from './client';
import { loadIngredients } from './stock';
import {
  orderTotal, readLines, nextPoNo, submittedStatus, receiveInto, isOpenOrder,
} from './purchase-orders';
import type { PoLine, PoStatus, OrderSupplier } from './purchase-orders';
import type { Module } from './access';
import type { Ingredient } from './stock';

/**
 * Reading and writing orders to suppliers. The rules are in purchase-orders.ts.
 */

export interface PurchaseOrderDoc {
  $id: string;
  $createdAt?: string;
  venue_id: string;
  po_no: string;
  module?: Module;
  supplier_id?: string;
  supplier_name?: string;
  supplier_email?: string;
  supplier_phone?: string;
  status: PoStatus;
  lines?: string;
  total?: number;
  note?: string;
  expected_on?: string;
  created_by?: string;
  created_by_name?: string;
  approved_by?: string;
  approved_at?: string;
  decided_note?: string;
  sent_at?: string;
  sent_via?: string;
  email_send_at?: string | null;
  email_error?: string;
  received_at?: string;
  expense_ids?: string;
}

export const loadPurchaseOrders = (venueId: string): Promise<PurchaseOrderDoc[]> =>
  listAll<PurchaseOrderDoc>('purchase_orders', [Query.equal('venue_id', venueId)])
    .then((rows) => rows.sort((a, b) => (b.$createdAt ?? '').localeCompare(a.$createdAt ?? '')));

/** Orders still to arrive on one side: what a spend can receive. */
export async function openOrdersFor(venueId: string, module?: Module): Promise<PurchaseOrderDoc[]> {
  const rows = await loadPurchaseOrders(venueId).catch(() => [] as PurchaseOrderDoc[]);
  return rows.filter((o) => isOpenOrder(o.status) && (!module || (o.module ?? 'kitchen') === module));
}

/** Orders waiting for somebody to approve them, for Waiting for you. */
export const ordersWaiting = (): Promise<PurchaseOrderDoc[]> =>
  listAll<PurchaseOrderDoc>('purchase_orders', [Query.equal('status', 'waiting')]).catch(() => []);

/** What can be ordered, and who from. */
export async function loadOrderables(venueId: string): Promise<{ items: Ingredient[]; suppliers: OrderSupplier[] }> {
  const [items, suppliers] = await Promise.all([
    loadIngredients(venueId),
    listAll<OrderSupplier>('suppliers').catch(() => [] as OrderSupplier[]),
  ]);
  return { items, suppliers: suppliers.filter((s) => s.active !== false) };
}

/**
 * Write an order, new or changed. A new one takes the next number.
 *
 * `submit` finishes it: it goes to "ready to send", or to "waiting for
 * approval" when it is worth more than the limit and whoever wrote it is not
 * an admin. Without it the order is kept as a draft.
 */
export async function savePurchaseOrder(input: {
  id?: string;
  venueId: string;
  module: Module;
  supplier: { $id?: string; name: string; email?: string; phone?: string };
  lines: PoLine[];
  note?: string;
  expectedOn?: string;
  submit: boolean;
  approveOver: number;
  isAdmin: boolean;
  by: string;
  byName?: string;
}): Promise<PurchaseOrderDoc> {
  const lines = input.lines.filter((l) => l.qty > 0);
  const total = orderTotal(lines);
  const status: PoStatus = input.submit ? submittedStatus(total, input.approveOver, input.isAdmin) : 'draft';
  const body: Record<string, unknown> = {
    venue_id: input.venueId,
    module: input.module,
    supplier_id: input.supplier.$id ?? '',
    supplier_name: input.supplier.name.trim(),
    supplier_email: (input.supplier.email ?? '').trim(),
    supplier_phone: (input.supplier.phone ?? '').trim(),
    status,
    lines: JSON.stringify(lines),
    total,
    note: (input.note ?? '').slice(0, 1000),
    expected_on: input.expectedOn ?? '',
    // An admin's own order over the limit is approved by writing it.
    ...(status === 'ready' && input.isAdmin ? { approved_by: input.by, approved_at: new Date().toISOString() } : {}),
  };
  if (input.id) {
    await saveDropping('purchase_orders', input.id, body);
    return db.getDocument(DB_ID, 'purchase_orders', input.id) as unknown as Promise<PurchaseOrderDoc>;
  }
  const used = await listAll<{ po_no: string }>('purchase_orders', [Query.equal('venue_id', input.venueId)])
    .then((rows) => rows.map((r) => r.po_no)).catch(() => [] as string[]);
  const { id } = await saveDropping('purchase_orders', null, {
    ...body,
    po_no: nextPoNo(used),
    created_by: input.by,
    created_by_name: input.byName ?? '',
  });
  return db.getDocument(DB_ID, 'purchase_orders', id) as unknown as Promise<PurchaseOrderDoc>;
}

/** Agree to an order over the limit, or not. Agreed, it is ready to send. */
export async function decidePurchaseOrder(input: {
  id: string; approve: boolean; by: string; note?: string;
}): Promise<void> {
  await saveDropping('purchase_orders', input.id, {
    status: input.approve ? 'ready' : 'refused',
    approved_by: input.by,
    approved_at: new Date().toISOString(),
    decided_note: (input.note ?? '').slice(0, 500),
  });
}

/**
 * Mark it gone to the supplier, by whichever way it went. Copying the message
 * or downloading the PDF does not do this on its own: somebody may copy it
 * and never send it, so they say when they have.
 */
export async function markOrderSent(id: string, via: string): Promise<void> {
  await saveDropping('purchase_orders', id, { status: 'sent', sent_at: new Date().toISOString(), sent_via: via });
}

/**
 * Ask for it to be emailed to the supplier. A request, not a send: the notify
 * job builds the PDF, sends it, and marks the order sent once it has gone.
 */
export async function askToEmailOrder(id: string): Promise<void> {
  await saveDropping('purchase_orders', id, { email_send_at: new Date().toISOString(), email_error: '' });
}

export async function cancelPurchaseOrder(id: string): Promise<void> {
  await saveDropping('purchase_orders', id, { status: 'cancelled' });
}

/**
 * A spend has received some or all of an order.
 *
 * `got` is what the spend took into stock, in counting units. The order's
 * lines are moved on, its status becomes part received or received, and the
 * spend is noted on it so the order says what paid for it.
 */
export async function receiveOrderFromSpend(input: {
  orderId: string;
  expenseId: string;
  got: { ingredient_id: string; qty: number }[];
}): Promise<PoStatus> {
  const o = await db.getDocument(DB_ID, 'purchase_orders', input.orderId) as unknown as PurchaseOrderDoc;
  const { lines, status } = receiveInto(readLines(o.lines), input.got);
  const ids = [...new Set([...(o.expense_ids ?? '').split(',').filter(Boolean), input.expenseId])].join(',');
  await saveDropping('purchase_orders', input.orderId, {
    lines: JSON.stringify(lines),
    status,
    expense_ids: ids.slice(0, 1000),
    ...(status === 'received' ? { received_at: new Date().toISOString() } : {}),
  });
  return status;
}
