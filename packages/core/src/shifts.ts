import { db, DB_ID, ID, Query, listAll, saveDropping } from './client';
import type { Doc, Settings } from './types';
import type { Order, OrderItem } from './orders';
import { depleteForShift, loadIngredients, loadRecipes, updateStockAlerts } from './stock';
import { countable } from './bar-count';
import { postShift, reverseEntry, shiftCloseEntries, lockedThroughFor, isLocked } from './ledger';
import { isLivePayment } from './payments';
import { featureConfig, isEnabled, type FeatureMap } from './features';
import { MODULE_LABELS } from './access';
import type { Module } from './access';
import {
  shiftAge, shiftCode, mustWaitForNextShift, openShiftsFor, blockerFor, SHIFT_MAX_HOURS, carryOverFloats,
  lastForSide, resendProblem,
} from './shift-rules';
import { lockedProblem, sealProblem, isSealed } from './shift-lock';
import { belongsToShift, shiftsOnDay, backdatedWindow } from './shift-move';
import type { MovableShift } from './shift-move';
import type { LockableShift } from './shift-lock';

export * from './shift-rules';

export interface Shift extends Doc {
  venue_id: string;
  code: string;
  /** An admin has asked for the closing report to go again. See requestSummaryResend. */
  summary_resend_at?: string | null;
  status: 'open' | 'closing' | 'closed' | 'reopened';
  opened_by: string;
  opened_at: string;
  opening_floats: string;
  float_source: string;
  /** The shift its opening cash was carried out of, where it was carried. */
  carried_from_shift_id?: string;
  closed_at?: string;
  closed_by?: string;
  /** JSON, per method, written at close. */
  counted?: string;
  /** Which side of the business. Absent on shifts opened before the split. */
  module?: Module;
  sales_total: number;
  expense_total: number;
  covers: number;
  variance_note?: string;
}

export interface PaymentMethod extends Doc {
  name: string;
  kind: string;
  enabled: boolean;
  counted_at_close: boolean;
  venue_id: string;
  /** Card machines and mobile money leave a number; without it the payment
      cannot be matched against the provider's statement. */
  requires_reference?: boolean;
}

export interface ShiftPayment extends Doc {
  method_id: string;
  amount: number;
  tip: number;
  /** 'voided' means recorded in error and taken back out. See isLivePayment. */
  status?: string;
}

export const loadPaymentMethods = async (venueId: string): Promise<PaymentMethod[]> =>
  (await listAll<PaymentMethod>('payment_methods', [Query.equal('venue_id', venueId)])).filter((m) => m.enabled);

/**
 * What the shift row records about where its opening figure came from.
 *
 * THREE VALUES, and only these three. The field is a fixed list in the
 * database and always has been, while this function used to answer with the
 * name of the SETTING instead — 'carry_over', 'fixed', 'prompt'. None of those
 * is in the list, and Appwrite refuses a whole write for one bad value, so
 * every attempt to open a shift under any float policy except "start at
 * nothing" was rejected outright with a message about an invalid format.
 *
 * The three settings that could not open a till are exactly the three that
 * put money in the drawer, which is why it looked like a float problem rather
 * than a broken save.
 */
export type FloatSource = 'zero' | 'manual' | 'carried_over';

/**
 * What each drawer should start the shift holding.
 *
 * Starting every shift at zero means somebody physically empties the till
 * every night, and most places do not, the float stays in the drawer and gets
 * counted again in the morning, at which point the system calls it takings.
 * So the restaurant says which it is once, and this works it out.
 *
 * Returns minor units per payment method, ready to fill the form in. Whatever
 * comes back is still editable: the shelf wins over the book here too.
 */
export async function openingFloats(
  venueId: string,
  settings: Settings,
  methods: PaymentMethod[],
  /**
   * Which side is opening. Absent is the kitchen, as everywhere else.
   *
   * Not optional in spirit. Carrying a float over without it took whatever
   * shift closed last, whichever trade it belonged to — see below.
   */
  module: Module = 'kitchen',
): Promise<{
  floats: Record<string, number>;
  /** What goes on the shift row. See FloatSource. */
  source: FloatSource;
  /** What the setting asked for. The screens read this, the database does not. */
  policy: 'zero' | 'carry_over' | 'fixed' | 'prompt';
  /** The shift the cash was carried from, where that is what happened. */
  from?: { id: string; code: string };
  note: string;
}> {
  const policy = settings.shift_float_policy ?? 'zero';

  if (policy === 'carry_over') {
    /*
      THIS SIDE'S LAST SHIFT, not the building's.

      A kitchen, a bar and a craft shop each have their own drawer and each
      close their own shift. Taking simply "the last closed shift" meant a
      kitchen opening in the morning carried over whatever the BAR counted at
      midnight — money that is in a different drawer, in a different room,
      belonging to a different night's takings.

      The effect is not a rounding error. It hands one side an opening balance
      that physically is not there, so the drawer is short by exactly that
      amount at close and somebody is asked where it went. And it does it to
      whichever side happens to open first, so it moves around.

      Filtered in memory rather than in the query. Shifts opened before the
      module column existed carry none at all, and a database filter would step
      straight over every one of them — leaving a business with any history at
      all carrying over nothing and being told there was no previous shift.
    */
    const previous = await db.listDocuments(DB_ID, 'shifts', [
      Query.equal('venue_id', venueId),
      Query.equal('status', 'closed'),
      Query.orderDesc('$createdAt'),
      // A handful, so the newest one belonging to THIS side can be picked out.
      // One was only ever enough when there was one drawer.
      Query.limit(20),
    ]);
    const last = lastForSide(previous.documents as unknown as (Shift & { counted?: string })[], module);
    if (last?.counted) {
      try {
        const counted = JSON.parse(last.counted) as Record<string, number>;
        return {
          // Cash only. See carryOverFloats for why a card is not a float.
          floats: carryOverFloats(counted, methods),
          source: 'carried_over',
          policy,
          from: { id: last.$id, code: last.code },
          // The shift it came from is named. A float carried from the wrong
          // drawer is invisible as a number and obvious as a shift code.
          note: `Cash carried over from ${last.code}, this side's last shift. Count it to be sure. `
            + 'Card and mobile money start at nothing — nothing is left in a terminal overnight.',
        };
      } catch {
        // A malformed count is not worth failing an open over.
      }
    }
    return {
      floats: Object.fromEntries(methods.map((m) => [m.$id, 0])),
      // Nothing was carried, so nothing is what this started with.
      source: 'zero',
      policy,
      note: `No previous ${MODULE_LABELS[module].toLowerCase()} shift to carry over from, starting at nothing.`,
    };
  }

  if (policy === 'fixed') {
    // The fixed amount is a cash float; putting it against a card terminal
    // would invent money that was never there.
    return {
      floats: Object.fromEntries(
        methods.map((m) => [m.$id, m.kind === 'cash' ? settings.shift_float_default ?? 0 : 0]),
      ),
      // A figure the business set, not one worked out from a previous count.
      source: 'manual',
      policy,
      note: 'The standard opening float. Change it if the drawer holds something else.',
    };
  }

  if (policy === 'prompt') {
    return {
      floats: {},
      // Whatever is typed into an empty box is somebody's own count.
      source: 'manual',
      policy,
      note: 'Count each drawer and enter what is in it.',
    };
  }

  return {
    floats: Object.fromEntries(methods.map((m) => [m.$id, 0])),
    source: 'zero',
    policy: 'zero',
    note: 'Starting at nothing. Enter anything already in the drawer.',
  };
}

