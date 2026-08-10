import { Client, Databases, Query } from 'node-appwrite';

/**
 * Re-prices every new order against the database.
 *
 * Customers write their own orders — they have to, since a guest who has only
 * scanned a sticker has no staff member to write it for them. That means the
 * prices arrive from a phone, and anything a phone sends can be edited by
 * whoever owns the phone.
 *
 * So the totals are recomputed here from the menu, the add-ons and the
 * settings. If they match, nothing happens. If they do not, the order is
 * corrected to the real price and the discrepancy is written to the audit log,
 * because an attempt to pay less than the menu price is worth knowing about
 * even after it has been stopped.
 *
 * Triggered on order creation, and on a discount redemption being recorded.
 */

/**
 * Service, tax and the total, from a subtotal and a discount.
 *
 * One copy, used by the re-pricing on a new order and by the re-pricing after
 * a voucher is refused. Two copies of tax arithmetic is two answers to the
 * same question, and the one that is wrong is always the one nobody looks at.
 */
function totalsFor(subtotal, discount, settings) {
  const discounted = subtotal - discount;
  const service = Math.round((discounted * (settings.service_charge_bp || 0)) / 10000);
  const taxable = discounted + service;
  const rate = settings.tax_rate_bp || 0;
  const tax = settings.tax_inclusive
    ? Math.round(taxable - (taxable * 10000) / (10000 + rate))
    : Math.round((taxable * rate) / 10000);
  return { service, tax, total: settings.tax_inclusive ? taxable : taxable + tax };
}

/**
 * Put an order back to what it should cost.
 *
 * Called when a voucher is refused after the fact. Recomputed from the items
 * and whatever redemptions survived rather than by subtracting the discount
 * back off, because the service charge and the tax were worked out on the
 * discounted figure too.
 */
async function reprice({ db, DB_ID, orderId, settings }) {
  const [order, items, redemptions] = await Promise.all([
    db.getDocument(DB_ID, 'orders', orderId),
    db.listDocuments(DB_ID, 'order_items', [Query.equal('order_id', orderId), Query.limit(100)]),
    db.listDocuments(DB_ID, 'discount_redemptions', [Query.equal('order_id', orderId), Query.limit(10)]),
  ]);

  // A bill already settled is not re-priced. Changing what somebody paid after
  // they paid it is worse than the discount they should not have had.
  if (order.payment_status === 'paid') return { skipped: 'already paid' };

  const subtotal = items.documents
    .filter((i) => i.status !== 'void')
    .reduce((sum, i) => sum + (i.line_total || 0), 0);
  const discount = redemptions.documents
    .filter((r) => r.status === 'applied')
    .reduce((sum, r) => sum + r.amount, 0);

  const { service, tax, total } = totalsFor(subtotal, Math.min(discount, subtotal), settings);
  await db.updateDocument(DB_ID, 'orders', orderId, {
    subtotal,
    discount_total: Math.min(discount, subtotal),
    service_total: service,
    tax_total: tax,
    total,
  });
  return { subtotal, total };
}

/**
 * Decide whether a voucher was actually allowed to be used, and count it.
 *
 * Runs on the redemption's own creation, which is the only moment the row is
 * guaranteed to exist. Everything about a voucher that can run out — the dates,
 * the switch, the number of uses — is decided here and nowhere else, so there
 * is exactly one place the count is kept and exactly one place it is checked.
 *
 * The customer's phone checks the same things before letting a code be typed,
 * but that is a courtesy: a client check cannot stop two people using the last
 * one at the same instant, and it cannot stop anybody who does not want to be
 * stopped.
 */
