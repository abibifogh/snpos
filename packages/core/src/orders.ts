import { db, DB_ID, ID, Query, Permission, Role, account, listAll } from './client';
import { createOrQueue, isOffline } from './offline';
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
  // Which variant sold, whose it was and what was agreed — snapshotted here
  // because a statement worked out from today's rate would restate what
  // somebody was paid last year.
  variant_id?: string;
  variant_label?: string;
  consignor_id?: string;
  commission_bp?: number;
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
 * restaurant's to decide — these numbers get shouted across a pass, and a
 * kitchen that counts to four digits forever is being made to work around the
 * software rather than the other way round.
 *
 * Still derived from the last order rather than from a counter document.
 * Read-then-write is not safe against two terminals ordering in the same
 * instant, but the unique index on (venue_id, order_no) catches the collision
 * and createOrder retries — cheaper and simpler than a counter every order
 * must serialise through.
 *
 * Only staff can do this. Reading the last order means reading orders, and a
 * guest deliberately cannot — see the note on the collection. Guests get
 * `provisionalOrderNo` instead and order-guard settles the real number the
 * moment the order lands.
 */
async function nextOrderNo(venueId: string, settings: Settings): Promise<string> {
  const prefix = settings.order_number_prefix ?? '';
  const padding = Math.max(1, settings.order_number_padding ?? 4);
  const daily = settings.order_number_mode === 'daily';

  // A window rather than the single newest row. Guest orders sit on a
  // placeholder for a second or so before the server settles them, and the
  // newest order is quite often one of those — reading it as "the last number"
  // would send the count back to the beginning.
  const queries = [Query.equal('venue_id', venueId), Query.orderDesc('$createdAt'), Query.limit(50)];
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
  const numbered = (latest.documents as unknown as Order[]).filter((o) => !isProvisionalOrderNo(o.order_no));
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
 * them. Safe to call often — it does nothing when there is nothing to fix.
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
  // filtering here — slower, but it still heals them.
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
    const wanted = await nextOrderNo(venueId, settings);
    const base = Number(wanted.replace(/\D/g, '')) || 1;
    const prefix = settings.order_number_prefix ?? '';
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
 * out, and it is replaced within a second or so — a quiet ellipsis is better
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
   * happened to come back empty — which is exactly what used to happen, and it
   * handed every guest order the number 0001 until the unique index refused it.
   */
  guest?: boolean;
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
 * How long an order should take, from the moment it is placed.
 *
 * The prep times are added up rather than the slowest one taken. A kitchen is
 * not three kitchens: a cook who has a curry and a grill on the same ticket
 * does them one after the other, and quoting the longer of the two is how a
 * customer ends up waiting twice what they were told. Better to say twenty and
 * hand it over in fifteen than the other way round.
 *
 * Extra portions of the same dish are not multiplied — three of one thing goes
 * in one pan, and doubling it produces a number nobody believes.
 */
/**
 * The longest wait this system will ever quote, whatever the arithmetic says.
 *
 * Not because the food will always arrive by then — on a bad night it will not
 * — but because a number past this stops being useful. "One hour" is a decision
 * point: somebody reads it and either waits or leaves. "An hour and fifty" is a
 * number nobody believes and nobody plans around, and quoting it does more
 * damage than the honest cap plus a cook who keeps people posted.
 */
export const MAX_ETA_MINUTES = 60;

/**
 * The wait to show, never more than the cap.
 *
 * Applied on the way out as well as on the way in. Capping only where the
 * figure is worked out leaves every row written before the cap existed — and
 * anything a future change forgets to clamp — free to put "about 95 minutes"
 * in front of a customer. Reading is the last chance to be sure, and it costs
 * nothing to take it.
 *
 * Returns null when there is no estimate at all, so a caller can leave the
 * whole line out rather than print a made-up number.
 */
export function shownEta(minutes?: number | null): number | null {
  if (!minutes || minutes <= 0) return null;
  return Math.min(MAX_ETA_MINUTES, Math.round(minutes));
}

export function estimateMinutes(lines: CartLine[], queueAhead = 0): number {
  return Math.min(MAX_ETA_MINUTES, Math.max(1, Math.round(cookMinutes(lines) + queueAhead)));
}

/**
 * The cooking time alone: the prep time set on each dish, added up.
 *
 * This is what the kitchen is judged by, and it is deliberately not what the
 * customer is quoted. Their wait includes queueing behind other tickets, which
 * is time before a cook touches this one — measuring a kitchen by it would hand
 * them extra minutes on exactly the nights being late matters most, and only
 * because other people were also waiting.
 *
 * Added rather than taking the longest, for the same reason as everywhere else
 * here: a cook with a curry and a grill on one ticket does them one after the
 * other. Not multiplied by quantity — three of one thing goes in one pan.
 */
export function cookMinutes(lines: Pick<CartLine, 'prep_minutes'>[]): number {
  return Math.max(1, Math.round(lines.reduce((sum, l) => sum + (l.prep_minutes ?? 15), 0)));
}

/**
 * How long a ticket already on the pass should have taken, in minutes.
 *
 * One definition, read by the screen that shows the Late pill and by whatever
 * decides to make a noise. Two copies of this rule is two answers to "is this
 * late", and the one that goes wrong is always the one nobody is looking at.
 *
 * `prep_minutes` on the order is the answer whenever it is there. The fallbacks
 * are for orders placed before it was stored: each line's due time was stamped
 * as "now plus its prep", so the difference gives that prep back. Twenty
 * minutes if even that is missing — a guess that pings beats a blank that never
 * does.
 */
export function dueMinutes(
  order: Pick<Order, 'prep_minutes' | '$createdAt'>,
  lines: { due_at?: string; prep_minutes?: number }[] = [],
): number {
  if (order.prep_minutes) return order.prep_minutes;

  const fromLines = lines.reduce((sum, l) => sum + (l.prep_minutes ?? 0), 0);
  if (fromLines > 0) return fromLines;

  const placed = Date.parse(order.$createdAt);
  const summed = lines.reduce((sum, l) => {
    const due = l.due_at ? Date.parse(l.due_at) : 0;
    return sum + (due > placed ? Math.round((due - placed) / 60_000) : 0);
  }, 0);
  return summed || 20;
}

/**
 * How long the tickets already on the pass will take before this one is
 * started.
 *
 * The kitchen is treated as working through one ticket at a time — the same
 * assumption that makes the dishes within an order add up rather than overlap,
 * and for the same reason. Two cooks who genuinely work in parallel will beat
 * this estimate, and a customer told twenty-five who eats in eighteen is a
 * customer who comes back.
 *
 * What remains of each ticket, not what it started as: an order accepted twelve
 * minutes ago with a fifteen-minute estimate is three minutes from the pass, and
 * counting the full fifteen would push every quote up all evening as the night's
 * finished work piled into the arithmetic.
 *
 * Orders sitting READY are excluded — the cooking is done and they are waiting
 * on a person, not on a stove.
 */
export function queueMinutes(
  pending: Pick<Order, 'status' | 'prep_minutes' | 'eta_minutes' | 'accepted_at' | '$createdAt'>[],
  now: number = Date.now(),
): number {
  const cooking: OrderStatus[] = ['PENDING', 'ACCEPTED', 'PREPARING'];
  let ahead = 0;
  for (const o of pending) {
    if (!cooking.includes(o.status)) continue;

    /**
     * Cooking time, not the wait its own customer was quoted.
     *
     * Those are different numbers now, and using the wrong one compounds. An
     * order's quoted wait already contains the queue that was ahead of IT, so
     * adding up quoted waits counts the same stove time again for every order
     * that has joined since — a fourth ticket on a quiet-ish evening would
     * inherit the first three's queueing on top of their cooking and sail
     * straight into the hour cap. What is left to cook is what is left to cook.
     */
    const work = o.prep_minutes ?? o.eta_minutes ?? 15;

    // A ticket nobody has accepted is not being cooked, so none of it is done
    // however long it has been sitting there. Only time since a cook took it
    // comes off.
    const started = o.accepted_at ? Date.parse(o.accepted_at) : NaN;
    const elapsed = Number.isFinite(started) ? Math.max(0, (now - started) / 60_000) : 0;
    ahead += Math.max(0, work - elapsed);
  }
  return Math.round(ahead);
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
  // Guests never number their own orders, and neither can anybody with no
  // connection — working out the next number means reading the last one. Both
  // get a placeholder, and the server settles it on arrival. The same mechanism
  // covers both cases, so an order taken during an outage is numbered properly
  // the moment it lands rather than needing anything special.
  const orderNo = input.guest
    ? provisionalOrderNo()
    : await nextOrderNo(venueId, settings).catch((e) => {
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
        status: 'queued',
        course: line.course ?? 1,
        seat_no: line.seat_no,
      }, mine),
    ),
  );

  return { order, items: items as unknown as OrderItem[] };
}

/**
 * How long after sending an order a customer may still call it back.
 *
 * Deliberately short. Long enough for "that was the wrong thing, I pressed send
 * too fast", which is the whole of what this is for, and short enough that a
 * kitchen is not throwing away food somebody has already started.
 *
 * The browser uses this to decide what to show; the server checks it again for
 * real, because the clock on a phone is whatever its owner sets it to.
 */
export const CANCEL_WINDOW_MS = 2 * 60 * 1000;

/** Milliseconds left on the cancel window, or 0 once it has closed. */
export function cancelWindowLeft(order: Pick<Order, '$createdAt'>, now: number = Date.now()): number {
  const placed = Date.parse(order.$createdAt);
  if (!Number.isFinite(placed)) return 0;
  return Math.max(0, CANCEL_WINDOW_MS - (now - placed));
}

/**
 * Ask for an order to be called back.
 *
 * A request, not an instruction. A guest cannot write to their own order —
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
