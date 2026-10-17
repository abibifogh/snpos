/**
 * Orders to suppliers, for things running out.
 *
 * The cycle: what is running low is suggested, grouped by who supplies it,
 * in the packs it is bought in, enough to bring it back up to its full
 * level. Somebody allowed to order (can_order_stock, or an admin) turns a
 * suggestion into an order, changes what they like, and sends it — as a PDF,
 * a message pasted into WhatsApp, or an email. An order worth more than the
 * owner's limit waits on Waiting for you first.
 *
 * When the goods arrive they are received THROUGH THE SPEND that pays for
 * them, exactly as stock is bought today: picking the order fills the spend's
 * items in, saving adds them to stock, and the order is marked part received
 * or received. One entry, so a delivery is never added twice.
 *
 * Pure. Imports nothing at runtime. The reading and writing is in
 * purchase-orders-store.ts.
 */

export type PoStatus = 'draft' | 'waiting' | 'ready' | 'sent' | 'part' | 'received' | 'cancelled' | 'refused';

export const PO_STATUS_WORDS: Record<PoStatus, { label: string; tone: 'ok' | 'warn' | 'danger' | 'default' }> = {
  draft: { label: 'Draft', tone: 'default' },
  waiting: { label: 'Waiting for approval', tone: 'warn' },
  ready: { label: 'Ready to send', tone: 'warn' },
  sent: { label: 'Sent', tone: 'default' },
  part: { label: 'Part received', tone: 'warn' },
  received: { label: 'Received', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'default' },
  refused: { label: 'Not approved', tone: 'danger' },
};

/** Still to arrive: what a spend can receive against. */
export const isOpenOrder = (status?: string): boolean => status === 'ready' || status === 'sent' || status === 'part';

/** Can still be changed: nothing has gone to the supplier yet. */
export const isEditableOrder = (status?: string): boolean =>
  status === 'draft' || status === 'ready' || status === 'refused' || status === 'waiting';

export interface PoLine {
  ingredient_id: string;
  name: string;
  /** What it is counted in on the shelf: bottle, kg. */
  unit: string;
  /** What it is bought in: crates, bottles. */
  buy_key: 'pack' | 'unit';
  buy_label: string;
  /** How many counting units one of those is. */
  per: number;
  /** How many of the buying unit are ordered. */
  qty: number;
  /** The expected price of ONE buying unit, in minor units. */
  unit_cost: number;
  /** How many of the buying unit have arrived so far. */
  received_qty: number;
}

export interface OrderableItem {
  $id: string;
  name: string;
  unit: string;
  current_qty: number;
  par_level?: number;
  low_threshold?: number | null;
  supplier_id?: string | null;
  pack_size?: number;
  pack_name?: string;
  base_unit_cost?: number;
  last_unit_cost?: number;
  module?: string;
  active?: boolean;
  counted_at_close?: boolean;
}

export interface OrderSupplier { $id: string; name: string; email?: string; phone?: string; active?: boolean }

const hasPack = (i: Pick<OrderableItem, 'pack_size'>) => Number.isFinite(i.pack_size) && (i.pack_size ?? 0) > 1;
const plural = (w: string) => {
  const s = (w || '').trim() || 'unit';
  return /s$|kg$|ml$|cl$|g$|l$/i.test(s) ? s : `${s}s`;
};

/** The low line for an item: its own, or a share of its full level. Same rule as levelOf in stock.ts. */
export const lowAt = (i: Pick<OrderableItem, 'low_threshold' | 'par_level'>, lowDefaultBp = 3000): number =>
  i.low_threshold ?? ((i.par_level ?? 0) * lowDefaultBp) / 10000;

/** Out, or at or below its low line. Overheads nobody counts are never "running low". */
export function isRunningLow(i: OrderableItem, lowDefaultBp = 3000): boolean {
  if (i.active === false || i.counted_at_close === false) return false;
  if (!((i.current_qty ?? 0) > 0)) return true;
  return i.current_qty <= lowAt(i, lowDefaultBp);
}

/**
 * One line to order for an item: enough to bring it back to its full level,
 * in whole packs where it is bought in packs.
 *
 * With no full level set, one pack (or one unit): an order of something, which
 * the person ordering can change, rather than nothing and no line at all.
 */