export async function openShift(opts: {
  venueId: string;
  userId: string;
  floats: Record<string, number>;
  /** Where the opening figure came from, for the record. See FloatSource. */
  floatSource?: FloatSource;
  /**
   * The shift the cash was carried out of, when it was carried.
   *
   * Written down because "why did this shift start with GH₵650 that was not in
   * the drawer" is a question with no answer anywhere else. A float is the one
   * figure on a close that nobody at the close chose, and without a trail back
   * to where it came from the only way to settle the argument is to remember.
   */
  carriedFrom?: string;
  /**
   * Which side of the business this shift is for.
   *
   * A kitchen and a craft shop under one roof keep separate books: different
   * counters, different spending, different people answerable for the drawer.
   * Each side opens and closes its own shift, and closing one leaves the other
   * exactly where it was.
   */
  module?: Module;
}): Promise<Shift> {
  const module = opts.module ?? 'kitchen';

  /**
   * One shift per side, never two.
   *
   * Each side of the business runs exactly one at a time: a kitchen shift and
   * a craft shift, side by side and independent, and nothing else. Two on one
   * side splits a day's takings across two sets of books that neither balances
   * against, and until it was surfaced they were invisible, so closing one
   * simply revealed the next and every close looked like it had failed.
   *
   * Refused here rather than only hidden in the till, because the till is not
   * the only way one gets opened: two devices, a double tap, a retried request
   * on a bad connection. A check is not a lock, and this database has no
   * transactions, so a genuine simultaneous open on two devices can still slip
   * through. That is why the bars still say when more than one is open. This
   * closes the case that actually happens; that catches the rest.
   */
  const already = await loadOpenShifts(opts.venueId, module).catch(() => [] as Shift[]);
  if (already.length > 0) {
    throw new Error(
      `A ${module === 'craft' ? 'craft shop' : 'kitchen'} shift is already open (${already[0].code}). ` +
      'Close that one before opening another.',
    );
  }

  // BIST for the bistro, CRAF for the shop. Which counter a shift belongs to is
  // the first thing anybody needs from its code.
  const code = shiftCode(module);
  const doc = await db.createDocument(DB_ID, 'shifts', ID.unique(), {
    venue_id: opts.venueId,
    code,
    status: 'open',
    opened_by: opts.userId,
    opened_at: new Date().toISOString(),
    opening_floats: JSON.stringify(opts.floats),
    float_source: opts.floatSource ?? 'zero',
    ...(opts.carriedFrom ? { carried_from_shift_id: opts.carriedFrom } : {}),
    sales_total: 0, expense_total: 0, tax_total: 0, tip_total: 0, discount_total: 0,
    void_total: 0, refund_total: 0, cogs_total: 0, covers: 0,
    stock_check_status: 'pending', posted_to_ledger: false,
    module,
  });

  const shift = doc as unknown as Shift;

  // Anything the last shift ran past its limit to take comes onto this one, at
  // the moment it opens. Surfaced rather than left waiting to be found: an
  // order nobody is shown is an order nobody cooks.
  await adoptShelved(opts.venueId, shift).catch(() => undefined);

  return shift;
}

/**
 * The open shift for one side of the business.
 *
 * Filtered in memory rather than in the query, because shifts opened before
 * the column existed carry no module at all and a database filter would step
 * straight over them, which would look, from the till, like the shift somebody
 * opened this morning had vanished. A venue has at most a couple of open shifts
 * at once, so reading them and choosing costs nothing.
 */
export async function loadOpenShifts(venueId: string, module: Module = 'kitchen'): Promise<Shift[]> {
  const res = await db.listDocuments(DB_ID, 'shifts', [
    Query.equal('venue_id', venueId),
    Query.equal('status', 'open'),
    Query.limit(25),
  ]);
  return openShiftsFor(res.documents as unknown as Shift[], module);
}

/**
 * The one this side is on. Newest, when more than one is somehow open.
 *
 * Callers that need to know there ARE more than one should use
 * `loadOpenShifts` and say so, because a second open shift is invisible from
 * here and closing the first only reveals it.
 */
export async function loadOpenShift(venueId: string, module: Module = 'kitchen'): Promise<Shift | null> {
  return (await loadOpenShifts(venueId, module))[0] ?? null;
}

/**
 * Every order that belongs to a shift, by either of the two ways one can.
 *
 * Asking by the shift's clock alone was wrong in one direction and asking by
 * its id alone was wrong in the other, so this asks both ways and merges.
 *
 * A customer ordering from their phone has no shift stamped on the order, the
 * menu has no idea whether one is open, so the clock is the only thing that
 * ties those to a night. But an order placed BEFORE anyone opened the till,
 * which is every pre-order and everything taken in the quiet half hour before
 * service, falls outside that window and used to belong to no shift at all: the
 * money appeared in the takings, because the payment carries the shift, while
 * the order itself was missing from the list the takings were supposed to
 * explain. Collecting the payment is what settles the question, and that is
 * exactly when the order gets stamped.
 *
 * So: created during the shift, or paid by it. Either is enough.
 */
