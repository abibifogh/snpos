import { Client, Databases, Query } from 'node-appwrite';

/**
 * Releases pre-orders to the kitchen at their fire time.
 *
 * This is the reason the function exists rather than living in the apps: a
 * pre-order placed at 11pm for tomorrow's lunch must reach the kitchen whether
 * or not anyone has a browser tab open. Nothing on a screen can be relied on
 * to still be running.
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

  try {
    const due = await db.listDocuments(DB_ID, 'orders', [
      Query.equal('status', 'SCHEDULED'),
      Query.lessThanEqual('fire_at', now),
      Query.limit(50),
    ]);

    let fired = 0;
    for (const order of due.documents) {
      // Re-check availability: something may have sold out overnight, and a
      // ticket the kitchen cannot cook is worse than a phone call now.
      let unavailable = [];
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

      if (unavailable.length) {
        // Do NOT silently fail it. Put it in front of staff so somebody rings
        // the customer.
        await db.updateDocument(DB_ID, 'orders', order.$id, {
          status: 'PENDING',
          alert_level: 0,
          notes: `${order.notes || ''}\nUNAVAILABLE AT FIRE TIME: ${unavailable.join(', ')} — call the customer.`.trim(),
        });
        log(`Fired ${order.order_no} with unavailable items: ${unavailable.join(', ')}`);
      } else {
        await db.updateDocument(DB_ID, 'orders', order.$id, { status: 'PENDING', alert_level: 0 });
        log(`Fired ${order.order_no}`);
      }
      fired++;
    }

    return res.json({ ok: true, fired, checked: due.total });
  } catch (e) {
    error(`preorder-fire failed: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
};
