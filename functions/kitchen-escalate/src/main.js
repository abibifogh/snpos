import { Client, Databases, Query } from 'node-appwrite';

/**
 * Raises the alarm level on orders the kitchen has not acknowledged.
 *
 * The kitchen screen escalates on its own while it is running. This exists for
 * when it is NOT, a tablet that has crashed, been unplugged, or had its
 * battery optimised to death is precisely the situation where an order is
 * about to be forgotten and nobody is watching.
 *
 * Past the top level it also flags the order so managers see it.
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

  try {
    const settings = await db.getDocument(DB_ID, 'settings', 'main');
    const sla = settings.kitchen_ack_sla_seconds || 60;
    const maxLevel = settings.kitchen_ping_max_level || 4;

    const pending = await db.listDocuments(DB_ID, 'orders', [
      Query.equal('status', 'PENDING'),
      Query.limit(100),
    ]);

    let raised = 0;
    for (const order of pending.documents) {
      const ageSeconds = Math.floor((Date.now() - new Date(order.$createdAt).getTime()) / 1000);
      const shouldBe = Math.min(Math.floor(ageSeconds / sla), maxLevel);

      if (shouldBe > (order.alert_level || 0)) {
        await db.updateDocument(DB_ID, 'orders', order.$id, { alert_level: shouldBe });
        raised++;

        if (shouldBe >= maxLevel) {
          // At the top level the kitchen has had every chance. Record it so it
          // shows up in the audit trail and on the manager's dashboard.
          await db.createDocument(DB_ID, 'audit_log', 'unique()', {
            venue_id: order.venue_id,
            actor_id: 'system',
            actor_role: 'system',
            action: 'kitchen_unacknowledged',
            entity_type: 'order',
            entity_id: order.$id,
            after: JSON.stringify({ order_no: order.order_no, age_seconds: ageSeconds }),
          }).catch(() => undefined);
          log(`Order ${order.order_no} unacknowledged for ${ageSeconds}s, escalated to manager`);
        }
      }
    }

    return res.json({ ok: true, raised, pending: pending.total });
  } catch (e) {
    error(`kitchen-escalate failed: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
};