export async function ordersForShift(
  venueId: string,
  shift: Pick<Shift, '$id' | 'opened_at' | 'closed_at' | 'module'>,
): Promise<Order[]> {
  const module = shift.module ?? 'kitchen';
  const closed = shift.closed_at ?? new Date().toISOString();
  const [inWindow, stamped] = await Promise.all([
    listAll<Order>('orders', [
      Query.equal('venue_id', venueId),
      Query.greaterThanEqual('$createdAt', shift.opened_at),
      Query.lessThanEqual('$createdAt', closed),
    ]),
    listAll<Order>('orders', [Query.equal('shift_id', shift.$id)]),
  ]);

  const byId = new Map<string, Order>();
  for (const o of [...inWindow, ...stamped]) {
    /*
      A stamp wins outright, and the clock is only the fallback.

      This asked "is it stamped to me OR was it rung up while I was open", and
      an order moved to another shift answers yes to the second for ever. So a
      sale moved to the night it belonged to was counted on BOTH nights, and
      the two shifts disagreed with each other from then on — which made the
      move that fixed one figure quietly break another. See belongsToShift.
    */
    if (!belongsToShift(o, { ...shift, module }, closed)) continue;
    /**
     * A cancelled order is not part of the shift.
     *
     * It sold nothing, and the money already ignored it: shiftBlockers skips
     * it, the takings never counted it. Leaving it in the list meant the one
     * place a cook looks to see what the shift did still showed an order that
     * did not happen, and an admin who cancelled one had no way to make it go.
     *
     * Rejections stay. A cook turning an order away is something the kitchen
     * did, and worth being able to look back at.
     */
    if (o.status === 'CANCELLED') continue;
    byId.set(o.$id, o);
  }
  return [...byId.values()].sort((a, b) => b.$createdAt.localeCompare(a.$createdAt));
}

/** An order that stops the shift being closed, and why. */
export interface ShiftBlocker {
  order: Order;
  reason: 'unpaid' | 'uncollected';
}

/**
 * What is stopping this shift from closing.
 *
 * A shift that closes over an unpaid bill loses the money silently: the order
 * stays open into a shift that never sold it, and the drawer balances because
 * nothing was ever expected. Food that has not left the pass is the same
 * problem one step earlier. Both are answerable in a minute at the time and
 * unanswerable the next morning, which is why they are asked now.
 */
export async function shiftBlockers(
  venueId: string,
  _shiftId?: string,
  module: Module = 'kitchen',
  /**
   * The shift being closed, when there is one.
   *
   * Only needed for the single exception: an order taken after this shift had
   * already run past its limit does not hold it open. Without the shift, this
   * cannot tell such an order from any other, so it treats them all the
   * ordinary way, which is the safe direction to be wrong in.
   */
  shift?: Pick<Shift, 'opened_at'> | null,
): Promise<ShiftBlocker[]> {
  // Every live order for the venue, not only those stamped with this shift.
  //
  // That distinction is what let a shift close over an unpaid order: a
  // customer ordering from their phone has no shift to be stamped with, the
  // menu does not know one is open, so `shift_id` is blank and a query by
  // shift never saw it. The question is not "which orders belong to this
  // shift", it is "is anything still owed or still on the pass".
  const orders = await listAll<Order>('orders', [Query.equal('venue_id', venueId)]);
  const blockers: ShiftBlocker[] = [];
  for (const o of orders) {
    // Only this side's. A craft shop cannot be held open by an unpaid plate of
    // jollof, and telling it that it is would teach staff to close over the
    // warning, which is the one thing this must never become.
    if ((o.module ?? 'kitchen') !== module) continue;
    // A pre-order for tomorrow is not this shift's problem.
    if (['CANCELLED', 'REJECTED', 'CLOSED', 'SCHEDULED'].includes(o.status)) continue;
    /**
     * The one exception.
     *
     * An order taken after the shift had already run past a day is work the
     * shift should never have accepted, and holding the shift open over it
     * would be holding it open over the very thing that is keeping it open. It
     * is shelved at the close instead and picked up by the next shift, so the
     * food is still cooked and the money is still owed, on a night that has
     * not already ended.
     */
    if (mustWaitForNextShift(o, shift)) continue;
    // The rule itself is in shift-rules, so it can be checked without a
    // database. This does the reading and asks it the question.
    const reason = blockerFor(o);
    if (reason) blockers.push({ order: o, reason });
  }
  return blockers;
}

export interface ExpectedTakings {
  /** Opening float plus everything taken, per payment method. */
  byMethod: Record<string, number>;
  openingFloats: Record<string, number>;
  takenByMethod: Record<string, number>;
  /** Cash paid out during the shift, which the drawer no longer holds. */
  cashExpenses: number;
  /** Everything paid out during the shift, however it was paid. */
  expensesTotal: number;
  /**
   * Of that, what came from petty cash rather than the shift's own takings.
   *
   * Spent by the business, but out of money this shift never took, so it is
   * deliberately not part of what the count is measured against. Reported
   * separately so the two figures cannot be mistaken for each other at
   * closing time.
   */
  ownMoneyTotal: number;
  salesTotal: number;
  tipsTotal: number;
  payments: ShiftPayment[];
}

/**
 * Can this shift still take money?
 *
 * No, once it has been open for a day. Everything after that would be filed
 * under a night that ended, and a drawer counted against two days of takings
 * balances by accident or not at all.
 */
export const shiftUsable = (shift: Pick<Shift, 'opened_at'> | null | undefined): boolean =>
  !!shift && !shiftAge(shift.opened_at, new Date(), SHIFT_MAX_HOURS).over;

/**
 * What the drawer should hold, worked out rather than typed.
 *
 * Staff enter only what they physically have. Everything on the other side of
 * the comparison is computed from records the system already holds, because a
 * figure somebody types in as "expected" is not a check on anything.
 */
export async function expectedTakings(shift: Shift, methods: PaymentMethod[]): Promise<ExpectedTakings> {
  const [payments, expenses] = await Promise.all([
    listAll<ShiftPayment>('payments', [Query.equal('shift_id', shift.$id)]),
    listAll<{ amount: number; paid_from_method_id: string; from_takings?: boolean }>('shift_expenses', [
      Query.equal('shift_id', shift.$id),
    ]),
  ]);

  const openingFloats: Record<string, number> = JSON.parse(shift.opening_floats || '{}');
  const takenByMethod: Record<string, number> = {};
  let salesTotal = 0;
  let tipsTotal = 0;
  // A payment voided as never-received is not money the drawer should hold.
  // Counting it here would make the shift read as OVER by that amount and send
  // somebody looking for cash that was never there.
  for (const p of payments.filter(isLivePayment)) {
    takenByMethod[p.method_id] = (takenByMethod[p.method_id] ?? 0) + p.amount + (p.tip ?? 0);
    salesTotal += p.amount;
    tipsTotal += p.tip ?? 0;
  }

  /**
   * Only spending that actually came out of this drawer reduces this drawer.
   *
   * Two different things used to be filed as one. A cook sent to the market
   * with money from the till has spent the till's money, and the count at the
   * end of the night must expect that much less. A cook who was given petty
   * cash has spent something this shift never took, and deducting it makes
   * the drawer look short by an amount that was never in it — the shift is
   * then chased over a shortage that did not happen, which is exactly the
   * kind of accusation that makes people stop recording expenses at all.
   *
   * The expense is recorded either way. It is money the business spent and it
   * belongs in the books; what it is not, in the second case, is money missing
   * from a drawer.
   *
   * Absent means yes, because every row written before this question existed
   * was money out of the drawer and has been counted that way all along.
   */
  const fromTakings = expenses.filter((e) => e.from_takings !== false);

  const byMethod: Record<string, number> = {};
  let cashExpenses = 0;
  for (const m of methods) {
    // Money paid out of a drawer is money that drawer no longer holds. Leaving
    // this out is the single most common source of a phantom shortage.
    const paidOut = fromTakings
      .filter((e) => e.paid_from_method_id === m.$id)
      .reduce((a, e) => a + e.amount, 0);
    if (m.kind === 'cash') cashExpenses += paidOut;
    byMethod[m.$id] = (openingFloats[m.$id] ?? 0) + (takenByMethod[m.$id] ?? 0) - paidOut;
  }

  // Everything spent, whoever's pocket it came from. This is the P&L figure and
  // it is a different question from what the drawer should hold; the two were
  // the same number only for as long as there was no way to say otherwise.
  const expensesTotal = expenses.reduce((a, e) => a + e.amount, 0);
  const ownMoneyTotal = expenses.filter((e) => e.from_takings === false).reduce((a, e) => a + e.amount, 0);

  return {
    byMethod, openingFloats, takenByMethod, cashExpenses, expensesTotal, ownMoneyTotal,
    salesTotal, tipsTotal, payments,
  };
}

