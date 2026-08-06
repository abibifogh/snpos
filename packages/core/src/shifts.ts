import { db, DB_ID, ID, Query, listAll } from './client';
import type { Doc, Settings } from './types';
import type { Order, OrderItem } from './orders';
import { depleteForShift, loadIngredients, loadRecipes, updateStockAlerts } from './stock';
import { postShift } from './ledger';
import { featureConfig, isEnabled, type FeatureMap } from './features';

export interface Shift extends Doc {
  venue_id: string;
  code: string;
  status: 'open' | 'closing' | 'closed' | 'reopened';
  opened_by: string;
  opened_at: string;
  opening_floats: string;
  float_source: string;
  closed_at?: string;
  closed_by?: string;
  /** JSON, per method, written at close. */
  counted?: string;
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
}

export const loadPaymentMethods = async (venueId: string): Promise<PaymentMethod[]> =>
  (await listAll<PaymentMethod>('payment_methods', [Query.equal('venue_id', venueId)])).filter((m) => m.enabled);

/**
 * What each drawer should start the shift holding.
 *
 * Starting every shift at zero means somebody physically empties the till
 * every night, and most places do not — the float stays in the drawer and gets
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
): Promise<{ floats: Record<string, number>; source: string; note: string }> {
  const policy = settings.shift_float_policy ?? 'zero';

  if (policy === 'carry_over') {
    // What the last shift actually counted, not what it expected — the drawer
    // holds what it holds.
    const previous = await db.listDocuments(DB_ID, 'shifts', [
      Query.equal('venue_id', venueId),
      Query.equal('status', 'closed'),
      Query.orderDesc('$createdAt'),
      Query.limit(1),
    ]);
    const last = previous.documents[0] as unknown as (Shift & { counted?: string }) | undefined;
    if (last?.counted) {
      try {
        const counted = JSON.parse(last.counted) as Record<string, number>;
        return {
          floats: Object.fromEntries(methods.map((m) => [m.$id, counted[m.$id] ?? 0])),
          source: 'carry_over',
          note: `Carried over from ${last.code}. Count it to be sure.`,
        };
      } catch {
        // A malformed count is not worth failing an open over.
      }
    }
    return {
      floats: Object.fromEntries(methods.map((m) => [m.$id, 0])),
      source: 'carry_over',
      note: 'No previous shift to carry over from — starting at nothing.',
    };
  }

  if (policy === 'fixed') {
    // The fixed amount is a cash float; putting it against a card terminal
    // would invent money that was never there.
    return {
      floats: Object.fromEntries(
        methods.map((m) => [m.$id, m.kind === 'cash' ? settings.shift_float_default ?? 0 : 0]),
      ),
      source: 'fixed',
      note: 'The standard opening float. Change it if the drawer holds something else.',
    };
  }

  if (policy === 'prompt') {
    return { floats: {}, source: 'prompt', note: 'Count each drawer and enter what is in it.' };
  }

  return {
    floats: Object.fromEntries(methods.map((m) => [m.$id, 0])),
    source: 'zero',
    note: 'Starting at nothing. Enter anything already in the drawer.',
  };
}

export async function openShift(opts: {
  venueId: string;
  userId: string;
  floats: Record<string, number>;
  /** Where the opening figure came from, for the record. */
  floatSource?: string;
}): Promise<Shift> {
  const code = `S${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString(36).slice(-4)}`;
  const doc = await db.createDocument(DB_ID, 'shifts', ID.unique(), {
    venue_id: opts.venueId,
    code,
    status: 'open',
    opened_by: opts.userId,
    opened_at: new Date().toISOString(),
    opening_floats: JSON.stringify(opts.floats),
    float_source: opts.floatSource ?? 'zero',
    sales_total: 0, expense_total: 0, tax_total: 0, tip_total: 0, discount_total: 0,
    void_total: 0, refund_total: 0, cogs_total: 0, covers: 0,
    stock_check_status: 'pending', posted_to_ledger: false,
  });
  return doc as unknown as Shift;
}