export function suggestLine(i: OrderableItem): PoLine {
  const per = hasPack(i) ? (i.pack_size as number) : 1;
  const wanted = Math.max(0, (i.par_level ?? 0) - Math.max(0, i.current_qty ?? 0));
  const qty = Math.max(1, Math.ceil((wanted > 0 ? wanted : per) / per - 1e-9));
  const each = Math.round((i.last_unit_cost || i.base_unit_cost || 0) * per);
  return {
    ingredient_id: i.$id,
    name: i.name,
    unit: i.unit,
    buy_key: hasPack(i) ? 'pack' : 'unit',
    buy_label: hasPack(i) ? plural(i.pack_name || 'pack') : plural(i.unit),
    per,
    qty,
    unit_cost: each,
    received_qty: 0,
  };
}

export interface Suggestion {
  supplierId: string;
  supplierName: string;
  /** Whose stock: one order is for one department, as its stock is. */
  module: string;
  lines: PoLine[];
  total: number;
}

/**
 * Everything running low, as orders to make: one per supplier and
 * department, and one for items with no supplier set, so nothing that has
 * run out drops off the list for want of a name. Biggest order first.
 *
 * Split by department because an order is: the bar's Club and the
 * kitchen's oil from the same wholesaler are two orders, received into two
 * different stores and paid from two sides' books.
 */
export function suggestions(items: OrderableItem[], suppliers: OrderSupplier[], lowDefaultBp = 3000): Suggestion[] {
  const by = new Map<string, Suggestion>();
  for (const i of items) {
    if (!isRunningLow(i, lowDefaultBp)) continue;
    const sid = i.supplier_id && suppliers.some((s) => s.$id === i.supplier_id) ? i.supplier_id : '';
    const name = suppliers.find((s) => s.$id === sid)?.name ?? 'No supplier set';
    const module = i.module ?? 'kitchen';
    const key = `${sid}|${module}`;
    const g = by.get(key) ?? { supplierId: sid, supplierName: name, module, lines: [], total: 0 };
    g.lines.push(suggestLine(i));
    by.set(key, g);
  }
  for (const g of by.values()) {
    g.lines.sort((a, b) => a.name.localeCompare(b.name));
    g.total = orderTotal(g.lines);
  }
  return [...by.values()].sort((a, b) => (a.supplierId ? 0 : 1) - (b.supplierId ? 0 : 1) || b.total - a.total);
}

/** A department's own items, for an order's item list. Rows with no side were the kitchen's. */
export const itemsFor = <T extends { module?: string; active?: boolean }>(items: T[], module: string): T[] =>
  items.filter((i) => i.active !== false && (i.module ?? 'kitchen') === module);

/**
 * Why a supplier typed on the order cannot be added, or null when it can.
 * A name that matches one already on the list is that one, not a second.
 */
export function newSupplierProblem(name: string, suppliers: Pick<OrderSupplier, 'name'>[]): string | null {
  const n = name.trim().toLowerCase();
  if (!n) return 'Give the new supplier a name.';
  if (suppliers.some((s) => s.name.trim().toLowerCase() === n)) return 'That supplier is already on the list: pick it above.';
  return null;
}

export const poLineTotal = (l: Pick<PoLine, 'qty' | 'unit_cost'>): number => Math.round((l.qty || 0) * (l.unit_cost || 0));
export const orderTotal = (lines: Pick<PoLine, 'qty' | 'unit_cost'>[]): number => lines.reduce((n, l) => n + poLineTotal(l), 0);

/** Whether an order of this size waits for approval. A limit of nought means none do. */
export const orderNeedsApproval = (total: number, limit: number): boolean => limit > 0 && total > limit;

/** Why this order cannot be sent for approval or sent, or null. */
export function orderProblem(o: { supplier_name?: string; lines: PoLine[] }): string | null {
  if (!(o.supplier_name ?? '').trim()) return 'Choose who the order is going to.';
  const live = o.lines.filter((l) => l.qty > 0);
  if (live.length === 0) return 'Add at least one item.';
  if (o.lines.some((l) => !(l.qty >= 0) || !Number.isFinite(l.qty))) return 'Every quantity must be a number.';
  return null;
}