/**
 * Park the orders a shift ran past its limit to take, so it can close.
 *
 * They are not cancelled and not closed. The food was cooked and is still owed
 * for; what is wrong with them is only which night they are filed under, and
 * that is fixed by moving them to the next one rather than by pretending they
 * did not happen.
 *
 * The shift they came off is written down, because "why is this order on
 * tonight when it was ordered on Sunday" is a question somebody will ask and
 * the answer has to be on the order itself.
 */
export async function shelvePastLimit(
  venueId: string,
  shift: Pick<Shift, '$id' | 'opened_at' | 'module'>,
): Promise<Order[]> {
  const module = shift.module ?? 'kitchen';
  const orders = await listAll<Order>('orders', [Query.equal('venue_id', venueId)]).catch(
    () => [] as Order[],
  );

  const shelved: Order[] = [];
  for (const o of orders) {
    if ((o.module ?? 'kitchen') !== module) continue;
    if (['CANCELLED', 'REJECTED', 'CLOSED', 'SCHEDULED'].includes(o.status)) continue;
    // Already waiting, or already been through the shelf once. An order that
    // has been moved is an ordinary order of whichever shift picked it up, and
    // moving it a second time would be a way of never settling it at all.
    if (o.shelved_at || o.shelved_from_shift) continue;
    if (!mustWaitForNextShift(o, shift)) continue;

    await db
      .updateDocument(DB_ID, 'orders', o.$id, {
        shelved_at: new Date().toISOString(),
        shelved_from_shift: shift.$id,
        // Off this shift's books. It takes no money for these and its takings
        // must not carry them.
        shift_id: '',
      })
      .catch(() => undefined);
    shelved.push(o);
  }
  return shelved;
}

/**
 * Hand shelved orders to a shift that has just opened.
 *
 * Called at the moment a new shift starts, so the first thing whoever opens it
 * sees is the work still outstanding rather than an empty pass. An order that
 * quietly waited for somebody to go looking for it is an order nobody finds.
 */
export async function adoptShelved(
  venueId: string,
  shift: Pick<Shift, '$id' | 'module'>,
): Promise<Order[]> {
  const module = shift.module ?? 'kitchen';
  const orders = await listAll<Order>('orders', [
    Query.equal('venue_id', venueId),
    Query.isNotNull('shelved_at'),
  ]).catch(() => [] as Order[]);

  const taken: Order[] = [];
  for (const o of orders) {
    if ((o.module ?? 'kitchen') !== module) continue;
    if (['CANCELLED', 'REJECTED', 'CLOSED'].includes(o.status)) continue;

    // Two writes, and the order matters. The stamp is what makes this the new
    // shift's order and what makes it payable; clearing the flag is only
    // tidiness. One call would have meant a rejected `null` losing the stamp
    // as well, and an order nobody could take money for.
    const stamped = await db
      .updateDocument(DB_ID, 'orders', o.$id, { shift_id: shift.$id })
      .then(() => true)
      .catch(() => false);
    if (!stamped) continue;

    await db.updateDocument(DB_ID, 'orders', o.$id, { shelved_at: null }).catch(() => undefined);
    taken.push(o);
  }
  return taken;
}

export interface CloseShiftResult {
  variance: Record<string, number>;
  totalOff: number;
  cogs: number;
  stockNote: string;
  ledgerError: string | null;
  /** Orders moved onto the next shift because this one ran past its limit. */
  shelved: Order[];
}

/**
 * Close the shift.
 *
 * Order matters here. The stock and the money are settled first, then the
 * shift is written closed, then the ledger is posted, so a failure in the
 * accounts leaves a shift that is closed and counted rather than one stuck
 * half-open with the drawer already back in the safe.
 */
