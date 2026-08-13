import { Query } from 'node-appwrite';
import {
  authorised, readRange, readLimit, readModule, summarise,
  shapeOrder, shapeOrderItem, shapePayment, shapeExpense, shapeShift,
  shapeProduct, shapeConsignor, shapeLedger, shapeIntake, shapeMove,
} from './report-shape.js';

/**
 * A read-only door onto this system's records, for something else to analyse.
 *
 * It lives inside the notify function rather than in a function of its own for
 * the same reason the hourly sweep does: the plan allows four functions and
 * this project has four. It is the only part of this codebase that answers to
 * the outside world, so three things are true of it by construction.
 *
 * It never writes. Every handler reads and returns; there is no code path here
 * that creates, updates or deletes anything, which is not a rule somebody has
 * to remember, it is the whole file.
 *
 * It never serves without a key. The key is an environment variable an owner
 * sets; unset means every request is refused, because a reporting endpoint
 * that is open by default is a copy of the business's takings on the public
 * internet.
 *
 * It never sends personal contact details. See report-shape.js.
 */

/** Resources that are a window of time, and how to read each one. */
const TIMED = {
  orders: { collection: 'orders', shape: shapeOrder, dateField: '$createdAt', module: true },
  payments: { collection: 'payments', shape: shapePayment, dateField: '$createdAt' },
  expenses: { collection: 'shift_expenses', shape: shapeExpense, dateField: '$createdAt', module: true },
  shifts: { collection: 'shifts', shape: shapeShift, dateField: 'opened_at', module: true },
  ledger: { collection: 'consignor_ledger', shape: shapeLedger, dateField: 'entry_at' },
  intakes: { collection: 'consignment_intakes', shape: shapeIntake, dateField: 'received_at' },
  movements: { collection: 'product_moves', shape: shapeMove, dateField: '$createdAt' },
};

/** Resources that are a list of what exists now, with no window. */
const LISTS = {
  products: { collection: 'menu_items', shape: shapeProduct, module: true },
  consignors: { collection: 'consignors', shape: shapeConsignor },
  categories: {
    collection: 'categories',
    module: true,
    shape: (c) => ({
      id: c.$id,
      name: String(c.name ?? ''),
      module: String(c.module ?? '') || 'kitchen',
      active: c.active !== false,
      sort: Number(c.sort ?? 0),
    }),
  },
  venues: {
    collection: 'venues',
    shape: (v) => ({ id: v.$id, name: String(v.name ?? ''), active: v.active !== false }),
  },
  payment_methods: {
    collection: 'payment_methods',
    shape: (m) => ({
      id: m.$id,
      venue_id: String(m.venue_id ?? ''),
      name: String(m.name ?? ''),
      kind: String(m.kind ?? ''),
      enabled: m.enabled !== false,
    }),
  },
  staff: {
    // Names and roles, so a report can say who took a payment. No PIN hash, no
    // email, no phone: this is a label for an id, not a staff directory.
    collection: 'staff_profiles',
    shape: (s) => ({
      id: s.$id,
      user_id: String(s.user_id ?? ''),
      name: String(s.display_name ?? ''),
      role: String(s.role ?? ''),
      active: s.active !== false,
    }),
  },
};

/** One page of a collection, oldest first so paging is stable. */
async function page({ db, DB_ID, collection, queries, limit, cursor }) {
  const all = [...queries, Query.limit(limit), Query.orderAsc('$id')];
  if (cursor) all.push(Query.cursorAfter(cursor));
  const res = await db.listDocuments(DB_ID, collection, all);
  return res.documents ?? [];
}

/** Everything matching, in pages, up to a ceiling that protects the function. */
async function everything({ db, DB_ID, collection, queries, cap = 5000 }) {
  const out = [];
  let cursor = null;
  while (out.length < cap) {
    const rows = await page({ db, DB_ID, collection, queries, limit: 100, cursor });
    out.push(...rows);
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1].$id;
  }
  return out;
}

