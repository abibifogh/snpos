import { db, DB_ID, ID, Query, Permission, Role, account, listAll } from './client';
import { cookMinutes, estimateMinutes, fireTimeFor } from './orders-time';

/**
 * The timing arithmetic lives next door, in a file that imports nothing.
 *
 * Re-exported so every caller keeps working. The split exists so the figure a
 * customer is quoted and the figure a kitchen is judged by can be tested
 * without selling anything, not to make callers choose a file.
 */
export {
  MAX_ETA_MINUTES, shownEta, cookMinutes, estimateMinutes, queueMinutes, dueMinutes, fireTimeFor,
  CANCEL_WINDOW_MS, cancelWindowLeft, LINES_GRACE_MS, ticketLines, isOverdue, minutesOver,
} from './orders-time';
import { createOrQueue, isOffline } from './offline';
import { computeTotals, lineUnitPrice, lineTotal } from './pricing';
import type { CartLine } from './pricing';
import type { Settings, Doc } from './types';
import type { Module } from './access';

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
  /**
   * Set when this order was taken after its shift had already run past its
   * limit. The shift closes without it; the next shift opened picks it up.
   */
  shelved_at?: string | null;
  shelved_from_shift?: string;
  status: OrderStatus;
  alert_level: number;
  accepted_at?: string;
  accepted_by?: string;
  /** When the food left the pass, and when a booked order was released to it. */
  served_at?: string;
  fired_at?: string;
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
  seat_note?: string;
  is_group?: boolean;
  group_reference?: string;
  group_size?: number;
  group_contact_name?: string;
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
  /** What the customer was told: cooking time plus the queue ahead of them. */
  eta_minutes?: number;
  /** What the kitchen is judged by: the cooking time alone. */
  prep_minutes?: number;
  /** Which side of the business sold this. Absent means kitchen. */
  module?: 'kitchen' | 'craft';
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
  /** The prep time this dish had when it was ordered. */
  prep_minutes?: number;
  // ------------------------------------------------------------- craft shop
  // Which variant sold, whose it was and what was agreed, snapshotted here
  // because a statement worked out from today's rate would restate what
  // somebody was paid last year.
  variant_id?: string;
  variant_label?: string;
  consignor_id?: string;
  commission_bp?: number;
  /** A flat per-piece commission, when that is what was agreed. */
  commission_flat?: number;
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
 * The prefix, the width and whether numbering restarts each day are the
 * restaurant's to decide, these numbers get shouted across a pass, and a
 * kitchen that counts to four digits forever is being made to work around the
 * software rather than the other way round.
 *
 * Still derived from the last order rather than from a counter document.
 * Read-then-write is not safe against two terminals ordering in the same
 * instant, but the unique index on (venue_id, order_no) catches the collision
 * and createOrder retries, cheaper and simpler than a counter every order
 * must serialise through.
 *
 * Only staff can do this. Reading the last order means reading orders, and a
 * guest deliberately cannot, see the note on the collection. Guests get
 * `provisionalOrderNo` instead and order-guard settles the real number the
 * moment the order lands.
 */