export async function closeShift(opts: {
  venueId: string;
  shift: Shift;
  userId: string;
  settings: Settings;
  features: FeatureMap;
  methods: PaymentMethod[];
  /** What was physically counted, in minor units, per method. */
  counted: Record<string, number>;
  /** Required when anything is out; enforced by the caller and stored here. */
  varianceNote?: string;
  /** OK / LOW / OUT as tapped during the stock check. */
  levels: Record<string, 'OK' | 'LOW' | 'OUT'>;
  /**
   * What was physically counted, per ingredient, when the restaurant asks for
   * amounts rather than levels. Present alongside `levels` rather than instead
   * of it: the level is still what the summary and the alerts read, it has just
   * been worked out from the number instead of tapped.
   */
  stockCounts?: Record<string, number>;
}): Promise<CloseShiftResult> {
  const { venueId, shift, userId, settings, features, methods, counted, levels } = opts;
  const stockCounts = opts.stockCounts ?? {};

  // First, before anything is counted. An order taken after this shift ran past
  // its limit is moved off its books, so the takings below and the summary that
  // goes out cover the night this shift actually worked. It is not lost: the
  // next shift opened picks it up.
  const shelved = await shelvePastLimit(venueId, shift);

  const takings = await expectedTakings(shift, methods);
  const variance = Object.fromEntries(
    Object.keys(counted).map((k) => [k, (counted[k] ?? 0) - (takings.byMethod[k] ?? 0)]),
  );

  const shiftOrders = (await listAll<Order>('orders', [Query.equal('shift_id', shift.$id)])).filter(
    (o) => o.payment_status === 'paid',
  );
  const soldItems = shiftOrders.length
    ? await listAll<OrderItem>('order_items', [Query.equal('order_id', shiftOrders.map((o) => o.$id))])
    : [];

  let cogs = 0;
  let stockNote = '';
  if (isEnabled(features, 'waste_log') || soldItems.length || Object.keys(levels).length) {
    /*
      This side's larder only.

      Closing the bistro used to load every ingredient in the building, which
      put the bar's bottles through the same alert arithmetic: a bar item low
      for one bar shift would read as low for six because the kitchen had
      closed six times in between. The shift's own counters were being driven
      by somebody else's trade, and the closing email then listed the lot.
    */
    const side = shift.module ?? 'kitchen';
    const [ingredients, recipes] = await Promise.all([loadIngredients(venueId, side), loadRecipes()]);
    const usage = await depleteForShift(venueId, shift.$id, soldItems, recipes, ingredients, userId);
    for (const [ingredientId, qty] of Object.entries(usage)) {
      const ing = ingredients.find((i) => i.$id === ingredientId);
      if (ing) cogs += Math.round(qty * ing.base_unit_cost);
    }

    // What staff actually saw on the shelf. The two figures disagreeing is the
    // entire point of asking.
    for (const [ingredientId, level] of Object.entries(levels)) {
      const ing = ingredients.find((i) => i.$id === ingredientId);
      if (!ing) continue;
      /*
        A bar's drinks have already been taken off the shelf.

        `depleteForShift` deliberately skips the bar — see the note there — so
        by the time a bar shift closes, `current_qty` is ALREADY net of the
        night's pours. Subtracting the usage a second time would set what the
        shelf "should" hold to well below what was actually sold from it, and
        every bartender would be told they were short by exactly the amount
        they served. What the recipes say was used is still the right figure
        for the kitchen, whose depletion happens here and now.
      */
      const poured = (ing.module ?? 'kitchen') === 'bar' ? 0 : usage[ingredientId] ?? 0;
      const theoretical = Number((ing.current_qty - poured).toFixed(4));
      const countedQty = stockCounts[ingredientId];
      const wasCounted = typeof countedQty === 'number' && Number.isFinite(countedQty);

      // The gap between what the recipes say should be left and what is
      // actually on the shelf. This is the number the whole stock system exists
      // to produce, it is where over-portioning, waste and theft show up, and
      // it can only be worked out when somebody has counted. A tapped level
      // cannot produce it, which is the real argument for counting.
      const varianceQty = wasCounted ? Number((countedQty - theoretical).toFixed(4)) : 0;

      await db.createDocument(DB_ID, 'shift_stock_checks', ID.unique(), {
        venue_id: venueId,
        shift_id: shift.$id,
        ingredient_id: ingredientId,
        // The count taken at the END. A bar also counts when it opens, and the
        // two are separate records: one is what somebody accepted, the other
        // is what they handed over. See the note on `phase` in the schema.
        phase: 'close',
        opening_qty: ing.current_qty,
        theoretical_qty: theoretical,
        counted_qty: wasCounted ? countedQty : undefined,
        status: level,
        // 'auto' when the status came from a number, because it did: nobody
        // overrode anything, the thresholds decided.
        status_source: wasCounted ? 'auto' : 'manual_override',
        variance_qty: varianceQty,
        variance_value: Math.round(varianceQty * ing.base_unit_cost),
        checked_by: userId,
      }).catch(() => undefined);

      // A real count is the best truth there is, so it replaces the running
      // figure outright. Otherwise "out" still means out, whatever the book
      // says, trust the eyes.
      if (wasCounted) {
        await db.updateDocument(DB_ID, 'ingredients', ingredientId, { current_qty: countedQty }).catch(() => undefined);
      } else if (level === 'OUT') {
        await db.updateDocument(DB_ID, 'ingredients', ingredientId, { current_qty: 0 }).catch(() => undefined);
      }
    }

    const after = await loadIngredients(venueId, side);
    const threshold = featureConfig(features, 'shift_summary', 'persistent_stock_threshold', 3);
    const { fresh, persistent } = await updateStockAlerts(
      // Same list the closing check shows. Something nobody counts cannot be
      // reported as running low, and saying a taxi is low on stock is how an
      // alert email teaches people to ignore alert emails.
      // One rule for "there is a shelf to walk", shared with every other
      // sheet in the system. See countable.
      countable(after.filter((i) => i.active)),
      settings.low_stock_default_bp ?? 3000,
      threshold,
      // What the cook reported wins over what the recipes imply. Without this,
      // tapping LOW moved nothing, the running quantity stayed put, the
      // arithmetic called the item fine, and it never reached the email.
      levels,
    );
    if (fresh.length || persistent.length) {
      stockNote =
        `${fresh.length} newly low, ${persistent.length} low for ${threshold}+ shifts` +
        (persistent.length ? `: ${persistent.map((p) => p.ingredient.name).slice(0, 4).join(', ')}` : '');
    }
  }

  const totalOff = Object.values(variance).reduce((a, b) => a + b, 0);
  const shiftExpenses = await listAll<{ $id: string; amount: number; category_key?: string; category?: string }>(
    'shift_expenses',
    [Query.equal('shift_id', shift.$id)],
  );
  const expenseCategories = await listAll<{ key: string; account_code?: string }>('expense_categories').catch(
    () => [] as { key: string; account_code?: string }[],
  );
  const accountForExpense = (e: { category_key?: string; category?: string }) =>
    expenseCategories.find((c) => c.key === (e.category_key || e.category))?.account_code || '6090';

  await db.updateDocument(DB_ID, 'shifts', shift.$id, {
    status: 'closed',
    closed_by: userId,
    closed_at: new Date().toISOString(),
    expected: JSON.stringify(takings.byMethod),
    counted: JSON.stringify(counted),
    variance: JSON.stringify(variance),
    variance_note: opts.varianceNote ?? '',
    sales_total: takings.salesTotal,
    expense_total: shiftExpenses.reduce((a, e) => a + e.amount, 0),
    cogs_total: cogs,
    tip_total: takings.tipsTotal,
    tax_total: shiftOrders.reduce((a, o) => a + o.tax_total, 0),
    discount_total: shiftOrders.reduce((a, o) => a + o.discount_total, 0),
    covers: shiftOrders.reduce((a, o) => a + (o.guest_count || 1), 0),
  });

  let ledgerError: string | null = null;
  try {
    const byKind = { cash: 0, card: 0, mobile_money: 0, other: 0 };
    for (const p of takings.payments) {
      const method = methods.find((x) => x.$id === p.method_id);
      const kind = (method?.kind ?? 'other') as keyof typeof byKind;
      byKind[kind in byKind ? kind : 'other'] += p.amount;
    }
    await postShift({
      venueId,
      shiftId: shift.$id,
      postedBy: userId,
      takings: byKind,
      tips: takings.tipsTotal,
      tax: shiftOrders.reduce((a, o) => a + o.tax_total, 0),
      discounts: shiftOrders.reduce((a, o) => a + o.discount_total, 0),
      cogs,
      cashVariance: totalOff,
      // Which books this shift's takings and costs belong in. A bar shift and
      // a kitchen shift close the same way and mean different trades.
      module: (shift.module ?? 'kitchen') as Module,
      // By id, so an expense already posted when it was recorded is not
      // posted again here. See postExpense.
      expenses: shiftExpenses.map((e) => ({
        expenseId: e.$id,
        amount: e.amount,
        accountCode: accountForExpense(e),
      })),
    });
    await db.updateDocument(DB_ID, 'shifts', shift.$id, { posted_to_ledger: true });
  } catch (e) {
    ledgerError = e instanceof Error ? e.message : 'unknown';
  }

  return { variance, totalOff, cogs, stockNote, ledgerError, shelved };
}

