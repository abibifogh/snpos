/**
 * A delivery that brings more of something the shop already sells.
 *
 * The intake desk only ever made new products: a maker bringing ten more of
 * the Moringa Soap already on the shelf became a second "Moringa Soap" with
 * its own count, its own price and its own row on every report, and the old
 * one sat at nought beside it. So a row on a delivery can name one of this
 * maker's products — and its size, where it has sizes — and the pieces join
 * that product's shelf instead.
 *
 * Only this maker's products: a piece is credited to whoever made it when it
 * sells, so restocking somebody else's product from this delivery would pay
 * the wrong person.
 *
 * Pure. Imports nothing at runtime.
 */

export interface RestockItem {
  $id: string;
  name: string;
  price: number;
  on_hand?: number;
  active?: boolean;
  module?: string;
  consignor_id?: string | null;
}

export interface RestockSize {
  $id: string;
  menu_item_id: string;
  label: string;
  price: number;
  on_hand?: number;
  active?: boolean;
  sort?: number;
}

/** One thing a delivery row can restock: a product, or one of its sizes. */
export interface RestockChoice {
  /** `item` or `item|size`, unique among the choices. */
  key: string;
  menuItemId: string;
  variantId?: string;
  label: string;
  price: number;
  onHand: number;
}

/** What this maker's delivery can restock, by name. */
export function restockChoices(items: RestockItem[], sizes: RestockSize[], consignorId: string): RestockChoice[] {
  const out: RestockChoice[] = [];
  for (const item of items) {
    if ((item.module ?? 'kitchen') !== 'craft' || item.active === false || !consignorId || item.consignor_id !== consignorId) continue;
    const own = sizes
      .filter((s) => s.menu_item_id === item.$id && s.active !== false)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.label.localeCompare(b.label));
    if (own.length === 0) {
      out.push({ key: item.$id, menuItemId: item.$id, label: item.name, price: item.price, onHand: item.on_hand ?? 0 });
      continue;
    }
    // A product with sizes keeps its count on each size, so each size is the choice.
    for (const s of own) {
      out.push({
        key: `${item.$id}|${s.$id}`, menuItemId: item.$id, variantId: s.$id,
        label: `${item.name} · ${s.label}`, price: s.price, onHand: s.on_hand ?? 0,
      });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export interface DeliveryMove {
  menu_item_id: string;
  variant_id?: string | null;
  type: string;
  qty_delta: number;
}

/** What one delivery added to products it did not create. */
export interface Restocked {
  menuItemId: string;
  variantId?: string;
  qty: number;
}

/**
 * The products this delivery restocked, and how many each, from its own
 * movements. Products the delivery created are left out: they are listed as
 * pieces of their own.
 */
export function restockedBy(moves: DeliveryMove[], createdIds: Set<string>): Restocked[] {
  const by = new Map<string, Restocked>();
  for (const m of moves) {
    if (createdIds.has(m.menu_item_id)) continue;
    if (m.type !== 'intake' && m.type !== 'adjustment') continue;
    const key = `${m.menu_item_id}|${m.variant_id ?? ''}`;
    const at = by.get(key) ?? { menuItemId: m.menu_item_id, variantId: m.variant_id || undefined, qty: 0 };
    at.qty += m.qty_delta;
    by.set(key, at);
  }
  return [...by.values()].filter((r) => r.qty !== 0);
}
