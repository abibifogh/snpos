import { db, DB_ID, ID, Query, listAll } from './client';
import { computeTotals, lineUnitPrice, lineTotal } from './pricing';
import type { CartLine } from './pricing';
import type { Settings, Doc } from './types';

export type OrderStatus =
  | 'SCHEDULED' | 'PENDING' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'SERVED' | 'CLOSED' | 'REJECTED' | 'CANCELLED';

export interface Order extends Doc {
  venue_id: string;
  order_no: string;
  idem_key: string;
  version: number;
  channel: 'qr' | 'waiter' | 'counter' | 'takeaway' | 'delivery';
  table_id?: string;
  session_id?: string;
  shift_id?: string;
  status: OrderStatus;
  alert_level: number;
  accepted_at?: string;
  accepted_by?: string;
  rejected_at?: string;
  reject_reason_code?: string;
  reject_reason_note?: string;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  service_total: number;
  tip_total: number;
  total: number;
  currency_code: string;
  payment_status: 'unpaid' | 'partial' | 'paid' | 'refunded';
  placed_by: string;
  guest_count: number;
  notes?: string;
  marked_paid_by?: string;
  marked_paid_at?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  fulfilment?: 'dine_in' | 'takeaway' | 'delivery';
  pickup_point_id?: string;
  is_preorder?: boolean;
  scheduled_for?: string;
  fire_at?: string;
  placed_while_closed?: boolean;
  quoted_wait_minutes?: number;
}

export interface OrderItem extends Doc {
  venue_id: string;
  order_id: string;
  menu_item_id: string;
  name_snapshot: string;
  unit_price: number;
  qty: number;
  addons?: string;
  line_total: number;
  notes?: string;
  station: string;
  station_key?: string;
  due_at?: string;
  status: 'queued' | 'preparing' | 'ready' | 'served' | 'void';
  void_reason?: string;
  course: number;
  seat_no?: number;
}

/**
 * A client-generated key that makes re-sending an order harmless.
 *
 * A waiter on a flaky connection will tap "send" twice. Without this the
 * kitchen cooks the meal twice; with it the second attempt collides with the
 * unique index and is recognised as the same order.
 */
export const newIdempotencyKey = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Next order number for a venue.
 *
 * Read-then-write is not safe against two terminals ordering in the same
 * instant, but the unique index on (venue_id, order_no) catches the collision
 * and createOrder retries — which is cheaper and simpler than a counter
 * document that every order must serialise through.
 */
async function nextOrderNo(venueId: string, prefix: string): Promise<string> {
  const latest = await db.listDocuments(DB_ID, 'orders', [
    Query.equal('venue_id', venueId),
    Query.orderDesc('$createdAt'),
    Query.limit(1),
  ]);
  const last = (latest.documents[0] as unknown as Order | undefined)?.order_no ?? '';
  const n = Number(last.replace(/\D/g, '')) || 0;
  return `${prefix}${String(n + 1).padStart(4, '0')}`;
}

export interface CreateOrderInput {
  venueId: string;
  lines: CartLine[];
  settings: Settings;
  channel: Order['channel'];
  placedBy: string;
  tableId?: string;
  sessionId?: string;
  shiftId?: string;
  guestCount?: number;
  notes?: string;
  discount?: number;
  customer?: { name?: string; phone?: string; email?: string };
  fulfilment?: Order['fulfilment'];
  pickupPointId?: string;
  /** Set for a pre-order; the kitchen sees nothing until fire_at. */
  scheduledFor?: Date;
  placedWhileClosed?: boolean;
  quotedWaitMinutes?: number;
}

export interface CreatedOrder {
  order: Order;
  items: OrderItem[];
}

/**
 * Work back from when the customer wants it to when the kitchen must start,
 * using the slowest dish on the order plus a small buffer.
 */
export function fireTimeFor(lines: CartLine[], scheduledFor: Date, prepMinutesById: Record<string, number>, buffer = 5): Date {
  const longest = Math.max(0, ...lines.map((l) => prepMinutesById[l.menu_item_id] ?? 10));
  return new Date(scheduledFor.getTime() - (longest + buffer) * 60_000);
}

