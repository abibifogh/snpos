/**
 * Moving purchase orders out of the old `purchase_orders` collection.
 *
 * The live `purchase_orders` was built for an older design and could not be
 * repaired: every update to one of its rows was refused (see the note on
 * `stock_orders` in schema.mjs). Orders now live in `stock_orders`, and the
 * rows already saved are copied across by provisioning, under the SAME id, so
 * a spend whose purchase_order_id points at one still finds it.
 *
 * Plain JavaScript with no imports, so a test can load it without the SDK.
 */

/** What an order's status may be now. The old design said part_received. */
const STATUSES = ['draft', 'waiting', 'ready', 'sent', 'part', 'received', 'cancelled', 'refused'];

/**
 * The row to write for an old order, or null for one that is not an order
 * this design ever made.
 *
 * Only the columns the new collection has, and only those with a value: an
 * old row carries columns from the older design (po_number, subtotal…) that
 * the new one does not, and writing one would be refused. A row with no
 * po_no or no venue was written by the older design and was never an order
 * anybody saw on this page, so it is left behind.
 */
export function movedOrderRow(old, keys) {
  if (!old || !old.po_no || !old.venue_id) return null;
  const row = {};
  for (const k of keys) {
    const v = old[k];
    if (v !== null && v !== undefined) row[k] = v;
  }
  const status = old.status === 'part_received' ? 'part' : old.status;
  row.status = STATUSES.includes(status) ? status : 'draft';
  return row;
}
