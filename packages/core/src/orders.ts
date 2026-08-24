import { db, DB_ID, ID, Query, Permission, Role, account, listAll } from './client';
import { cookMinutes, estimateMinutes, fireTimeFor, queueMinutes, waitIncludingOpening } from './orders-time';
import { parseWindows, minutesUntilOpen } from './availability';
import { lockedProblem } from './shift-lock';
import type { LockableShift } from './shift-lock';

/**
 * The timing arithmetic lives next door, in a file that imports nothing.
 *
 * Re-exported so every caller keeps working. The split exists so the figure a
 * customer is quoted and the figure a kitchen is judged by can be tested
 * without selling anything, not to make callers choose a file.
 */
export {
  MAX_ETA_MINUTES, shownEta, cookMinutes, estimateMinutes, queueMinutes, dueMinutes, fireTimeFor,
  CANCEL_WINDOW_MS, cancelWindowLeft, LINES_GRACE_MS, ticketLines, linesComplete, isOverdue, minutesOver,
  addonNames, addonsUnreadable, waitIncludingOpening, customerWait, quotedWait, formatWait,
} from './orders-time';
import { createOrQueue, isOffline } from './offline';
import { computeTotals, lineUnitPrice, lineTotal } from './pricing';
// Pure, and the reason a bar can ring up a sale at all. See order-numbers.
import { nextInRun, formatOrderNo } from './order-numbers';
// Pure, and the same rule the shift close reads. A payment that is not live is
// not money in a drawer, wherever the question is asked from.
import { isLivePayment } from './shift-rules';
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
  /** How much of eta_minutes was the building being shut. */
  opening_wait_minutes?: number;
  quoted_wait_minutes?: number;
  /** What the customer was told: cooking time plus the queue ahead of them. */
  eta_minutes?: number;
  /** What the kitchen is judged by: the cooking time alone. */
  prep_minutes?: number;
  /** Which side of the business sold this. Absent means kitchen. */
  module?: Module;
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
async function nextOrderNo(
  venueId: string,
  settings: Settings,
  module: Module = 'kitchen',
  /** Numbers a collision has already proved are taken. See nextInRun. */
  skip = 0,
): Promise<string> {
  /**
   * Each PREFIX counts on its own — not each side.
   *
   * A shared run of numbers meant a shop receipt and a restaurant receipt could
   * look alike and sort together, while the two sides keep separate books
   * everywhere else. The craft prefix falls back to the kitchen's when it is
   * blank, which is what a business running only one side wants.
   *
   * And the counter follows the prefix from there, because that is exactly how
   * far uniqueness reaches. Counting per SIDE while sharing a prefix is what
   * stopped the bar taking money: no prefix of its own, so it shared the
   * kitchen's, and counted only its own orders — the kitchen at ORD0222, the
   * bar asking for ORD0006 on its sixth drink, and a database that refuses the
   * same number twice. See order-numbers.
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
  /*
    Everything carrying this prefix, whichever side rang it up.

    Filtered by the PREFIX rather than the module, and the highest taken
    rather than the newest row: a run only goes up, and the newest row assumes
    the clock and the counter agree about order — which they do not when two
    tills sell in the same second. See nextInRun.
  */
  const run = (latest.documents as unknown as Order[]).map((o) => o.order_no);
  const from = nextInRun(run, prefix, settings.order_number_next ?? 1, skip);
  return formatOrderNo(prefix, from, padding);
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
  /**
   * The venue's trading hours, so a wait can start when the doors do.
   *
   * Passed in rather than looked up, because the screen taking the order has
   * already read them to decide whether to show "we are closed" at all, and
   * two readings of the same rule is two chances for the quote and the notice
   * to disagree in front of the same customer.
   */
  openingHours?: string;
  quotedWaitMinutes?: number;
  /** Which side of the business is selling. Defaults to the kitchen. */
  module?: Module;
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
    : await nextOrderNo(venueId, settings, input.module ?? 'kitchen', attempt).catch((e) => {
        if (isOffline(e)) return provisionalOrderNo();
        throw e;
      });

  /*
    Read once, used twice. The queue and the door wait both feed the quote,
    and asking for either of them twice inside one object literal is how the
    two halves of a single figure end up measured a second apart.
  */
  const queueAhead = await queueAheadFor(venueId, input.module ?? 'kitchen');
  const doorWait = minutesUntilOpen(parseWindows(input.openingHours));

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
    /**
     * The wait, including the queue this order is joining.
     *
     * This was the cooking time alone, so an order arriving behind four others
     * was quoted the minutes its own food takes and nothing else. On a quiet
     * pass those are the same number and it looked correct; on a busy one it
     * was wrong by however long the kitchen was already behind, which is
     * exactly when a customer is deciding whether to wait.
     */
    /*
      Ordering at noon from a kitchen that opens at one is an eighty minute
      wait, not a twenty minute one, and quoting the cooking time alone makes
      a promise that breaks itself an hour before anybody starts cooking. See
      waitIncludingOpening for why the closed stretch is added whole while the
      kitchen's own part stays capped.

      A scheduled pre-order is left alone: somebody collecting at seven asked
      for seven, and is not waiting for anything.
    */
    eta_minutes: input.scheduledFor
      ? estimateMinutes(lines, queueAhead)
      : doorWait > 0
        ? waitIncludingOpening(cookMinutes(lines) + queueAhead, doorWait)
        : estimateMinutes(lines, queueAhead),
    // Which part of that was the building being shut. See the schema note:
    // the kitchen counts down to the whole figure, the customer is shown the
    // door wait plus a capped kitchen share, and the split has to be recorded
    // rather than re-derived, because the doors get closer while it sits there.
    opening_wait_minutes: doorWait,
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
      /*
        The attempt number is carried into the number itself.

        It was not, and that is what turned one collision into five identical
        failures: each retry worked the next number out from the same rows,
        got the same answer, and was refused for the same reason. The message
        that reached the bar was about a unique attribute constraint.
      */
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
        // Only present when the price was changed at the till. Absent means
        // the line sold at the menu price, which is what the guard assumes.
        ...(line.list_price !== undefined
          ? { list_price: line.list_price, price_changed_by: line.price_changed_by ?? '' }
          : {}),
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

/**
 * How long the tickets already on the pass will take before this one starts.
 *
 * The rule itself is `queueMinutes`; this is the reading that feeds it. An
 * order joining a busy kitchen waits for everything in front of it, so its
 * estimate has to be the work still left on those plus its own cooking — a
 * customer told twenty minutes while four orders sit ahead of them is being
 * told the time it takes to cook their food, not the time until they eat.
 *
 * Only this side of the business: a craft shop sale is rung up at a counter
 * and never sees a stove, so counting one would add a wait that no cook is
 * working through.
 *
 * Returns nought if the orders cannot be read, which is the case for a guest —
 * the collection is staff-only, and their phone is not allowed to see what
 * everybody else has ordered. order-guard works it out again server-side a
 * moment later and corrects the order, so the guest's figure is briefly short
 * rather than wrong for ever.
 */
export async function queueAheadFor(venueId: string, module: Module = 'kitchen'): Promise<number> {
  const live = await listAll<Order>('orders', [
    Query.equal('venue_id', venueId),
    Query.equal('status', ['PENDING', 'ACCEPTED', 'PREPARING']),
  ]).catch(() => [] as Order[]);
  return queueMinutes(live.filter((o) => (o.module ?? 'kitchen') === module));
}

/**
 * Work an order's totals out again from the lines it actually has.
 *
 * For orders whose stored total is already wrong. The server reprices an order
 * a second after it lands, and it used to start as soon as it saw the FIRST of
 * its lines — so an order read a moment too early was priced from one dish of
 * three, and that figure was written onto the order and stayed. The ticket
 * showed a number that did not add up to what was ordered, and reloading
 * changed nothing, because the stored figure itself was wrong.
 *
 * That is fixed at the source, but a wrong number already written stays wrong
 * until somebody works it out again. This is that.
 *
 * The lines are taken as they stand — they were priced from the menu when the
 * order was placed, and re-pricing them from today's menu would rewrite what a
 * customer was charged weeks ago. Voided lines are left out, and the discount
 * the order already carries is kept.
 *
 * Returns what changed, or null when the figures were right all along, so a
 * caller can say "nothing to fix" rather than claiming to have fixed it.
 */
export async function recomputeOrderTotals(
  order: Pick<Order, '$id' | 'subtotal' | 'total' | 'discount_total'>,
  settings: Settings,
): Promise<{ from: number; to: number } | null> {
  const lines = await orderItemsFor(order.$id);
  if (lines.length === 0) return null;

  // Each stored line total, taken whole. `lineTotal` multiplies unit by
  // quantity, so a line is presented as one unit of itself.
  const totals = computeTotals({
    lines: lines
      .filter((l) => l.status !== 'void')
      .map((l) => ({
        key: l.$id,
        menu_item_id: l.menu_item_id,
        name: l.name_snapshot,
        unit_price: l.line_total,
        qty: 1,
        addons: [],
      })),
    discount: order.discount_total ?? 0,
    settings,
  });

  if (totals.subtotal === order.subtotal && totals.total === order.total) return null;

  await db.updateDocument(DB_ID, 'orders', order.$id, {
    subtotal: totals.subtotal,
    discount_total: totals.discount_total,
    service_total: totals.service_total,
    tax_total: totals.tax_total,
    total: totals.total,
  });
  return { from: order.total, to: totals.total };
}

/* ------------------------------------------------ putting an order right */

/**
 * Call an order off, whatever state it reached.
 *
 * The kitchen can reject one before cooking and a customer can call one back
 * within two minutes; neither helps with an order that ran all the way to the
 * end and should not have — a duplicate, a walkout, a bill rung up against the
 * wrong table. That has to be an admin's to undo, and it has to reach the
 * shift, or the figures keep counting a sale that did not happen.
 *
 * Cancelling keeps the record. What was ordered, what was charged and who took
 * it are all still readable; the order simply no longer counts, and it drops
 * out of the shift's list because it sold nothing. Use `removeOrder` when the
 * record itself should not exist.
 */
export async function cancelOrder(
  order: Pick<Order, '$id' | 'venue_id' | 'shift_id'>,
  opts: { reason: string; userId: string },
): Promise<{ givenBack: number; payments: number }> {
  await db.updateDocument(DB_ID, 'orders', order.$id, {
    status: 'CANCELLED',
    /*
      'other', not 'admin_cancelled'.

      `reject_reason_code` is a fixed list and has never had that value in it,
      so every attempt to cancel an order was refused outright by the database
      with a message about an invalid format. The button had never worked.

      Widening the list is the wrong fix twice over: it would need the database
      provisioned again before cancelling started working, and the code is not
      where an admin cancellation is distinguished anyway. The STATUS already
      says which this was — CANCELLED is an admin taking a finished order back,
      REJECTED is the kitchen turning one away before cooking it — and the
      reason somebody typed is on the row beneath.
    */
    reject_reason_code: 'other',
    reject_reason_note: opts.reason.slice(0, 500),
    alert_level: 0,
  });

  // The money goes back with it. See giveTheMoneyBack — without this the
  // drawer was still expected to hold cash that had been handed to a customer.
  const back = await giveTheMoneyBack(order, opts);

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: order.venue_id,
    actor_id: opts.userId,
    action: 'order_cancelled',
    entity_type: 'order',
    entity_id: order.$id,
    after: JSON.stringify({
      reason: opts.reason,
      shift_id: order.shift_id ?? '',
      given_back: back.givenBack,
    }),
  }).catch(() => undefined);

  return back;
}