export async function loadOpenShift(venueId: string): Promise<Shift | null> {
  const res = await db.listDocuments(DB_ID, 'shifts', [
    Query.equal('venue_id', venueId),
    Query.equal('status', 'open'),
    Query.limit(1),
  ]);
  return (res.documents[0] as unknown as Shift) ?? null;
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
export async function shiftBlockers(venueId: string, _shiftId?: string): Promise<ShiftBlocker[]> {
  // Every live order for the venue, not only those stamped with this shift.
  //
  // That distinction is what let a shift close over an unpaid order: a
  // customer ordering from their phone has no shift to be stamped with — the
  // menu does not know one is open — so `shift_id` is blank and a query by
  // shift never saw it. The question is not "which orders belong to this
  // shift", it is "is anything still owed or still on the pass".
  const orders = await listAll<Order>('orders', [Query.equal('venue_id', venueId)]);
  const blockers: ShiftBlocker[] = [];
  for (const o of orders) {
    // A pre-order for tomorrow is not this shift's problem.
    if (['CANCELLED', 'REJECTED', 'CLOSED', 'SCHEDULED'].includes(o.status)) continue;
    if (o.payment_status !== 'paid') blockers.push({ order: o, reason: 'unpaid' });
    else if (o.status !== 'SERVED') blockers.push({ order: o, reason: 'uncollected' });
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
  salesTotal: number;
  tipsTotal: number;
  payments: ShiftPayment[];
}

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
    listAll<{ amount: number; paid_from_method_id: string }>('shift_expenses', [
      Query.equal('shift_id', shift.$id),
    ]),
  ]);

  const openingFloats: Record<string, number> = JSON.parse(shift.opening_floats || '{}');
  const takenByMethod: Record<string, number> = {};
  let salesTotal = 0;
  let tipsTotal = 0;
  for (const p of payments) {
    takenByMethod[p.method_id] = (takenByMethod[p.method_id] ?? 0) + p.amount + (p.tip ?? 0);
    salesTotal += p.amount;
    tipsTotal += p.tip ?? 0;
  }

  const byMethod: Record<string, number> = {};
  let cashExpenses = 0;
  for (const m of methods) {
    // Money paid out of a drawer is money that drawer no longer holds. Leaving
    // this out is the single most common source of a phantom shortage.
    const paidOut = expenses
      .filter((e) => e.paid_from_method_id === m.$id)
      .reduce((a, e) => a + e.amount, 0);
    if (m.kind === 'cash') cashExpenses += paidOut;
    byMethod[m.$id] = (openingFloats[m.$id] ?? 0) + (takenByMethod[m.$id] ?? 0) - paidOut;
  }

  return { byMethod, openingFloats, takenByMethod, cashExpenses, salesTotal, tipsTotal, payments };
}

export interface CloseShiftResult {
  variance: Record<string, number>;
  totalOff: number;
  cogs: number;
  stockNote: string;
  ledgerError: string | null;
}

/**
 * Close the shift.
 *
 * Order matters here. The stock and the money are settled first, then the
 * shift is written closed, then the ledger is posted — so a failure in the
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
    const [ingredients, recipes] = await Promise.all([loadIngredients(venueId), loadRecipes()]);
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
      const theoretical = Number((ing.current_qty - (usage[ingredientId] ?? 0)).toFixed(4));
      const countedQty = stockCounts[ingredientId];
      const wasCounted = typeof countedQty === 'number' && Number.isFinite(countedQty);

      // The gap between what the recipes say should be left and what is
      // actually on the shelf. This is the number the whole stock system exists
      // to produce — it is where over-portioning, waste and theft show up — and
      // it can only be worked out when somebody has counted. A tapped level
      // cannot produce it, which is the real argument for counting.
      const varianceQty = wasCounted ? Number((countedQty - theoretical).toFixed(4)) : 0;

      await db.createDocument(DB_ID, 'shift_stock_checks', ID.unique(), {
        venue_id: venueId,
        shift_id: shift.$id,
        ingredient_id: ingredientId,
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
      // says — trust the eyes.
      if (wasCounted) {
        await db.updateDocument(DB_ID, 'ingredients', ingredientId, { current_qty: countedQty }).catch(() => undefined);
      } else if (level === 'OUT') {
        await db.updateDocument(DB_ID, 'ingredients', ingredientId, { current_qty: 0 }).catch(() => undefined);
      }
    }

    const after = await loadIngredients(venueId);
    const threshold = featureConfig(features, 'shift_summary', 'persistent_stock_threshold', 3);
    const { fresh, persistent } = await updateStockAlerts(
      after.filter((i) => i.active),
      settings.low_stock_default_bp ?? 3000,
      threshold,
    );
    if (fresh.length || persistent.length) {
      stockNote =
        `${fresh.length} newly low, ${persistent.length} low for ${threshold}+ shifts` +
        (persistent.length ? `: ${persistent.map((p) => p.ingredient.name).slice(0, 4).join(', ')}` : '');
    }
  }

  const totalOff = Object.values(variance).reduce((a, b) => a + b, 0);
  const shiftExpenses = await listAll<{ amount: number; category_key?: string; category?: string }>(
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
      expenses: shiftExpenses.map((e) => ({ amount: e.amount, accountCode: accountForExpense(e) })),
    });
    await db.updateDocument(DB_ID, 'shifts', shift.$id, { posted_to_ledger: true });
  } catch (e) {
    ledgerError = e instanceof Error ? e.message : 'unknown';
  }

  return { variance, totalOff, cogs, stockNote, ledgerError };
}