const json = (res, body, status = 200) => res.json(body, status);

/**
 * Answer one request.
 *
 * Returns null when the request is not for this API at all, so the caller can
 * carry on with whatever else it does. Anything else it returns has already
 * been sent.
 */
export async function handleReports({ req, res, db, DB_ID, log, error }) {
  const path = String(req.path || '/').replace(/\/+$/, '') || '/';
  if (!path.startsWith('/reports')) return null;

  const secret = process.env.REPORTS_API_KEY || '';
  if (!secret) {
    error('A reporting request arrived but REPORTS_API_KEY is not set.');
    return json(res, {
      ok: false,
      error: 'The reporting API is switched off. An owner has to set REPORTS_API_KEY on the notify function.',
    }, 503);
  }

  const header = req.headers?.authorization || req.headers?.Authorization || '';
  if (!authorised(header, secret)) {
    // Deliberately says nothing about why. "Wrong key" and "no key" are the
    // same answer to somebody who should not be here.
    return json(res, { ok: false, error: 'Not authorised.' }, 401);
  }

  if (req.method && req.method.toUpperCase() !== 'GET') {
    return json(res, { ok: false, error: 'This API only reads. Use GET.' }, 405);
  }

  const query = req.query ?? {};
  const settings = await db.getDocument(DB_ID, 'settings', 'main').catch(() => ({}));
  const currency = {
    code: settings.currency_code || 'GHS',
    symbol: settings.currency_symbol || '',
    decimals: settings.currency_decimals ?? 2,
    note: 'Every money figure is a whole number in minor units. Divide by 10^decimals to display.',
  };
  const venueId = String(query.venue_id || '').trim();
  const module = readModule(query.module);
  const resource = path.replace('/reports', '').replace(/^\//, '');

  const envelope = (body) => json(res, { ok: true, currency, ...body });

  try {
    /* ---------------------------------------------------------- the index */
    if (resource === '') {
      return envelope({
        resource: 'index',
        timed: Object.keys(TIMED),
        lists: Object.keys(LISTS),
        summary: '/reports/summary',
        parameters: {
          from: 'YYYY-MM-DD or a full timestamp. Defaults to 30 days before "to".',
          to: 'YYYY-MM-DD or a full timestamp. A plain date means the whole of that day. Defaults to now.',
          module: 'kitchen or craft. Omit for both.',
          venue_id: 'Limit to one venue. Omit for all.',
          limit: '1 to 500, default 100. Timed and list resources only.',
          cursor: 'The next_cursor from the previous page.',
        },
        auth: 'Authorization: Bearer <REPORTS_API_KEY>',
      });
    }

    /* --------------------------------------------------------- the totals */
    if (resource === 'summary') {
      const { from, to } = readRange(query);
      const scope = venueId ? [Query.equal('venue_id', venueId)] : [];
      const window = [Query.greaterThanEqual('$createdAt', from), Query.lessThanEqual('$createdAt', to)];

      const [orders, payments, expenses] = await Promise.all([
        everything({ db, DB_ID, collection: 'orders', queries: [...scope, ...window] }),
        everything({ db, DB_ID, collection: 'payments', queries: [...scope, ...window] }),
        everything({ db, DB_ID, collection: 'shift_expenses', queries: [...scope, ...window] }),
      ]);

      // The module filter is applied after reading rather than in the query,
      // for the same reason it is everywhere else in this system: rows written
      // before the column existed carry no module at all, and a database
      // filter steps straight over them.
      const mine = (rows) => (module ? rows.filter((r) => (r.module || 'kitchen') === module) : rows);
      const shapedOrders = mine(orders).map(shapeOrder);
      const orderIds = new Set(shapedOrders.map((o) => o.id));
      const shapedPayments = payments
        .map(shapePayment)
        .filter((p) => !module || orderIds.has(p.order_id));

      return envelope({
        resource: 'summary',
        range: { from, to },
        module: module ?? 'all',
        venue_id: venueId || 'all',
        data: summarise({
          orders: shapedOrders,
          payments: shapedPayments,
          expenses: mine(expenses).map(shapeExpense),
        }),
      });
    }

    /* ------------------------------------------------- one order's detail */
    //
    // By order id, because "what was actually on ticket 41" is the question a
    // line-level analysis starts from and paging every item in the business to
    // answer it would be absurd.
    if (resource.startsWith('order-items')) {
      const orderId = String(query.order_id || '').trim();
      if (orderId) {
        const rows = await everything({
          db, DB_ID, collection: 'order_items', queries: [Query.equal('order_id', orderId)],
        });
        return envelope({ resource: 'order-items', order_id: orderId, count: rows.length, data: rows.map(shapeOrderItem) });
      }

      // Otherwise, everything sold in the window, found through its orders.
      const { from, to } = readRange(query);
      const scope = venueId ? [Query.equal('venue_id', venueId)] : [];
      const orders = await everything({
        db,
        DB_ID,
        collection: 'orders',
        queries: [...scope, Query.greaterThanEqual('$createdAt', from), Query.lessThanEqual('$createdAt', to)],
      });
      const wanted = orders.filter((o) => !module || (o.module || 'kitchen') === module);
      const ids = wanted.map((o) => o.$id);

      const items = [];
      // Appwrite takes a bounded list per query, so the ids go in batches.
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        if (batch.length === 0) break;
        items.push(...await everything({
          db, DB_ID, collection: 'order_items', queries: [Query.equal('order_id', batch)],
        }));
      }
      return envelope({
        resource: 'order-items',
        range: { from, to },
        module: module ?? 'all',
        count: items.length,
        data: items.map(shapeOrderItem),
      });
    }

    /* ------------------------------------------------------ a time window */
    if (TIMED[resource]) {
      const spec = TIMED[resource];
      const { from, to } = readRange(query);
      const limit = readLimit(query.limit);
      const queries = [
        ...(venueId ? [Query.equal('venue_id', venueId)] : []),
        Query.greaterThanEqual(spec.dateField, from),
        Query.lessThanEqual(spec.dateField, to),
      ];

      const rows = await page({
        db, DB_ID, collection: spec.collection, queries, limit, cursor: String(query.cursor || '') || null,
      });
      const kept = spec.module && module ? rows.filter((r) => (r.module || 'kitchen') === module) : rows;

      return envelope({
        resource,
        range: { from, to },
        module: module ?? 'all',
        count: kept.length,
        // The cursor follows the page that was READ, not the page that
        // survived the module filter, or a filtered page ending in somebody
        // else's rows would silently stop the walk early.
        next_cursor: rows.length === limit ? rows[rows.length - 1].$id : null,
        data: kept.map(spec.shape),
      });
    }

    /* ----------------------------------------------------- a plain list */
    if (LISTS[resource]) {
      const spec = LISTS[resource];
      const limit = readLimit(query.limit);
      const queries = venueId && spec.collection !== 'consignors' ? [Query.equal('venue_id', venueId)] : [];
      const rows = await page({
        db, DB_ID, collection: spec.collection, queries, limit, cursor: String(query.cursor || '') || null,
      });
      const kept = spec.module && module ? rows.filter((r) => (r.module || 'kitchen') === module) : rows;

      return envelope({
        resource,
        count: kept.length,
        next_cursor: rows.length === limit ? rows[rows.length - 1].$id : null,
        data: kept.map(spec.shape),
      });
    }

    return json(res, {
      ok: false,
      error: `No such report: "${resource}". Ask /reports for the list.`,
    }, 404);
  } catch (e) {
    error(`Report "${resource}" failed: ${e.message}`);
    return json(res, { ok: false, error: 'That report could not be produced.' }, 500);
  }
}