/**
 * Take back the money recorded against an order that is not going to happen.
 *
 * An order can be called off after it has been paid for — a duplicate rung up
 * twice, a bill against the wrong table, a customer who walked out and was
 * given their money back at the door. Cancelling it used to change the order
 * and nothing else, which left the payment rows exactly as they were.
 *
 * The consequence lands on somebody else, hours later. The shift counts a
 * payment as money it took, and expects to find it in the drawer at closing
 * time. So the cashier who handed GH₵200 back to a customer is told at
 * midnight that the drawer is GH₵200 short, and there is nothing on the screen
 * connecting the two — the order is marked cancelled, which reads like the
 * money went with it. Every one of those is a person asked to account for a
 * shortage that the system created.
 *
 * Marked refunded rather than deleted, the same way a payment voided by hand
 * is: the row is the record that money came in and then went back out again,
 * and erasing it would make a night's takings change with nothing to show why.
 * `isLivePayment` already treats a refunded row as no longer in the drawer, so
 * the expected figure, the takings and the accounts all move together.
 *
 * Nothing here is allowed to fail the cancellation itself. An order that will
 * not cancel because one payment row would not update is worse than a
 * cancellation with a payment left to tidy up by hand — and the audit entry
 * records what actually went back, not what was intended.
 */
export async function giveTheMoneyBack(
  order: Pick<Order, '$id' | 'venue_id'>,
  opts: { reason: string; userId: string },
): Promise<{ givenBack: number; payments: number }> {
  const rows = await listAll<{
    $id: string; amount: number; tip?: number; status?: string;
  }>('payments', [Query.equal('order_id', order.$id)]).catch(() => []);

  const live = rows.filter(isLivePayment);
  let givenBack = 0;
  let payments = 0;
  for (const p of live) {
    const done = await db
      .updateDocument(DB_ID, 'payments', p.$id, {
        status: 'refunded',
        refund_reason: `Order cancelled: ${opts.reason}`.slice(0, 300),
      })
      .then(() => true)
      .catch(() => false);
    if (!done) continue;
    givenBack += p.amount + (p.tip ?? 0);
    payments += 1;
  }

  // Refunded, not unpaid. Both are true in the sense that nothing is held any
  // more, but only one of them says what happened, and "unpaid" against an
  // order somebody definitely paid for is how a customer gets chased for money
  // they already handed over and got back.
  if (payments > 0) {
    await db.updateDocument(DB_ID, 'orders', order.$id, { payment_status: 'refunded' }).catch(() => undefined);
  }

  return { givenBack, payments };
}