async function redeem({ db, DB_ID, doc, settings, log, error }) {
  if (doc.status !== 'applied') return { ok: true, skipped: 'not an applied redemption' };

  const voucher = await db.getDocument(DB_ID, 'discounts', doc.discount_id).catch(() => null);
  const now = new Date();
  const spent = voucher?.used_count || 0;
  const cap = voucher?.usage_limit_total;

  const refuse =
    !voucher ? 'no longer exists'
    : voucher.active === false ? 'switched off'
    : voucher.starts_at && new Date(voucher.starts_at) > now ? 'has not started'
    : voucher.ends_at && new Date(voucher.ends_at) < now ? 'expired'
    : cap && spent >= cap ? `used up (${spent} of ${cap})`
    : null;

  if (refuse) {
    await db.updateDocument(DB_ID, 'discount_redemptions', doc.$id, {
      status: 'reversed',
      reverse_reason: `Refused automatically: voucher ${refuse}`,
    }).catch(() => undefined);

    // The order was priced as though the discount applied, so put it back.
    // Re-priced from the order rather than by subtracting, because the tax and
    // service on a smaller subtotal were wrong too.
    await reprice({ db, DB_ID, orderId: doc.order_id, settings }).catch((e) =>
      error(`Could not re-price ${doc.order_id} after refusing a voucher: ${e.message}`),
    );

    await db.createDocument(DB_ID, 'audit_log', 'unique()', {
      venue_id: doc.venue_id,
      actor_id: doc.applied_by || 'guest',
      actor_role: doc.applied_by ? 'staff' : 'guest',
      action: 'voucher_refused',
      entity_type: 'discount_redemptions',
      entity_id: doc.$id,
      after: JSON.stringify({ code: doc.code_snapshot, amount: doc.amount, refuse }).slice(0, 3900),
      reason: `Voucher ${refuse}`,
    }).catch(() => undefined);

    log(`Refused ${doc.code_snapshot || doc.discount_id}: ${refuse}`);
    return { ok: true, refused: refuse };
  }

  // Counted only once it has been allowed, so a refused attempt never uses up
  // somebody else's turn.
  const used = spent + 1;
  await db.updateDocument(DB_ID, 'discounts', voucher.$id, { used_count: used });

  // A voucher that has just reached its limit is switched off, so it stops
  // being offered and stops being typed. The count already prevents it being
  // honoured; this is so the admin list shows the truth at a glance.
  if (cap && used >= cap) {
    await db.updateDocument(DB_ID, 'discounts', voucher.$id, { active: false }).catch(() => undefined);
    log(`${voucher.code || voucher.name} has reached its limit of ${cap} and is now off`);
  }

  log(`${voucher.code || voucher.name} used ${used}${cap ? ` of ${cap}` : ''}`);
  return { ok: true, used, cap: cap || null };
}

/**
 * Credit every consignor whose work was on a bill that has just been settled.
 *
 * On payment, not on the sale. An order that is cancelled, voided or walked out
 * on owes nobody anything, and a credit written at the till and reversed later
 * is two lines on somebody's statement where there should be none.
 *
 * Server-side, and only server-side. The ledger collection is created by
 * nobody: a credit a till could type is not a record of anything, and this is
 * the number a maker is paid from. It is also the only place with a guaranteed
 * view of every payment against the bill, which is what "fully paid" means when
 * a bill can be split three ways.
 *
 * Safe to run twice — `order_item_id` carries a unique index, so a payment
 * retried on a bad connection collides instead of paying somebody twice.
 */