async function nextOrderNo(venueId: string, settings: Settings, module: Module = 'kitchen'): Promise<string> {
  /**
   * Each side counts on its own.
   *
   * A shared run of numbers meant a shop receipt and a restaurant receipt could
   * look alike and sort together, while the two sides keep separate books
   * everywhere else. The craft prefix falls back to the kitchen's when it is
   * blank, which is what a business running only one side wants.
   */
  const prefix = module === 'craft'
    ? (settings.craft_order_prefix ?? 'S') || (settings.order_number_prefix ?? '')
    : settings.order_number_prefix ?? '';
  const padding = Math.max(1, settings.order_number_padding ?? 4);
  const daily = settings.order_number_mode === 'daily';

  // A window rather than the single newest row. Guest orders sit on a
  // placeholder for a second or so before the server settles them, and the
  // newest order is quite often one of those, reading it as "the last number"
  // would send the count back to the beginning.
  const queries = [Query.equal('venue_id', venueId), Query.orderDesc('$createdAt'), Query.limit(80)];
  if (daily) {
    // Only today's orders count, so tomorrow starts at one again.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    queries.push(Query.greaterThanEqual('$createdAt', midnight.toISOString()));
  } else if (settings.order_number_reset_on) {
    // An admin reset the numbering: orders from before that moment are not
    // part of this run, so the count starts again from where they said.
    queries.push(Query.greaterThanEqual('$createdAt', settings.order_number_reset_on));
  }

  const latest = await db.listDocuments(DB_ID, 'orders', queries);
  // Only this side's, so the two sequences never read each other's last number.
  const numbered = (latest.documents as unknown as Order[])
    .filter((o) => !isProvisionalOrderNo(o.order_no) && (o.module ?? 'kitchen') === module);
  const last = numbered[0]?.order_no ?? '';
  // Strip the prefix before reading the number, so a prefix containing digits
  // ("B2-") does not get counted as part of it.
  const digits = (prefix && last.startsWith(prefix) ? last.slice(prefix.length) : last).replace(/\D/g, '');
  const n = Number(digits) || 0;
  const from = numbered.length === 0 ? Math.max(1, settings.order_number_next ?? 1) : n + 1;
  return `${prefix}${String(from).padStart(padding, '0')}`;
}

/**
 * Give a real number to any order still sitting on a placeholder.
 *
 * The server settles these the moment an order lands, and normally there is
 * nothing here to do. This exists because "normally" is doing a lot of work in
 * that sentence: if the function is mid-deploy, erroring, or simply has not
 * been redeployed yet, an order keeps its placeholder forever and no screen in
 * the building can put it right.
 *
 * Staff can read and update orders, so any staff screen that is open can heal
 * them. Safe to call often; it does nothing when there is nothing to fix.
 */
export async function settleOrderNumbers(venueId: string, settings: Settings): Promise<number> {
  const byPrefix = [
    Query.equal('venue_id', venueId),
    Query.orderAsc('$createdAt'),
    Query.limit(100),
    Query.startsWith('order_no', PROVISIONAL_MARK),
  ];
  // The narrow query needs the plain index on order_no. If provisioning has
  // not run since that index was added, fall back to reading recent orders and
  // filtering here, slower, but it still heals them.
  const stuck = (await db
    .listDocuments(DB_ID, 'orders', byPrefix)
    .catch(() =>
      db.listDocuments(DB_ID, 'orders', [
        Query.equal('venue_id', venueId),
        Query.orderAsc('$createdAt'),
        Query.limit(100),
      ]),
    )
    .then((r) => (r.documents as unknown as Order[]).filter((o) => isProvisionalOrderNo(o.order_no))));
  if (stuck.length === 0) return 0;

  let fixed = 0;
  // Oldest first, one at a time: each has to see the number the one before it
  // just took, or they all claim the same one.
  for (const order of stuck) {
    // Healed into its own side's sequence. Healing a craft sale into the
    // kitchen's run would give it a number the shop's own receipts do not use.
    const side = order.module ?? 'kitchen';
    const wanted = await nextOrderNo(venueId, settings, side);
    const base = Number(wanted.replace(/\D/g, '')) || 1;
    const prefix = side === 'craft'
      ? (settings.craft_order_prefix ?? 'S') || (settings.order_number_prefix ?? '')
      : settings.order_number_prefix ?? '';
    const padding = Math.max(1, settings.order_number_padding ?? 4);
    for (let i = 0; i < 25; i++) {
      try {
        await db.updateDocument(DB_ID, 'orders', order.$id, {
          order_no: `${prefix}${String(base + i).padStart(padding, '0')}`,
        });
        fixed += 1;
        break;
      } catch (e) {
        // Somebody else took it in the meantime; try the next one along.
        if (!/already exists|unique/i.test(e instanceof Error ? e.message : '')) break;
      }
    }
  }
  return fixed;
}