/**
 * Erase an order and everything that hangs off it.
 *
 * A delete, not an archive, and it takes the payments with it — which is the
 * point. "Remove it from the shift" and "leave the money on the shift" cannot
 * both be true: a payment left behind is a payment the takings still count,
 * against an order nobody can open. So they go together or not at all.
 *
 * The order goes FIRST, before anything it owns. Children-first is the tidier
 * order when a run works and exactly the wrong one when the delete is going to
 * be refused: that is what stripped every order bare in the Erase records page
 * and left them all sitting in the list. If the order itself will not go,
 * nothing else has been touched.
 *
 * A closed shift is worked out again afterwards, so its takings, its expected
 * figures and its over-or-short stop counting money that no longer exists.
 * What was physically counted that night is never touched.
 */
export async function removeOrder(
  order: Pick<Order, '$id' | 'venue_id' | 'shift_id'>,
  opts: { userId: string },
): Promise<{ removed: number }> {
  // The one write that decides whether any of this is allowed.
  await db.deleteDocument(DB_ID, 'orders', order.$id);
  let removed = 1;

  for (const [collection, field] of [
    ['order_items', 'order_id'],
    ['order_notices', 'order_id'],
    ['payments', 'order_id'],
  ] as const) {
    const rows = await listAll<Doc>(collection, [Query.equal(field, order.$id)]).catch(() => [] as Doc[]);
    for (const r of rows) {
      await db.deleteDocument(DB_ID, collection, r.$id).catch(() => undefined);
      removed += 1;
    }
  }

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: order.venue_id,
    actor_id: opts.userId,
    action: 'order_deleted',
    entity_type: 'order',
    entity_id: order.$id,
    after: JSON.stringify({ removed, shift_id: order.shift_id ?? '' }),
  }).catch(() => undefined);

  return { removed };
}