/* -------------------------------------------- correcting a shift after the fact */

/**
 * Work the drawer figures out again, for a shift that has already closed.
 *
 * An expense can be reclassified long after the night it belongs to: somebody
 * says "that taxi came out of my own pocket, not the till", and until then the
 * shift was short by that much on paper and whoever held the drawer was
 * carrying a shortage they never caused. Correcting the row is only half of
 * it; the shift stored what it expected and what was over or short at the
 * moment it closed, and those figures do not recompute themselves.
 *
 * What the drawer actually held is left exactly as it was. That was counted by
 * a person, it is the one number here that was never derived, and nothing
 * discovered afterwards can change what was in the till that night. Only what
 * SHOULD have been there moves, and the over-or-short with it.
 *
 * An open shift needs none of this: it works its figures out from the rows
 * every time it is looked at, so a correction is already in them.
 */
export async function recomputeClosedShift(shiftId: string): Promise<{
  expected: Record<string, number>;
  variance: Record<string, number>;
  totalOff: number;
} | null> {
  const shift = (await db.getDocument(DB_ID, 'shifts', shiftId)) as unknown as Shift & {
    counted?: string;
    venue_id: string;
  };
  if (shift.status !== 'closed') return null;

  const methods = await loadPaymentMethods(shift.venue_id);
  const takings = await expectedTakings(shift, methods);

  let counted: Record<string, number> = {};
  try {
    counted = JSON.parse(shift.counted || '{}');
  } catch {
    // A count that cannot be read is not a count. Better to leave the variance
    // alone than to invent one against nothing.
    return null;
  }

  const variance = Object.fromEntries(
    Object.keys(counted).map((k) => [k, (counted[k] ?? 0) - (takings.byMethod[k] ?? 0)]),
  );
  const totalOff = Object.values(variance).reduce((a, b) => a + b, 0);

  await db.updateDocument(DB_ID, 'shifts', shiftId, {
    expected: JSON.stringify(takings.byMethod),
    variance: JSON.stringify(variance),
    // Everything spent, whoever paid for it. Unchanged by whose money it was,
    // because the business spent it either way; only the drawer figures move.
    expense_total: takings.expensesTotal,
    // And what it took. An order cancelled or removed afterwards takes its
    // money out of the shift with it, so this has to be worked out again too
    // or the summary keeps reporting a sale that no longer exists.
    sales_total: takings.salesTotal,
    tip_total: takings.tipsTotal,
  });

  return { expected: takings.byMethod, variance, totalOff };
}

/**
 * Correct when a shift ended.
 *
 * Only the clock. Nothing about the money moves and nothing needs to be worked
 * out again: the takings come from payments stamped with the shift and the
 * count came from a person, and neither has any opinion about what the closing
 * timestamp says. See shift-times for what it does affect — which day the
 * shift is reported under, and one half of the window in ordersForShift.
 *
 * The reason is required by the screen and stored in its own field, because
 * "the manager closed it at breakfast" and "somebody moved a shift off the day
 * it was short on" look identical in a before-and-after pair.
 */
export async function changeShiftClose(opts: {
  shift: Pick<Shift, '$id' | 'venue_id' | 'code' | 'closed_at'> & LockableShift;
  closedAt: string;
  userId: string;
  reason: string;
}): Promise<void> {
  /*
    Refused here, not only on the screen that offers it.

    A rule enforced in the page that has the button is a rule with as many ways
    round it as there are pages, and the close time is reachable from more than
    one. See shift-lock.
  */
  const settled = lockedProblem(opts.shift, 'the close time');
  if (settled) throw new Error(settled);

  await db.updateDocument(DB_ID, 'shifts', opts.shift.$id, { closed_at: opts.closedAt });

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: opts.shift.venue_id,
    actor_id: opts.userId,
    action: 'shift_close_changed',
    entity_type: 'shift',
    entity_id: opts.shift.$id,
    before: JSON.stringify({ closed_at: opts.shift.closed_at ?? '' }),
    after: JSON.stringify({ closed_at: opts.closedAt }),
    reason: opts.reason.slice(0, 500),
    shift_id: opts.shift.$id,
  }).catch(() => undefined);
}

/**
 * Put a closed shift's accounting entries back in step with its records.
 *
 * `recomputeClosedShift` fixes what the shift itself says it took. This fixes
 * what the BOOKS say it took, which is a different thing and the one an
 * accountant reads. An order moved onto another shift leaves the losing shift
 * still crediting sales it no longer made, and — the part that actually costs
 * somebody money — still carrying a cash shortage that was only ever the sale
 * being filed in the wrong place.
 *
 * Reversed and reposted rather than edited. The figures are rebuilt from the
 * rows as they now stand by the same postShift the close itself uses, so a
 * corrected shift is posted identically to one that had been right first time
 * — no second implementation of what a shift's entry looks like, which is how
 * the two would eventually disagree.
 *
 * BOTH HALVES ARE DATED ON THE ORIGINAL. A reversal is normally dated today
 * and should be; that is for undoing something that genuinely happened. This
 * is a figure that was never true, and leaving its cancellation in this month
 * while the replacement lands in the month it belongs to would move a night's
 * takings between two periods that never saw them.
 *
 * THREE THINGS ARE DELIBERATELY LEFT ALONE:
 *
 *   - Expenses. They post themselves by their own id and have nothing to do
 *     with which shift an order was filed under.
 *   - The cost of goods sold. It is derived from a stock depletion that has
 *     already physically happened, and cannot be re-derived here without
 *     recipes; both shifts are on the same side of the business, so the
 *     account it sits in is the same either way.
 *   - Anything in a period the books have been closed off through. Refused
 *     whole rather than half done, and said plainly, because the alternative
 *     is a reversal posted with no replacement behind it.
 */
