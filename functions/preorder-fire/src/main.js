import { Client, Databases, Query } from 'node-appwrite';

/**
 * Releases pre-orders to the kitchen at their fire time.
 *
 * This is the reason the function exists rather than living in the apps: a
 * pre-order placed at 11pm for tomorrow's lunch must reach the kitchen whether
 * or not anyone has a browser tab open. Nothing on a screen can be relied on
 * to still be running. (They do step in when this has not run: any open till
 * or kitchen screen releases a pre-order two minutes past its time. See
 * packages/core/src/preorders.ts.)
 *
 * Each order on its own. One that could not be saved used to stop the whole
 * run, and because it came first again the next minute, every pre-order
 * behind it waited for ever with nobody told.
 *
 * Stamps fired_at, which is where the kitchen's clock and alarm start: from
 * when the order reached the kitchen, not from when it was placed.
 *
 * Runs every minute.
 */
export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const db = new Databases(client);
  const DB_ID = process.env.DB_ID || 'snpos';
  const now = new Date().toISOString();

  let due;
  try {
    due = await db.listDocuments(DB_ID, 'orders', [
      Query.equal('status', 'SCHEDULED'),
      Query.lessThanEqual('fire_at', now),
      Query.orderAsc('fire_at'),
      Query.limit(50),
    ]);
  } catch (e) {
    error(`preorder-fire could not read what is due: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }

  let fired = 0;
  const failed = [];
  for (const order of due.documents) {
    try {
      // Re-check availability: something may have sold out overnight, and a
      // ticket the kitchen cannot cook is worse than a phone call now.
      const unavailable = [];
      try {
        const items = await db.listDocuments(DB_ID, 'order_items', [
          Query.equal('order_id', order.$id),
          Query.limit(100),
        ]);
        for (const item of items.documents) {
          const menuItem = await db.getDocument(DB_ID, 'menu_items', item.menu_item_id).catch(() => null);
          if (!menuItem || !menuItem.active) unavailable.push(item.name_snapshot);
          else if (menuItem.sold_out_until && new Date(menuItem.sold_out_until) > new Date()) {
            unavailable.push(item.name_snapshot);
          }
        }
      } catch (e) {
        error(`Could not check availability for ${order.order_no}: ${e.message}`);
      }

      const patch = { status: 'PENDING', alert_level: 0, fired_at: new Date().toISOString(), released_by: 'server' };
      if (unavailable.length) {
        // Do NOT silently fail it. Put it in front of staff so somebody rings
        // the customer.
        patch.notes = `${order.notes || ''}\nUNAVAILABLE AT FIRE TIME: ${unavailable.join(', ')}, call the customer.`.trim();
      }
      try {
        await db.updateDocument(DB_ID, 'orders', order.$id, patch);
      } catch (e) {
        // A database not yet given released_by: release it without the label
        // rather than not at all.
        if (!/released_by/i.test(e.message)) throw e;
        delete patch.released_by;
        await db.updateDocument(DB_ID, 'orders', order.$id, patch);
      }
      log(`Fired ${order.order_no}${unavailable.length ? ` with unavailable items: ${unavailable.join(', ')}` : ''}`);
      fired++;
    } catch (e) {
      failed.push(order.order_no);
      error(`Could not release ${order.order_no}: ${e.message}`);
    }
  }

  return res.json({ ok: failed.length === 0, fired, failed, checked: due.total });
};