/**
 * File an order under a different shift.
 *
 * The money goes with it, and that is the whole design. A sale counted under
 * one night and paid for under another is not a correction, it is a second
 * error: the first shift stays over by the amount and the second stays short
 * by it, and the two now disagree in a way that reads as theft. So the order
 * and its payments move together or the caller is told they did not.
 *
 * Order of writes, and why. The order goes FIRST, because it is the write that
 * decides whether any of this is permitted at all — if it is refused, nothing
 * else has been touched. The payments follow, and any that will not move are
 * counted and reported rather than swallowed: this operation is safe to run
 * again, so an admin who is told "the sale moved, two of three payments did
 * not" can simply repeat it, whereas one who is told nothing has money sitting
 * on a shift with no sale to explain it.
 *
 * `shelved_at` is cleared on the way through. An order that was set aside for
 * the next shift and has now been given one by hand is not still waiting, and
 * leaving the flag on would have the next shift opened adopt it straight back
 * off the shift somebody just chose. See adoptShelved.
 *
 * Both shifts are worked out again afterwards. A closed shift stored what it
 * took and what it expected at the moment it closed and those figures do not
 * move on their own; an open one works itself out from the rows every time it
 * is looked at, so recomputing it is a no-op rather than a special case. What
 * was physically counted is never touched — see recomputeClosedShift.
 */