async function creditConsignors({ db, DB_ID, payment, log }) {
  const order = await db.getDocument(DB_ID, 'orders', payment.order_id).catch(() => null);
  if (!order) return { skipped: 'no order' };

  // Everything taken against this bill, however many goes it took. Read back
  // rather than trusting the payment that triggered this: a part payment must
  // not credit anybody, and the row that completes a split is not special.
  const paid = await db.listDocuments(DB_ID, 'payments', [
    Query.equal('order_id', order.$id), Query.limit(100),
  ]).catch(() => ({ documents: [] }));
  const taken = paid.documents
    .filter((p) => p.status !== 'voided' && p.status !== 'refunded')
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  if (taken < (order.total || 0)) return { skipped: 'not settled yet' };

  const items = await db.listDocuments(DB_ID, 'order_items', [
    Query.equal('order_id', order.$id), Query.limit(100),
  ]);
  const mine = items.documents.filter((i) => i.status !== 'void' && i.consignor_id);
  if (mine.length === 0) return { skipped: 'nothing on consignment' };

  const settings = await db.getDocument(DB_ID, 'settings', 'main').catch(() => ({}));
  const at = new Date().toISOString();
  let credited = 0;

  for (const line of mine) {
    const consignor = await db.getDocument(DB_ID, 'consignors', line.consignor_id).catch(() => null);

    // Most specific rate wins: the piece, then the maker, then the shop's
    // default. Mirrors rateFor() in packages/core/src/consignment.ts.
    const bp = [line.commission_bp, consignor?.commission_bp, settings.default_commission_bp]
      .find((v) => typeof v === 'number' && v >= 0) ?? 3000;
    const rate = Math.max(0, Math.min(10000, Math.round(bp)));

    const gross = line.line_total || 0;
    // The shop's share is rounded and the maker gets the remainder. Rounding
    // both independently does not have to add back up to what the customer
    // paid, and the pesewa always went the same way.
    const commission = Math.round((gross * rate) / 10000);

    try {
      await db.createDocument(DB_ID, 'consignor_ledger', 'unique()', {
        venue_id: order.venue_id,
        consignor_id: line.consignor_id,
        entry_at: at,
        kind: 'sale',
        amount: gross - commission,
        description: `${line.name_snapshot}${line.variant_label ? ` · ${line.variant_label}` : ''}`,
        order_id: order.$id,
        order_item_id: line.$id,
        menu_item_id: line.menu_item_id,
        variant_label: line.variant_label || '',
        qty: line.qty,
        gross,
        commission,
        commission_bp: rate,
        created_by: payment.taken_by || '',
      });
      credited++;
    } catch (e) {
      // Already credited. The unique index did its job; carry on rather than
      // failing a sale that has already been paid for.
      if (!/already exists|unique/i.test(e.message || '')) throw e;
    }
  }

  if (credited) log(`Credited ${credited} consignment line(s) on ${order.order_no}`);
  return { ok: true, credited };
}

/** How long after sending an order a customer may still call it back. */
const CANCEL_WINDOW_MS = 2 * 60 * 1000;

/**
 * Honour a cancellation request, or say why not.
 *
 * Two things can close the window, and both are checked here rather than in the
 * browser, because a clock on a phone is whatever its owner sets it to.
 *
 * The first is time. The second is the kitchen: once a cook has taken the
 * ticket, the food may already be on. The request is refused then even if the
 * two minutes have not run out, because the alternative is a customer cancelling
 * a dish that is halfway cooked and a kitchen finding out by reading a screen.
 * A guest in that position can still ask staff — a person can weigh whether the
 * pan has gone on, which is precisely the judgement this cannot make.
 *
 * The row is always updated, never deleted. Somebody asking tomorrow why the
 * food they thought they had called off still arrived deserves an answer.
 */
