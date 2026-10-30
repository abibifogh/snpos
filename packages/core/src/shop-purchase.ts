/**
 * Pieces the shop bought to sell, put on the shelf from a spend.
 *
 * The shop's shelf is filled two ways. A maker leaving pieces is a delivery
 * on Goods received: a slip, nothing paid, and the maker credited when each
 * one sells. The shop buying pieces itself (a box of cards, a crate of
 * baskets from a market) is a spend, and these are the lines of it that are
 * pieces rather than supplies.
 */
import { db, DB_ID, ID } from './client';
import { moveStock } from './consignment';
import type { ProductVariant } from './consignment';
import type { RestockChoice } from './intake-restock';

/**
 * One line of a purchase: written on the spend, then put on the shelf.
 *
 * Charged to what the spend was for, not to the stock account. The shop's
 * sales take no cost off the shelf for a piece it owns (it has no recipe and
 * no cost price), so a purchase put on the balance sheet would sit there for
 * good. So the line is marked not stocked, which is what the books read, and
 * the shelf still goes up by what came in.
 */
export async function receivePieces(opts: {
  venueId: string;
  expenseId: string;
  piece: RestockChoice;
  qty: number;
  lineTotal: number;
  unitCost: number;
  shiftId?: string;
  userId?: string;
  note?: string;
}): Promise<void> {
  const { piece, qty } = opts;
  if (!Number.isInteger(qty) || qty <= 0) throw new Error(`${piece.label} is counted in whole pieces.`);

  await db.createDocument(DB_ID, 'expense_items', ID.unique(), {
    expense_id: opts.expenseId,
    ingredient_id: '',
    menu_item_id: piece.menuItemId,
    variant_id: piece.variantId ?? '',
    name_snapshot: piece.label,
    qty,
    unit_cost: opts.unitCost,
    line_total: opts.lineTotal,
    stocked: false,
  });

  // The count as it is now, not as it was when the form opened: a sale in
  // between would otherwise be undone by this delivery.
  const now = piece.variantId
    ? await db.getDocument(DB_ID, 'product_variants', piece.variantId) as unknown as ProductVariant
    : await db.getDocument(DB_ID, 'menu_items', piece.menuItemId) as unknown as { $id: string; on_hand?: number };

  await moveStock({
    venueId: opts.venueId,
    menuItemId: piece.menuItemId,
    variant: piece.variantId ? now as ProductVariant : null,
    item: piece.variantId ? null : now,
    type: 'intake',
    qtyDelta: qty,
    unitPrice: piece.price,
    refType: 'expense',
    refId: opts.expenseId,
    shiftId: opts.shiftId,
    note: opts.note ?? 'Bought by the shop',
    userId: opts.userId,
  });
}
