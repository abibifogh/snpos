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
 * Triggered on order creation.
 */
export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const db = new Databases(client);
  const DB_ID = process.env.DB_ID || 'snpos';

  const order = req.bodyJson ?? (req.body ? JSON.parse(req.body) : null);
  if (!order?.$id) return res.json({ ok: true, skipped: 'no order' });

  try {
    const settings = await db.getDocument(DB_ID, 'settings', 'main');

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
    const corrections = [];

    for (const item of items.documents) {
      if (item.status === 'void') continue;

      const menuItem = await db.getDocument(DB_ID, 'menu_items', item.menu_item_id).catch(() => null);
      if (!menuItem) {
        corrections.push(`${item.name_snapshot}: no longer on the menu`);
        continue;
      }

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
    const redemptions = await db.listDocuments(DB_ID, 'discount_redemptions', [
      Query.equal('order_id', order.$id),
      Query.limit(10),
    ]);
    const allowedDiscount = redemptions.documents
      .filter((r) => r.status === 'applied')
      .reduce((sum, r) => sum + r.amount, 0);

    const discount = Math.min(order.discount_total || 0, allowedDiscount, subtotal);
    if ((order.discount_total || 0) > allowedDiscount) {
      corrections.push(`discount: claimed ${order.discount_total}, allowed ${allowedDiscount}`);
    }

    const discounted = subtotal - discount;
    const service = Math.round((discounted * (settings.service_charge_bp || 0)) / 10000);
    const taxable = discounted + service;
    const rate = settings.tax_rate_bp || 0;
    const tax = settings.tax_inclusive
      ? Math.round(taxable - (taxable * 10000) / (10000 + rate))
      : Math.round((taxable * rate) / 10000);
    const total = settings.tax_inclusive ? taxable : taxable + tax;

    if (
      corrections.length ||
      order.subtotal !== subtotal ||
      order.total !== total ||
      order.tax_total !== tax ||
      order.service_total !== service
    ) {
      await db.updateDocument(DB_ID, 'orders', order.$id, {
        subtotal,
        discount_total: discount,
        service_total: service,
        tax_total: tax,
        total,
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