/**
 * A number that cannot collide, for an order whose real number has to be
 * worked out somewhere the guest cannot see.
 *
 * The leading marker is what tells everything downstream that this is not a
 * real order number yet: order-guard replaces it, the kitchen hides it, and
 * the customer's confirmation screen waits for the settled one.
 */
export const PROVISIONAL_MARK = '~';
export const isProvisionalOrderNo = (no: string | undefined) => !!no && no.startsWith(PROVISIONAL_MARK);
/**
 * What to put on a ticket. A placeholder is not a number anyone should read
 * out, and it is replaced within a second or so, a quiet ellipsis is better
 * than a string of characters somebody might try to shout across a pass.
 */
export const displayOrderNo = (no: string | undefined) =>
  isProvisionalOrderNo(no) ? '…' : (no ?? '');
const provisionalOrderNo = () =>
  `${PROVISIONAL_MARK}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
  /** Free text for an area with no table number: "by the pool bar, red shirt". */
  seatNote?: string;
  group?: { reference?: string; size?: number; contactName?: string };
  /**
   * Placed by a customer rather than by staff.
   *
   * Guests cannot read the order list, so they cannot work out what the next
   * number is. Saying so here is more honest than guessing from whether a read
   * happened to come back empty, which is exactly what used to happen, and it
   * handed every guest order the number 0001 until the unique index refused it.
   */
  guest?: boolean;
  /** Set for a pre-order; the kitchen sees nothing until fire_at. */
  scheduledFor?: Date;
  placedWhileClosed?: boolean;
  quotedWaitMinutes?: number;
  /** Which side of the business is selling. Defaults to the kitchen. */
  module?: 'kitchen' | 'craft';
}

export interface CreatedOrder {
  order: Order;
  items: OrderItem[];
}

/**
 * How long an order should take, from the moment it is placed.
 *
 * The prep times are added up rather than the slowest one taken. A kitchen is
 * not three kitchens: a cook who has a curry and a grill on the same ticket
 * does them one after the other, and quoting the longer of the two is how a
 * customer ends up waiting twice what they were told. Better to say twenty and
 * hand it over in fifteen than the other way round.
 *
 * Extra portions of the same dish are not multiplied; three of one thing goes
 * in one pan, and doubling it produces a number nobody believes.
 */
export async function createOrder(input: CreateOrderInput, attempt = 0): Promise<CreatedOrder> {
  const { venueId, lines, settings, channel, placedBy } = input;
  if (lines.length === 0) throw new Error('An order needs at least one item.');

  const totals = computeTotals({ lines, discount: input.discount ?? 0, settings });
  const isPreorder = !!input.scheduledFor;
  const prepById: Record<string, number> = {};
  // Guests never number their own orders, and neither can anybody with no
  // connection, working out the next number means reading the last one. Both
  // get a placeholder, and the server settles it on arrival. The same mechanism
  // covers both cases, so an order taken during an outage is numbered properly
  // the moment it lands rather than needing anything special.
  const orderNo = input.guest
    ? provisionalOrderNo()
    : await nextOrderNo(venueId, settings, input.module ?? 'kitchen').catch((e) => {
        if (isOffline(e)) return provisionalOrderNo();
        throw e;
      });

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
    seat_note: input.seatNote ?? '',
    is_group: !!input.group,
    group_reference: input.group?.reference ?? '',
    group_size: input.group?.size ?? 0,
    group_contact_name: input.group?.contactName ?? '',
    fulfilment: input.fulfilment ?? 'dine_in',
    pickup_point_id: input.pickupPointId ?? '',
    customer_name: input.customer?.name ?? '',
    customer_phone: input.customer?.phone ?? '',
    customer_email: input.customer?.email ?? '',
    email_source: input.customer?.email ? (channel === 'qr' ? 'guest_at_order' : 'staff_entered') : undefined,
    is_preorder: isPreorder,
    placed_while_closed: input.placedWhileClosed ?? false,
    quoted_wait_minutes: input.quotedWaitMinutes ?? undefined,
    eta_minutes: estimateMinutes(lines),
    // Which side of the business rang this up, so the two sets of books can be
    // read apart afterwards.
    module: input.module ?? 'kitchen',
    // The cooking time on its own, which is what the pass is measured against.
    // order-guard recomputes both a second later from the menu itself; this is
    // so the very first ticket to appear already has the right rule on it.
    prep_minutes: cookMinutes(lines),
  };

  if (input.scheduledFor) {
    payload.scheduled_for = input.scheduledFor.toISOString();
    payload.fire_at = fireTimeFor(lines, input.scheduledFor, prepById).toISOString();
  }

  // Strip undefined so Appwrite does not reject the document.
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

  // The guest is granted read on their own order and its lines. The
  // collection itself is staff-only: an anonymous session is what lets someone
  // who scanned a sticker order at all, so "has a session" cannot be allowed
  // to mean "may read every order in the restaurant".
  const me = await account.get().catch(() => null);
  const mine = me ? [Permission.read(Role.user(me.$id))] : [];

  // The id is decided here, not by the server, which is what lets an order
  // created with no connection still have its items attached to it.
  const orderId = ID.unique();

  let order: Order;
  try {
    order = await createOrQueue<Order>('orders', orderId, payload, mine);
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
      createOrQueue<OrderItem>('order_items', ID.unique(), {
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
        // Snapshotted like the price. An admin raising a dish from ten minutes
        // to twenty-five must not make every ticket already on the pass
        // retrospectively on time.
        prep_minutes: line.prep_minutes ?? 15,
        // Consignment. Blank on every restaurant line, and the terms are
        // written down here because a statement must never be worked out from
        // whatever the rate happens to be the day somebody asks.
        variant_id: line.variant_id ?? '',
        variant_label: line.variant_label ?? '',
        consignor_id: line.consignor_id ?? '',
        commission_bp: line.commission_bp ?? undefined,
        commission_flat: line.commission_flat ?? undefined,
        status: 'queued',
        course: line.course ?? 1,
        seat_no: line.seat_no,
      }, mine),
    ),
  );

  return { order, items: items as unknown as OrderItem[] };
}

/**
 * Ask for an order to be called back.
 *
 * A request, not an instruction. A guest cannot write to their own order, 
 * Appwrite grants permission per document rather than per field, so a phone
 * allowed to change the status would be a phone allowed to change the total.
 * This writes a row the server acts on, and grants the guest read on it so the
 * answer, including a refusal and its reason, comes back to the person who
 * asked.
 */
export async function requestCancellation(order: Pick<Order, '$id' | 'venue_id'>): Promise<string> {
  const me = await account.get().catch(() => null);
  const row = await db.createDocument(
    DB_ID,
    'order_cancellations',
    ID.unique(),
    {
      venue_id: order.venue_id,
      order_id: order.$id,
      requested_at: new Date().toISOString(),
      status: 'requested',
    },
    me ? [Permission.read(Role.user(me.$id))] : [],
  );
  return row.$id;
}

/**
 * Live orders for one side of the business, newest first.
 *
 * The module filter is not cosmetic. This feeds the kitchen display, and a
 * counter sale sits at PENDING between being rung up and being paid, so without
 * it every woven basket flashed onto the pass as a ticket to cook. Worse, a
 * customer who walked away mid-payment left one there permanently,
 * unacknowledged, ringing an alarm at a kitchen with nothing to cook.
 *
 * Defaults to the kitchen because that is what every caller meant before the
 * shop existed, and a default that changes behaviour silently is worse than a
 * default that keeps it.
 */
export async function loadOpenOrders(venueId: string, module: Module = 'kitchen'): Promise<Order[]> {
  const rows = await listAll<Order>('orders', [Query.equal('venue_id', venueId)]);
  const live: OrderStatus[] = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED'];
  return rows
    .filter((o) => live.includes(o.status) && (o.module ?? 'kitchen') === module)
    .sort((a, b) => a.$createdAt.localeCompare(b.$createdAt));
}

export const orderItemsFor = (orderId: string): Promise<OrderItem[]> =>
  listAll<OrderItem>('order_items', [Query.equal('order_id', orderId)]);