async function cancelForCustomer({ db, DB_ID, doc, log }) {
  const settle = (status, refused_reason) =>
    db.updateDocument(DB_ID, 'order_cancellations', doc.$id, {
      status,
      ...(refused_reason ? { refused_reason } : {}),
    }).catch(() => undefined);

  const order = await db.getDocument(DB_ID, 'orders', doc.order_id).catch(() => null);
  if (!order) {
    await settle('refused', 'That order could not be found.');
    return { ok: true, refused: 'no such order' };
  }

  if (['CANCELLED', 'REJECTED'].includes(order.status)) {
    // Already off. Not a refusal — they got what they asked for.
    await settle('cancelled');
    return { ok: true, already: true };
  }

  const age = Date.now() - Date.parse(order.$createdAt);
  if (!(age <= CANCEL_WINDOW_MS)) {
    await settle('refused', 'The two minutes to cancel have passed. Please speak to a member of staff.');
    return { ok: true, refused: 'window closed' };
  }

  if (order.status !== 'PENDING' || order.accepted_at) {
    await settle('refused', 'The kitchen has already started this order. Please speak to a member of staff.');
    return { ok: true, refused: 'kitchen started' };
  }

  if (order.payment_status === 'paid' || order.payment_status === 'partial') {
    await settle('refused', 'This order has already been paid for. Please speak to a member of staff.');
    return { ok: true, refused: 'already paid' };
  }

  await db.updateDocument(DB_ID, 'orders', order.$id, {
    status: 'CANCELLED',
    rejected_at: new Date().toISOString(),
    reject_reason_code: 'customer_request',
    reject_reason_note: 'Cancelled by the customer within two minutes of ordering.',
  });
  await settle('cancelled');

  log(`${order.order_no} cancelled by the customer after ${Math.round(age / 1000)}s`);
  return { ok: true, cancelled: order.order_no };
}

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const db = new Databases(client);
  const DB_ID = process.env.DB_ID || 'snpos';

  const doc = req.bodyJson ?? (req.body ? JSON.parse(req.body) : null);
  if (!doc?.$id) return res.json({ ok: true, skipped: 'nothing sent' });

  const events = (req.headers['x-appwrite-event'] || '').split(',').filter(Boolean);

  // ------------------------------------------------------ voucher redeemed
  //
  // Triggered by the redemption row itself, not by the order.
  //
  // It used to be done on the order's own event, and that was a race it lost
  // more often than it won: the browser writes the order first and the
  // redemption a moment later, so this function ran, found no redemption, and
  // moved on — which is why a code with five uses could be typed for ever and
  // the count never moved. The row exists by definition when its own creation
  // is the trigger.
  if (events.some((e) => e.includes('collections.discount_redemptions'))) {
    try {
      const settings = await db.getDocument(DB_ID, 'settings', 'main');
      return res.json(await redeem({ db, DB_ID, doc, settings, log, error }));
    } catch (e) {
      error(`Redemption check failed for ${doc.$id}: ${e.message}`);
      return res.json({ ok: false, error: e.message }, 500);
    }
  }

  // --------------------------------------------------------- a bill settled
  if (events.some((e) => e.includes('collections.payments'))) {
    try {
      return res.json(await creditConsignors({ db, DB_ID, payment: doc, log }));
    } catch (e) {
      error(`Consignor credit failed for payment ${doc.$id}: ${e.message}`);
      return res.json({ ok: false, error: e.message }, 500);
    }
  }

  // ------------------------------------------------------ customer cancelled
  //
  // The guest asked; the server decides. The window is short on purpose: a
  // couple of minutes covers the ordinary "wrong thing, sent too fast" and
  // stops short of food that has been started.
  if (events.some((e) => e.includes('collections.order_cancellations'))) {
    try {
      return res.json(await cancelForCustomer({ db, DB_ID, doc, log }));
    } catch (e) {
      error(`Cancellation failed for ${doc.$id}: ${e.message}`);
      return res.json({ ok: false, error: e.message }, 500);
    }
  }

  const order = doc;

  try {
    const settings = await db.getDocument(DB_ID, 'settings', 'main');

    // ------------------------------------------------ the real order number
    //
    // A guest cannot read the order list — that is the whole point of the
    // permissions on the collection — so they cannot work out what number
    // comes next. They send a placeholder starting with "~" and it is settled
    // here, where the server can see every order.
    //
    // Done first, before the re-pricing below, because a customer is staring
    // at a screen waiting for this number.
    //
    // The rule itself mirrors nextOrderNo() in packages/core/src/orders.ts.
    // Two copies because a browser bundle and a function bundle cannot share
    // one; if you change the numbering, change it in both.
    if ((order.order_no || '').startsWith('~')) {
      const prefix = settings.order_number_prefix || '';
      const padding = Math.max(1, settings.order_number_padding || 4);
      // A window rather than just the last order. Several placeholders can be
      // in flight at once on a busy night, and the newest row is quite likely
      // to be one of them — including this order itself.
      //
      // Filtering happens below rather than in the query on purpose:
      // `order_no` is only the second half of the composite unique index, so
      // Appwrite refuses to query it on its own. Asking anyway threw here,
      // killed the function, and left every order stuck on its placeholder —
      // which is exactly what "Order ~msciu67tsi36" was.
      const queries = [
        Query.equal('venue_id', order.venue_id),
        Query.orderDesc('$createdAt'),
        Query.limit(50),
      ];
      if (settings.order_number_mode === 'daily') {
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        queries.push(Query.greaterThanEqual('$createdAt', midnight.toISOString()));
      } else if (settings.order_number_reset_on) {
        queries.push(Query.greaterThanEqual('$createdAt', settings.order_number_reset_on));
      }
      const latest = await db.listDocuments(DB_ID, 'orders', queries);
      // Placeholders are not numbers; counting one as the last order would
      // send the next guest back to the start.
      const previous = latest.documents.filter(
        (d) => d.$id !== order.$id && !(d.order_no || '').startsWith('~'),
      );
      const last = previous[0]?.order_no || '';
      const digits = (prefix && last.startsWith(prefix) ? last.slice(prefix.length) : last).replace(/\D/g, '');
      let next = previous.length === 0
        ? Math.max(1, settings.order_number_next || 1)
        : (Number(digits) || 0) + 1;

      // Two guests ordering in the same second land on the same number. The
      // unique index on (venue_id, order_no) refuses the second, so take the
      // one after it rather than failing an order that is already paid for in
      // the customer's mind.
      let assigned = null;
      for (let i = 0; i < 25; i++) {
        const candidate = `${prefix}${String(next + i).padStart(padding, '0')}`;
        try {
          await db.updateDocument(DB_ID, 'orders', order.$id, { order_no: candidate });
          assigned = candidate;
          break;
        } catch (e) {
          if (!/already exists|unique/i.test(e.message || '')) throw e;
        }
      }
      if (assigned) {
        order.order_no = assigned;
        log(`Numbered ${order.$id} as ${assigned}`);
      } else {
        error(`Could not find a free order number for ${order.$id}; it keeps its placeholder`);
      }
    }

    // Order items are written just after the order, so give them a moment
    // rather than judging an order that only looks empty.
    let items = { documents: [], total: 0 };
    for (let attempt = 0; attempt < 5; attempt++) {
      items = await db.listDocuments(DB_ID, 'order_items', [
        Query.equal('order_id', order.$id),
        Query.limit(100),
      ]);
      if (items.total > 0) break;
      await new Promise((r) => setTimeout(r, 700));
    }
    if (items.total === 0) return res.json({ ok: true, skipped: 'no items yet' });

    // Per-venue price overrides beat the base menu price.
    const overrides = await db.listDocuments(DB_ID, 'venue_menu_items', [
      Query.equal('venue_id', order.venue_id),
      Query.limit(500),
    ]);
    const overrideFor = new Map(overrides.documents.map((o) => [o.menu_item_id, o]));

    let subtotal = 0;
    let prepTotal = 0;
    const corrections = [];

    for (const item of items.documents) {
      if (item.status === 'void') continue;

      const menuItem = await db.getDocument(DB_ID, 'menu_items', item.menu_item_id).catch(() => null);
      if (!menuItem) {
        corrections.push(`${item.name_snapshot}: no longer on the menu`);
        continue;
      }

      // Counted once per line, not per portion: three of the same thing goes in
      // one pan, and multiplying produces a number nobody believes.
      prepTotal += menuItem.prep_minutes ?? 15;

      const base = overrideFor.get(item.menu_item_id)?.price_override ?? menuItem.price;

      // Add-ons are priced from the database too, not from what was sent.
      let addonTotal = 0;
      const addons = item.addons ? JSON.parse(item.addons) : [];
      for (const a of addons) {
        const option = await db.getDocument(DB_ID, 'addon_options', a.option_id).catch(() => null);
        addonTotal += option?.price_delta ?? 0;
      }

      const trueUnit = base + addonTotal;
      const trueLine = trueUnit * item.qty;

      if (trueLine !== item.line_total) {
        corrections.push(`${item.name_snapshot}: sent ${item.line_total}, actual ${trueLine}`);
        await db.updateDocument(DB_ID, 'order_items', item.$id, {
          unit_price: trueUnit,
          line_total: trueLine,
        });
      }
      subtotal += trueLine;
    }

    // Discounts are only honoured if a matching redemption exists.
    //
    // Given a moment to arrive when the order claims one: the browser writes
    // the order and its redemption as two calls, and stripping a legitimate
    // discount because the second had not landed yet would overcharge a
    // customer who did nothing wrong.
    //
    // Whether the voucher was still allowed to be used is decided on the
    // redemption's own event, not here — see redeem() below. This only totals
    // up what survived that check.
    let redemptions = { documents: [] };
    for (let attempt = 0; attempt < 5; attempt++) {
      redemptions = await db.listDocuments(DB_ID, 'discount_redemptions', [
        Query.equal('order_id', order.$id),
        Query.limit(10),
      ]);
      if (redemptions.total > 0 || !order.discount_total) break;
      await new Promise((r) => setTimeout(r, 600));
    }

    const allowedDiscount = redemptions.documents
      .filter((r) => r.status === 'applied')
      .reduce((sum, r) => sum + r.amount, 0);

    const discount = Math.min(order.discount_total || 0, allowedDiscount, subtotal);
    if ((order.discount_total || 0) > allowedDiscount) {
      corrections.push(`discount: claimed ${order.discount_total}, allowed ${allowedDiscount}`);
    }

    const { service, tax, total } = totalsFor(subtotal, discount, settings);

    /**
     * The wait, worked out where the queue is actually visible.
     *
     * The phone that placed the order quoted its own dishes and nothing else,
     * because a guest cannot read the kitchen's order list and should not be
     * able to. So the first number a customer sees is the cooking time alone,
     * and it is wrong on a busy night in the one direction that matters: a
     * fifteen-minute dish behind four other tickets is not fifteen minutes.
     *
     * Here the whole pass is readable, so the tickets ahead are added — what is
     * LEFT of each, not what it started as. Then the cap: nothing is ever quoted
     * past an hour, because past that the number stops being something a person
     * can decide on and starts being something they stop believing.
     *
     * Pre-orders are left alone. Somebody collecting at seven is not waiting in
     * tonight's queue.
     */
    let eta = order.eta_minutes;
    if (order.status !== 'SCHEDULED' && !order.is_preorder && prepTotal > 0) {
      const live = await db.listDocuments(DB_ID, 'orders', [
        Query.equal('venue_id', order.venue_id),
        Query.equal('status', ['PENDING', 'ACCEPTED', 'PREPARING']),
        Query.limit(200),
      ]).catch(() => ({ documents: [] }));

      const now = Date.now();
      let ahead = 0;
      for (const o of live.documents) {
        if (o.$id === order.$id) continue;
        // Cooking time, not the wait that order's own customer was quoted —
        // their quote already contains the queue that was ahead of them, and
        // adding up quotes counts the same stove time again for every ticket
        // that has joined since. What is left to cook is what is left to cook.
        const work = o.prep_minutes ?? o.eta_minutes ?? 15;
        // Nothing comes off a ticket no cook has picked up yet.
        const started = o.accepted_at ? Date.parse(o.accepted_at) : NaN;
        const elapsed = Number.isFinite(started) ? Math.max(0, (now - started) / 60000) : 0;
        ahead += Math.max(0, work - elapsed);
      }
      eta = Math.min(60, Math.max(1, Math.round(prepTotal + ahead)));
    }

    // The cooking time on its own, from the menu rather than from the phone.
    // This is what decides whether a ticket on the pass is late, so it is
    // settled here where the prep times cannot be edited by the sender.
    const cookTime = prepTotal > 0 ? Math.max(1, Math.round(prepTotal)) : order.prep_minutes;

    if (
      corrections.length ||
      order.subtotal !== subtotal ||
      order.total !== total ||
      order.tax_total !== tax ||
      order.service_total !== service ||
      order.eta_minutes !== eta ||
      order.prep_minutes !== cookTime
    ) {
      await db.updateDocument(DB_ID, 'orders', order.$id, {
        subtotal,
        discount_total: discount,
        service_total: service,
        tax_total: tax,
        total,
        ...(typeof eta === 'number' ? { eta_minutes: eta } : {}),
        ...(typeof cookTime === 'number' ? { prep_minutes: cookTime } : {}),
      });

      if (corrections.length) {
        await db.createDocument(DB_ID, 'audit_log', 'unique()', {
          venue_id: order.venue_id,
          actor_id: order.placed_by || 'guest',
          actor_role: order.channel === 'qr' ? 'guest' : 'staff',
          action: 'order_price_corrected',
          entity_type: 'order',
          entity_id: order.$id,
          after: JSON.stringify({ order_no: order.order_no, corrections }).slice(0, 3900),
        }).catch(() => undefined);
        log(`Corrected ${order.order_no}: ${corrections.join('; ')}`);
      }
    }

    return res.json({ ok: true, subtotal, total, corrections: corrections.length });
  } catch (e) {
    error(`order-guard failed for ${order.$id}: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
};