export async function repostShiftAccounts(opts: {
  shiftId: string;
  userId: string;
  reason: string;
}): Promise<{ changed: boolean; note: string }> {
  const shift = (await db.getDocument(DB_ID, 'shifts', opts.shiftId).catch(() => null)) as unknown as
    (Shift & { counted?: string; cogs_total?: number }) | null;
  if (!shift) return { changed: false, note: '' };
  if (shift.status !== 'closed') {
    // Nothing has been posted yet and nothing needs correcting: an open shift
    // works its figures out from the rows and posts them when it closes.
    return { changed: false, note: '' };
  }

  const venueId = shift.venue_id;
  const live = await shiftCloseEntries(venueId, shift.$id);
  /*
    Only the two entries whose figures move.

    Matched on the memos postShift writes, which are fixed strings in that one
    function rather than anything a person types. The cost-of-goods entry is
    left standing; see the note above.
  */
  const MOVES = ['Shift sales', 'Cash short', 'Cash over'];
  const stale = live.filter((e) => MOVES.includes(e.memo ?? ''));

  // Where the replacement belongs: exactly where the original sat. Falling
  // back to the close itself for a shift whose posting never happened.
  const when = new Date(stale[0]?.date ?? shift.closed_at ?? shift.$createdAt);

  const lockedThrough = await lockedThroughFor(venueId);
  for (const d of [when.toISOString(), ...stale.map((e) => e.date)]) {
    if (isLocked(d, lockedThrough)) {
      return {
        changed: false,
        note: `The books are closed through ${lockedThrough}, so the accounts for ${shift.code} were not `
          + 'touched. Reopen the period under Accounting, or post the correction by hand.',
      };
    }
  }

  const methods = await loadPaymentMethods(venueId);
  const takings = await expectedTakings(shift, methods);

  let counted: Record<string, number> = {};
  try {
    counted = JSON.parse(shift.counted || '{}');
  } catch {
    // A count that cannot be read cannot produce an over-or-short, and
    // inventing one against nothing is worse than leaving the books alone.
    return { changed: false, note: `${shift.code}'s drawer count could not be read, so its books were left alone.` };
  }
  const totalOff = Object.keys(counted).reduce(
    (a, k) => a + ((counted[k] ?? 0) - (takings.byMethod[k] ?? 0)),
    0,
  );

  const paid = (await listAll<Order>('orders', [Query.equal('shift_id', shift.$id)]))
    .filter((o) => o.payment_status === 'paid');

  const byKind = { cash: 0, card: 0, mobile_money: 0, other: 0 };
  for (const p of takings.payments) {
    const kind = (methods.find((x) => x.$id === p.method_id)?.kind ?? 'other') as keyof typeof byKind;
    byKind[kind in byKind ? kind : 'other'] += p.amount;
  }

  // Out first, in second. A replacement posted before the cancellation would
  // leave a moment in which the books double-count the night, and anything
  // reading them in that moment reads a figure that was never true either.
  for (const e of stale) {
    await reverseEntry(e, {
      postedBy: opts.userId,
      date: new Date(e.date),
      memo: `Correcting ${shift.code}: ${opts.reason}`.slice(0, 300),
    });
  }

  await postShift({
    venueId,
    shiftId: shift.$id,
    postedBy: opts.userId,
    date: when,
    takings: byKind,
    tips: takings.tipsTotal,
    tax: paid.reduce((a, o) => a + o.tax_total, 0),
    discounts: paid.reduce((a, o) => a + o.discount_total, 0),
    // Left where it is. See the note above.
    cogs: 0,
    cashVariance: totalOff,
    module: (shift.module ?? 'kitchen') as Module,
    // They post themselves, by their own id, and none of them moved.
    expenses: [],
  });

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: venueId,
    actor_id: opts.userId,
    action: 'shift_accounts_reposted',
    entity_type: 'shift',
    entity_id: shift.$id,
    before: JSON.stringify({ reversed: stale.map((e) => ({ id: e.$id, memo: e.memo })) }).slice(0, 4000),
    after: JSON.stringify({ takings: byKind, tips: takings.tipsTotal, cashVariance: totalOff }).slice(0, 4000),
    reason: opts.reason.slice(0, 500),
    shift_id: shift.$id,
  }).catch(() => undefined);

  return {
    changed: true,
    note: stale.length > 0
      ? `${shift.code}'s accounts were reposted.`
      : `${shift.code} had nothing on the books; its accounts were posted.`,
  };
}

/**
 * Settle a shift, or open it back up.
 *
 * A row on the shift and an entry in the audit log, which together are the
 * whole feature: what changed, who did it, and why. Reopening is recorded in
 * exactly the same way as settling — somebody unlocking a night to change one
 * figure is precisely the event worth being able to see afterwards, and a
 * field that was simply cleared would forget it happened.
 */
export async function setShiftSealed(opts: {
  // Only what this needs, so a screen holding its own narrower shift row can
  // call it without owning the whole type.
  shift: { $id: string; venue_id: string } & LockableShift;
  sealed: boolean;
  userId: string;
  reason: string;
}): Promise<void> {
  if (opts.sealed) {
    const problem = sealProblem(opts.shift);
    if (problem) throw new Error(problem);
  } else if (!isSealed(opts.shift)) {
    return;
  }

  await db.updateDocument(DB_ID, 'shifts', opts.shift.$id, {
    locked_at: opts.sealed ? new Date().toISOString() : null,
    locked_by: opts.sealed ? opts.userId : '',
    lock_reason: opts.sealed ? opts.reason.slice(0, 300) : '',
  });

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: opts.shift.venue_id,
    actor_id: opts.userId,
    action: opts.sealed ? 'shift_settled' : 'shift_reopened',
    entity_type: 'shift',
    entity_id: opts.shift.$id,
    before: JSON.stringify({ locked_at: opts.shift.locked_at ?? '' }),
    after: JSON.stringify({ locked_at: opts.sealed ? new Date().toISOString() : '' }),
    reason: opts.reason.slice(0, 500),
    shift_id: opts.shift.$id,
  }).catch(() => undefined);
}