/** The next number: PO-0001, PO-0002… from the highest already used. */
export function nextPoNo(used: string[]): string {
  const top = used.reduce((m, n) => {
    const d = Number(/(\d+)$/.exec(n ?? '')?.[1] ?? 0);
    return Number.isFinite(d) && d > m ? d : m;
  }, 0);
  return `PO-${String(top + 1).padStart(4, '0')}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-10-20" as "20 October 2026". Anything else is said as it was typed. */
export function neededByWords(day: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((day ?? '').trim());
  if (!m) return (day ?? '').trim();
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

const qtyWords = (l: Pick<PoLine, 'qty' | 'buy_label' | 'buy_key' | 'per' | 'unit'>): string =>
  l.buy_key === 'pack' ? `${l.qty} ${l.qty === 1 ? l.buy_label.replace(/s$/, '') : l.buy_label} (${l.per} ${plural(l.unit)} each)` : `${l.qty} ${l.qty === 1 ? l.unit : plural(l.unit)}`;

/**
 * The order as a message, for pasting into WhatsApp or a text.
 *
 * Prices are left out on purpose: a message to a supplier is "please send",
 * and quoting them our idea of their price invites an argument over a
 * figure that was only ever an estimate. The PDF carries the prices.
 */
export function orderMessage(o: {
  po_no: string;
  supplier_name?: string;
  lines: PoLine[];
  note?: string;
  expected_on?: string;
}, business: string, fromName?: string): string {
  const live = o.lines.filter((l) => l.qty > 0);
  return [
    `Hello${o.supplier_name ? ` ${o.supplier_name}` : ''},`,
    '',
    `Please could you supply the following for ${business || 'us'} (order ${o.po_no}):`,
    ...live.map((l) => `• ${l.name}: ${qtyWords(l)}`),
    ...(o.expected_on ? ['', `Needed by ${neededByWords(o.expected_on)}.`] : []),
    ...(o.note?.trim() ? ['', o.note.trim()] : []),
    '',
    'Thank you.',
    ...(fromName ? [fromName] : []),
  ].join('\n');
}

/** Lines still to arrive, in buying units. */
export const stillToCome = (lines: PoLine[]): PoLine[] =>
  lines.filter((l) => l.qty - (l.received_qty || 0) > 1e-9);

/**
 * An order once a spend has received some of it.
 *
 * `got` is what the spend took into stock, in COUNTING units (the spend form
 * works in those): converted back into the order's buying units by each
 * line's own pack size. An item on the spend that was not on the order is
 * ignored here — it went into stock all the same, it just was not ordered.
 */
export function receiveInto(
  lines: PoLine[],
  got: { ingredient_id: string; qty: number }[],
): { lines: PoLine[]; status: 'part' | 'received' } {
  const left = new Map<string, number>();
  for (const g of got) left.set(g.ingredient_id, (left.get(g.ingredient_id) ?? 0) + Math.max(0, g.qty));
  const next = lines.map((l) => {
    const units = left.get(l.ingredient_id) ?? 0;
    if (units <= 0) return l;
    const room = Math.max(0, l.qty - (l.received_qty || 0));
    const take = Math.min(room, units / (l.per || 1));
    left.set(l.ingredient_id, units - take * (l.per || 1));
    return { ...l, received_qty: Number(((l.received_qty || 0) + take).toFixed(4)) };
  });
  return { lines: next, status: stillToCome(next).filter((l) => l.qty > 0).length === 0 ? 'received' : 'part' };
}

/** The status an order is saved at when it is finished being written. */
export const submittedStatus = (total: number, limit: number, isAdmin: boolean): PoStatus =>
  (isAdmin || !orderNeedsApproval(total, limit) ? 'ready' : 'waiting');

/** Read the stored lines, forgiving anything that is not a list. */
export function readLines(raw: string | null | undefined): PoLine[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v as PoLine[] : [];
  } catch {
    return [];
  }
}

/**
 * May make, change and send orders. Admins always. A manager unless an admin
 * has switched it off for them — a profile saved before the switch existed
 * has nothing stored and still orders, as a manager is expected to. Anybody
 * else only when an admin has switched it on, on Staff.
 */
export const canOrderStock = (p: { role?: string; can_order_stock?: boolean } | null | undefined): boolean =>
  !!p && (p.role === 'admin' || p.can_order_stock === true || (p.role === 'manager' && p.can_order_stock !== false));

/** May approve an order over the limit. The same people who approve spends. */
export const canApproveOrders = (p: { role?: string } | null | undefined): boolean =>
  !!p && (p.role === 'admin' || p.role === 'manager');
