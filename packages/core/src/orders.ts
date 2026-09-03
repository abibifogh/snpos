import { db, DB_ID, ID, Query, Permission, Role, account, listAll, listByIds, anyExists } from './client';
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
import { nextInRun, formatOrderNo, prefixFor } from './order-numbers';
// Pure, and the same rule the shift close reads. A payment that is not live is
// not money in a drawer, wherever the question is asked from.
import { isLivePayment } from './shift-rules';
/*
  A bar's and a kitchen's stock leaves through the recipe, not off the item
  itself, so putting it back needs the same machinery the pour used. Runtime
  import, and safe: stock.ts only takes a TYPE from here, which is erased.
*/
import { correctPourFor } from './stock';
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
  /**
   * The running account this went onto, where it did.
   *
   * Blank on almost every order. Set means the money has NOT arrived and the
   * tab carries it — a tab is credit, not payment, so the order stays unpaid
   * and the shift does not count takings it never took. It is also what lets
   * the close gate tell a deliberate debt from a bill somebody forgot to
   * settle. See tabs.ts.
   */
  tab_id?: string;
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
  // Each side may have its own and falls back to the kitchen's. See prefixFor,
  // where the rule lives and is tested.
  const prefix = prefixFor(settings, module);
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

  /*
    THE LINES GO FIRST, AND THE ORDER LAST.

    Two writes, and one of them can land without the other. Which way round
    that happens decides what a failure looks like on a kitchen screen.

    Order first, lines second — as it was — leaves an order the kitchen can
    see with nothing on it. The commonest way that happens is a phone on a
    weak wifi: the order reaches the server, the connection drops, and the
    LINES go into a queue on the customer's phone, where they stay until that
    tab is opened again. It never is. The customer has walked away, and the
    pass is left holding a ticket with a price on it, no dishes, and nobody to
    ask — which is exactly what was on the screen: seven of them, all placed
    from phones by the pool.

    Lines first turns the same failure into orphaned rows: an order_id nothing
    points at, invisible to every screen, harmless. Nothing in the system reads
    a line except through its order, so an order that never arrives takes its
    lines out of sight with it.

    The ids make it possible. `orderId` is decided here rather than by the
    server, so the lines can name the order they belong to before it exists.
    A retry after a number collision writes its lines again under a new id and
    leaves the first set orphaned, which is the same harmless nothing.
  */
  const items = await Promise.all(
    lines.map((line) =>
      createOrQueue<OrderItem>('order_items', ID.unique(), {
        venue_id: venueId,
        // The id decided above, not `order.$id` — the order does not exist
        // yet, and that is the whole point. See the note by `orderId`.
        order_id: orderId,
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
/** The states in which an order is still somebody's business tonight. */
export const LIVE_STATUSES: OrderStatus[] = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED'];

/**
 * How far back "still live" reaches.
 *
 * Thirty days is not a claim about how long a bill may stay unpaid. It is the
 * point past which an order still sitting in a live state is a piece of
 * history somebody forgot rather than a night still in progress, and it
 * belongs to the admin's Orders page, which can see everything, rather than to
 * a kitchen screen that has to redraw every twenty seconds.
 */
export const LIVE_WINDOW_MS = 30 * 86_400_000;

/**
 * Every order that could still matter to a till or a pass, and only those.
 *
 * THE READ THAT WAS QUIETLY GROWING. Five places asked for every order the
 * venue had ever taken and filtered the answer in memory — the kitchen screen
 * did it every twenty seconds. At a few hundred orders that is invisible; at
 * a few thousand it is a pause on every refresh, and it never stops growing,
 * because nothing ever stopped being "every order".
 *
 * So the database is asked the real question: live states only, this venue,
 * and no older than the window. All three are indexed, and the answer is a
 * night's worth of rows however long the business has been trading.
 */
export async function liveOrders(venueId: string, since = Date.now() - LIVE_WINDOW_MS): Promise<Order[]> {
  return listAll<Order>('orders', [
    Query.equal('venue_id', venueId),
    Query.equal('status', LIVE_STATUSES),
    Query.greaterThanEqual('$createdAt', new Date(since).toISOString()),
  ]);
}

export async function loadOpenOrders(venueId: string, module: Module = 'kitchen'): Promise<Order[]> {
  const rows = await liveOrders(venueId);
  return rows
    .filter((o) => (o.module ?? 'kitchen') === module)
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

/* --------------------------------------- correcting what was actually sold */

/**
 * Which of these lines a maker has already been paid for.
 *
 * Asked before a correction is offered, not after it is attempted. A credit is
 * money that has already been told to somebody, and the honest thing is to say
 * up front that this bill is not the place to change it.
 */
export async function creditedLineIds(lineIds: string[]): Promise<string[]> {
  if (lineIds.length === 0) return [];
  const rows = await listAll<{ order_item_id?: string }>('consignor_ledger', [
    Query.equal('order_item_id', lineIds),
  ]).catch(() => []);
  return rows.map((r) => r.order_item_id ?? '').filter(Boolean);
}

/**
 * Put a quantity right, and everything that hangs off it.
 *
 * The order of these matters, and every step is deliberate:
 *
 *   1. THE LINES, because they are the record of what happened and everything
 *      else is derived from them.
 *   2. THE SHELF, but only where a piece has ALREADY come off it. Stock is
 *      taken at the moment a shop sale is fully paid, so a bill that has not
 *      been settled has moved nothing and needs nothing put back — and writing
 *      a movement against it here would make the real depletion, when it
 *      comes, think it had already run and skip. The correction is written as
 *      its own movement rather than by editing the first one: a count that
 *      changes with no line saying why is a count nobody trusts.
 *   3. THE TOTALS, through the same recompute a stale order already uses, so
 *      a corrected bill and a fresh one can never work a total out differently.
 *   4. THE PAYMENT STATUS, because a bill corrected downwards past what was
 *      taken is now fully paid and must stop appearing as owing.
 *   5. THE AUDIT LOG, last, and carrying every line that moved. An order whose
 *      quantities were changed by hand is exactly the one somebody will ask
 *      about in a fortnight.
 */
export async function applyQuantityCorrection(input: {
  order: Pick<Order, '$id' | 'venue_id' | 'order_no' | 'subtotal' | 'total' | 'discount_total' | 'shift_id'>;
  lines: OrderItem[];
  /** New quantity per line id. A line not named here is left alone. */
  quantities: Record<string, number>;
  settings: Settings;
  actor: { id: string; role: string };
  reason: string;
  /** What has been taken against this bill, so the status can follow. */
  taken: number;
  /** Which side of the business, so a put-back goes to the right counter. */
  module?: Module;
}): Promise<{ from: number; to: number } | null> {
  const moved = input.lines.filter(
    (l) => l.status !== 'void' && input.quantities[l.$id] !== undefined && input.quantities[l.$id] !== l.qty,
  );
  if (moved.length === 0) return null;

  const before = moved.map((l) => ({ id: l.$id, name: l.name_snapshot, qty: l.qty }));

  for (const line of moved) {
    const qty = input.quantities[line.$id];
    /*
      What it WAS, read before anything is written.

      Everything downstream is worked out from the difference, and the row
      being written to is the row this was read from. Taking the old quantity
      off the line after the update reads the new one, the difference comes out
      as nought, and the shelf is never put back — silently, on exactly the
      correction that needed it most.
    */
    const was = line.qty;
    // The price this line was actually sold at, add-ons and all, rather than
    // today's menu price. A correction is not a re-pricing.
    const unit = was > 0 ? Math.round(line.line_total / was) : lineUnitPrice({
      key: line.$id,
      menu_item_id: line.menu_item_id,
      name: line.name_snapshot,
      unit_price: line.unit_price,
      qty: 1,
      addons: [],
    });
    await db.updateDocument(DB_ID, 'order_items', line.$id, { qty, line_total: unit * qty });
    // The shop's shelf, where a piece leaves as itself.
    await correctShelfFor({ ...line, qty: was }, qty - was, input.order, input.actor.id);
    /*
      And the bar's and the kitchen's, where what leaves is whatever the
      recipe names. This was missing entirely: taking a drink off a bill put
      the money back and left the bottle gone, so the next count read one
      short with no sale left on the bill to explain it. See correctPourFor.
    */
    await correctPourFor({
      venueId: input.order.venue_id,
      shiftId: input.order.shift_id,
      module: input.module,
      line,
      delta: qty - was,
      userId: input.actor.id,
      reason: input.reason,
    }).catch(() => 0);
  }

  const totals = await recomputeOrderTotals(input.order, input.settings);

  if (input.taken > 0) {
    const to = totals?.to ?? input.order.total;
    await db
      .updateDocument(DB_ID, 'orders', input.order.$id, {
        payment_status: input.taken >= to ? 'paid' : 'partial',
      })
      .catch(() => undefined);
  }

  await db
    .createDocument(DB_ID, 'audit_log', ID.unique(), {
      venue_id: input.order.venue_id,
      actor_id: input.actor.id,
      actor_role: input.actor.role,
      action: 'order_quantity_corrected',
      entity_type: 'orders',
      entity_id: input.order.$id,
      before: JSON.stringify({ lines: before, total: input.order.total }),
      after: JSON.stringify({
        lines: moved.map((l) => ({ id: l.$id, name: l.name_snapshot, qty: input.quantities[l.$id] })),
        total: totals?.to ?? input.order.total,
      }),
      reason: input.reason,
    })
    .catch(() => undefined);

  return totals;
}

/**
 * Put back — or take — the difference, where this piece already left the shelf.
 *
 * Silent when nothing has moved yet, which is the ordinary case: the shelf is
 * only touched when a shop sale is fully paid, and a restaurant's dishes never
 * touch it at all.
 */
async function correctShelfFor(
  line: OrderItem,
  delta: number,
  order: Pick<Order, 'venue_id' | 'shift_id'>,
  actorId: string,
): Promise<void> {
  if (delta === 0) return;

  // A yes-or-no question, asked as one. Reading every movement for the line to
  // look at its length is how a screen ends up loading a year of history.
  const sold = await anyExists('product_moves', [
    Query.equal('ref_type', 'order_item'),
    Query.equal('ref_id', line.$id),
    Query.equal('type', 'sale'),
  ]).catch(() => ({ any: false, total: 0 }));
  // Nothing has come off yet, so there is nothing to put back. Writing a
  // movement here would also make the real depletion think it had already run.
  if (!sold.any) return;

  await db
    .createDocument(DB_ID, 'product_moves', ID.unique(), {
      venue_id: order.venue_id,
      menu_item_id: line.menu_item_id,
      variant_id: line.variant_id || '',
      consignor_id: line.consignor_id || '',
      type: 'adjustment',
      // The sale took the old quantity off. Only the new one should be off, so
      // this is the difference, in the opposite direction.
      qty_delta: -delta,
      unit_price: line.unit_price || 0,
      ref_type: 'order_item',
      ref_id: line.$id,
      shift_id: order.shift_id || '',
      note: `Quantity corrected on the bill: ${line.qty} to ${line.qty + delta}`,
      created_by: actorId,
    })
    .catch(() => undefined);

  const collection = line.variant_id ? 'product_variants' : 'menu_items';
  const id = line.variant_id || line.menu_item_id;
  const current = await db.getDocument(DB_ID, collection, id).catch(() => null);
  if (!current) return;
  await db
    .updateDocument(DB_ID, collection, id, {
      on_hand: ((current as unknown as { on_hand?: number }).on_hand || 0) - delta,
    })
    .catch(() => undefined);
}

/* ------------------------------------------------ where one thing went */

/** Everything needed to draw an item's sales history over a period. */
export interface ItemSales {
  lines: OrderItem[];
  orders: Order[];
  /**
   * Set where this is an INGREDIENT rather than something on the menu: the
   * drinks that consumed it, so the screen can say what it went into.
   */
  throughItems?: string[];
}

/**
 * What was sold of one menu item between two moments.
 *
 * The lines are found by the item, and the bills are then fetched by the ids
 * those lines carry — rather than reading every order in the window and
 * throwing away the ones that do not mention it, which is a month of trading
 * pulled down to answer a question about one dish.
 *
 * The window is applied to the BILLS, not to the lines. A line carries its own
 * created time and it is within a second of its order's, but "sold on the 28th"
 * means the order was rung up on the 28th, and a line written either side of
 * midnight must not land on a different day from the bill it is on.
 */
export async function loadItemSales(
  menuItemId: string,
  fromIso: string,
  toIso: string,
): Promise<ItemSales> {
  const lines = await listAll<OrderItem>('order_items', [Query.equal('menu_item_id', menuItemId)]);
  if (lines.length === 0) return { lines: [], orders: [] };

  const orders = await listByIds<Order>('orders', '$id', lines.map((l) => l.order_id));
  const inWindow = orders.filter((o) => o.$createdAt >= fromIso && o.$createdAt <= toIso);
  const keep = new Set(inWindow.map((o) => o.$id));
  return { lines: lines.filter((l) => keep.has(l.order_id)), orders: inWindow };
}

/**
 * What was sold of one INGREDIENT between two moments.
 *
 * An ingredient is never rung up. A bottle of tonic leaves the shelf because
 * somebody sold a gin and tonic, so its history is the history of the drinks
 * that consume it — which is also the only honest way to answer "where did it
 * go", since the answer is a list of other things.
 *
 * Read from the recipes rather than from the stock movements on purpose. A
 * movement only exists where the pour actually ran, so a drink with no recipe,
 * or one not set to the bar, would show a history of nothing at all — and
 * "nothing sold" is precisely the wrong answer to give about a bottle that has
 * been emptying all month. See pour-check, which names that fault rather than
 * hiding it here.
 */
export async function loadIngredientSales(
  ingredientId: string,
  fromIso: string,
  toIso: string,
): Promise<ItemSales> {
  const recipes = await listAll<{ menu_item_id?: string; ingredient_id: string }>('recipes', [
    Query.equal('ingredient_id', ingredientId),
  ]).catch(() => []);
  const itemIds = [...new Set(recipes.map((r) => r.menu_item_id).filter(Boolean))] as string[];
  if (itemIds.length === 0) return { lines: [], orders: [], throughItems: [] };

  const lines = await listByIds<OrderItem>('order_items', 'menu_item_id', itemIds);
  if (lines.length === 0) return { lines: [], orders: [], throughItems: itemIds };

  const orders = await listByIds<Order>('orders', '$id', lines.map((l) => l.order_id));
  const inWindow = orders.filter((o) => o.$createdAt >= fromIso && o.$createdAt <= toIso);
  const keep = new Set(inWindow.map((o) => o.$id));
  return {
    lines: lines.filter((l) => keep.has(l.order_id)),
    orders: inWindow,
    throughItems: itemIds,
  };
}