/**
 * Correct what a shift is recorded as having started with.
 *
 * The float is the one figure in a close that nobody counts twice. Everything
 * else is measured — takings from payments, spending from expenses, the drawer
 * from a person's hands — but the float is asserted once at the start and then
 * silently believed for the rest of the night. A wrong one is therefore
 * invisible until the drawer comes up short by exactly that amount, at which
 * point it looks like missing money with somebody's name against it.
 *
 * So it is correctable, and correcting it is an admin's job.
 *
 * AN OPEN SHIFT IS THE SIMPLE CASE and the one this was asked for: nothing has
 * been counted against it and nothing posted, so the correction is the write
 * and no more.
 *
 * A CLOSED ONE IS NOT, and is handled rather than refused, because a float is
 * usually discovered to be wrong at exactly the moment the drawer fails to
 * balance — which is after the close. Its expected figures are worked out
 * again and its accounting entries reposted from the corrected numbers, the
 * same path an order moved between shifts takes. What was physically counted
 * is never touched: that was a person with money in their hands, and it is the
 * one figure here that was never in doubt.
 */
export async function changeOpeningFloat(opts: {
  shift: Pick<Shift, '$id' | 'venue_id' | 'code' | 'status' | 'opening_floats'> & LockableShift;
  floats: Record<string, number>;
  userId: string;
  reason: string;
}): Promise<{ note: string }> {
  // Refused here as well as on the screen. A rule enforced only where the
  // button is has as many ways round it as there are pages.
  const settled = lockedProblem(opts.shift, 'the opening float');
  if (settled) throw new Error(settled);

  const before = opts.shift.opening_floats || '{}';
  await db.updateDocument(DB_ID, 'shifts', opts.shift.$id, {
    opening_floats: JSON.stringify(opts.floats),
  });

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: opts.shift.venue_id,
    actor_id: opts.userId,
    action: 'shift_float_changed',
    entity_type: 'shift',
    entity_id: opts.shift.$id,
    before: JSON.stringify({ opening_floats: before }).slice(0, 4000),
    after: JSON.stringify({ opening_floats: opts.floats }).slice(0, 4000),
    reason: opts.reason.slice(0, 500),
    shift_id: opts.shift.$id,
  }).catch(() => undefined);

  if (opts.shift.status !== 'closed') {
    return { note: `${opts.shift.code} now starts with what you entered.` };
  }

  /*
    A closed shift's figures do not recompute themselves.

    Both halves, and in this order. The shift's own expected and variance
    first, so the books are rebuilt from numbers that are already right —
    reposting against stale figures would put the old error back on the ledger
    in a fresh entry.

    Best effort on both. The correction itself has happened and is right; a
    period locked off in the accounts must not be reported as a failed edit.
  */
  await recomputeClosedShift(opts.shift.$id).catch(() => null);
  const posted = await repostShiftAccounts({
    shiftId: opts.shift.$id,
    userId: opts.userId,
    reason: opts.reason,
  }).catch(() => ({ changed: false, note: '' }));

  return {
    note: `${opts.shift.code}'s expected figures were worked out again.`
      + (posted.note ? ` ${posted.note}` : ''),
  };
}

/**
 * Ask for a shift's closing report to be sent again.
 *
 * A request, not a send. The browser cannot email anything and must not try:
 * the recipients, the mail provider's credentials and the whole summary live
 * on the server, and a second copy of that arrangement in the admin app would
 * be a second thing to keep in step.
 *
 * So this writes a flag the background job already watches. `summary_resend_at`
 * sits on the SHIFT rather than on the report for two reasons: nobody can
 * write to summary_reports from a browser — it is the record of what was
 * actually sent, and an admin able to edit it could rewrite what a report said
 * — and a shift update is already an event the job answers, so asking needs no
 * new trigger and no new permission.
 *
 * The job clears the flag once the mail is away, or once it has recorded why
 * it could not be. Present therefore means somebody is still waiting.
 */
export async function requestSummaryResend(opts: {
  shift: Pick<Shift, '$id' | 'code' | 'status'>;
  userId: string;
}): Promise<void> {
  // Checked here as well as on the screen. A rule held only where the button
  // is has as many ways round it as there are screens.
  const problem = resendProblem(opts.shift);
  if (problem) throw new Error(problem);
  const { dropped } = await saveDropping('shifts', opts.shift.$id, {
    summary_resend_at: new Date().toISOString(),
    summary_resend_by: opts.userId,
  });
  if (dropped.includes('summary_resend_at')) {
    throw new Error(
      'This project\'s database has not been updated for resending yet. Run Provision, then try again.',
    );
  }
}


/* ------------------------------------- a shift for a day that has passed */

/**
 * Open a shift for a day already gone, so trading can be filed under it.
 *
 * CREATED CLOSED, and that is the whole of the design. An open shift on a past
 * day is found by every till in the building as "the shift to sell against",
 * so tonight's drinks would land on last Tuesday and nobody would see it until
 * the month did not add up.
 *
 * It carries no float and no count. It is a container for trading that has
 * already happened and already been accounted for — the money was taken, the
 * drawer was counted on the night, and inventing figures for a shift that
 * nobody worked would be worse than leaving them at nothing. What it holds is
 * whatever is moved onto it, and its totals are worked out from those.
 *
 * Refused where the day already has one for that side. Two containers for one
 * night is the thing this exists to avoid, and the screen offers the existing
 * one instead.
 */
export async function openShiftForDay(opts: {
  venueId: string;
  day: string;
  module: Module;
  userId: string;
  reason: string;
}): Promise<Shift> {
  const existing = await listAll<Shift>('shifts', [Query.equal('venue_id', opts.venueId)])
    .catch(() => [] as Shift[]);
  const already = shiftsOnDay(
    existing as unknown as (MovableShift & { opened_at?: string; module?: string })[],
    opts.day,
    opts.module,
  );
  if (already.length > 0) {
    throw new Error(`That day already has a ${MODULE_LABELS[opts.module].toLowerCase()} shift. Move the sale onto it.`);
  }

  const { openedAt, closedAt } = backdatedWindow(opts.day);
  const doc = await db.createDocument(DB_ID, 'shifts', ID.unique(), {
    venue_id: opts.venueId,
    code: shiftCode(opts.module, new Date(openedAt)),
    status: 'closed',
    opened_by: opts.userId,
    opened_at: openedAt,
    closed_at: closedAt,
    closed_by: opts.userId,
    opening_floats: '{}',
    float_source: 'manual',
    sales_total: 0, expense_total: 0, tax_total: 0, tip_total: 0, discount_total: 0,
    void_total: 0, refund_total: 0, cogs_total: 0, covers: 0,
    stock_check_status: 'pending', posted_to_ledger: false,
    module: opts.module,
    variance_note: `Opened afterwards for ${opts.day}: ${opts.reason}`.slice(0, 500),
  });

  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: opts.venueId,
    actor_id: opts.userId,
    action: 'shift_backdated',
    entity_type: 'shift',
    entity_id: doc.$id,
    after: JSON.stringify({ day: opts.day, module: opts.module, reason: opts.reason }).slice(0, 4000),
  }).catch(() => undefined);

  return doc as unknown as Shift;
}