export async function moveOrderToShift(opts: {
  order: Pick<Order, '$id' | 'venue_id' | 'order_no' | 'shift_id'>;
  toShiftId: string;
  userId: string;
  reason: string;
}): Promise<{ payments: number; stranded: number }> {
  const { order, toShiftId } = opts;
  const from = order.shift_id ?? '';

  /*
    Neither end may be a settled night.

    Checked here rather than only on the screen that offers the move, because
    a rule kept by the page that has the button is a rule with as many ways
    round it as there are pages. Both shifts are read: moving a sale OFF a
    settled night changes its takings just as surely as moving one on.
  */
  for (const [id, side] of [[from, 'the shift it is on'], [toShiftId, 'the shift it is moving to']] as const) {
    if (!id) continue;
    const shift = await db.getDocument(DB_ID, 'shifts', id).catch(() => null);
    const settled = lockedProblem(shift as unknown as LockableShift | null, `${side}`);
    if (settled) throw new Error(settled);
  }

  // Two writes, and the split is deliberate — the same lesson adoptShelved
  // learned. A rejected `null` on the shelved flag would take the shift stamp
  // down with it if they travelled together, leaving an order that had been
  // moved nowhere and a screen saying it had.
  await db.updateDocument(DB_ID, 'orders', order.$id, { shift_id: toShiftId });
  // Given a shift by hand, so it is no longer waiting for one. Tidiness only:
  // without this the next shift opened would adopt it straight back off the
  // shift somebody just chose.
  await db.updateDocument(DB_ID, 'orders', order.$id, { shelved_at: null }).catch(() => undefined);

  const payments = await listAll<Doc & { shift_id?: string }>('payments', [
    Query.equal('order_id', order.$id),
  ]).catch(() => [] as (Doc & { shift_id?: string })[]);

  let moved = 0;
  let stranded = 0;
  for (const p of payments) {
    const ok = await db
      .updateDocument(DB_ID, 'payments', p.$id, { shift_id: toShiftId })
      .then(() => true)
      .catch(() => false);
    if (ok) moved += 1;
    else stranded += 1;
  }

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: order.venue_id,
    actor_id: opts.userId,
    action: 'order_shift_changed',
    entity_type: 'order',
    entity_id: order.$id,
    before: JSON.stringify({ shift_id: from }),
    after: JSON.stringify({ shift_id: toShiftId, payments: moved }),
    // In its own field rather than buried in the JSON. A before/after pair
    // says what changed; only this says whether it was a correction or
    // somebody moving a sale off a night they were answerable for.
    reason: opts.reason.slice(0, 500),
    shift_id: toShiftId,
  }).catch(() => undefined);

  return { payments: moved, stranded };
}