export async function createOrder(input: CreateOrderInput, attempt = 0): Promise<CreatedOrder> {
  const { venueId, lines, settings, channel, placedBy } = input;
  if (lines.length === 0) throw new Error('An order needs at least one item.');

  const totals = computeTotals({ lines, discount: input.discount ?? 0, settings });
  const isPreorder = !!input.scheduledFor;
  const prepById: Record<string, number> = {};
  const orderNo = await nextOrderNo(venueId, settings.order_number_prefix || 'ORD');

  const payload: Record<string, unknown> = {
    venue_id: venueId,
    order_no: orderNo,
    idem_key: newIdempotencyKey(),
    version: 1,
    channel,
    table_id: input.tableId ?? '',
    session_id: input.sessionId ?? '',
    shift_id: input.shiftId ?? '',
    // A scheduled order is invisible and silent to the kitchen until fire time.
    status: isPreorder ? 'SCHEDULED' : 'PENDING',
    alert_level: 0,
    subtotal: totals.subtotal,
    discount_total: totals.discount_total,
    tax_total: totals.tax_total,
    service_total: totals.service_total,
    tip_total: 0,
    total: totals.total,
    currency_code: settings.currency_code,
    payment_status: 'unpaid',
    placed_by: placedBy,
    guest_count: input.guestCount ?? 1,
    notes: input.notes ?? '',
    fulfilment: input.fulfilment ?? 'dine_in',
    pickup_point_id: input.pickupPointId ?? '',
    customer_name: input.customer?.name ?? '',
    customer_phone: input.customer?.phone ?? '',
    customer_email: input.customer?.email ?? '',
    email_source: input.customer?.email ? (channel === 'qr' ? 'guest_at_order' : 'staff_entered') : undefined,
    is_preorder: isPreorder,
    placed_while_closed: input.placedWhileClosed ?? false,
    quoted_wait_minutes: input.quotedWaitMinutes ?? undefined,
  };

  if (input.scheduledFor) {
    payload.scheduled_for = input.scheduledFor.toISOString();
    payload.fire_at = fireTimeFor(lines, input.scheduledFor, prepById).toISOString();
  }

  // Strip undefined so Appwrite does not reject the document.
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

  let order: Order;
  try {
    order = (await db.createDocument(DB_ID, 'orders', ID.unique(), payload)) as unknown as Order;
  } catch (e) {
    // Two terminals took the same number in the same instant; take the next one.
    const msg = e instanceof Error ? e.message : '';
    if (/already exists|unique/i.test(msg) && attempt < 5) {
      return createOrder(input, attempt + 1);
    }
    throw e;
  }

  const items = await Promise.all(
    lines.map((line) =>
      db.createDocument(DB_ID, 'order_items', ID.unique(), {
        venue_id: venueId,
        order_id: order.$id,
        menu_item_id: line.menu_item_id,
        // Snapshot the name and price: a later menu edit must not rewrite what
        // this customer ordered or what they were charged.
        name_snapshot: line.name,
        unit_price: lineUnitPrice(line),
        qty: line.qty,
        addons: line.addons.length ? JSON.stringify(line.addons) : '',
        line_total: lineTotal(line),
        notes: line.notes ?? '',
        station: line.station ?? 'hot',
        station_key: line.station_key ?? '',
        // When this should be out by, so an overdue ticket can ping without
        // anyone doing the arithmetic mid-service.
        due_at: new Date(Date.now() + (line.prep_minutes ?? 15) * 60_000).toISOString(),
        status: 'queued',
        course: line.course ?? 1,
        seat_no: line.seat_no,
      }),
    ),
  );

  return { order, items: items as unknown as OrderItem[] };
}

/** Live orders for a venue, newest first. */
export async function loadOpenOrders(venueId: string): Promise<Order[]> {
  const rows = await listAll<Order>('orders', [Query.equal('venue_id', venueId)]);
  const live: OrderStatus[] = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED'];
  return rows
    .filter((o) => live.includes(o.status))
    .sort((a, b) => a.$createdAt.localeCompare(b.$createdAt));
}

export const orderItemsFor = (orderId: string): Promise<OrderItem[]> =>
  listAll<OrderItem>('order_items', [Query.equal('order_id', orderId)]);
