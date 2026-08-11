import { db, DB_ID, ID, Query, listAll } from './client';
import { rateFor, splitSale } from './consignment-math';
import type { LedgerKind } from './consignment-math';
import type { Doc, Settings } from './types';
import type { Order, OrderItem } from './orders';

/**
 * The arithmetic lives next door, in a file that imports nothing.
 *
 * Re-exported here so every existing caller keeps working and nobody has to
 * know which of the two files a function came from. The split exists so the
 * money logic can be tested without a database, not to make callers choose.
 */
export {
  rateFor, splitSale, balanceOf, buildStatement, labelForKind, onHandFor,
} from './consignment-math';
export type {
  Split, Statement, StatementLine, LedgerKind, LedgerLike,
} from './consignment-math';

/**
 * The craft-shop side: goods that belong to somebody else.
 *
 * A consignment shop sells things it does not own. Somebody brings work in, the
 * shop sells it, keeps an agreed share and owes the rest. Everything difficult
 * about the trade lives in that last clause, and it is the part a spreadsheet
 * gets wrong first, because a running total is one careless edit away from
 * being unarguable and wrong.
 *
 * So what is owed is never stored. It is the sum of a ledger: every sale
 * credits, every payout debits, and the balance can be read back line by line
 * to whoever is asking. That is the design decision the rest of this file
 * follows from.
 */

export interface Consignor extends Doc {
  venue_id?: string;
  code: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  /** What the shop keeps, in basis points. 3000 = 30%. */
  commission_bp: number;
  payout_method?: 'cash' | 'momo' | 'bank' | 'other';
  payout_details?: string;
  agreement_start?: string;
  agreement_end?: string;
  notes?: string;
  active: boolean;
}

export interface ConsignmentIntake extends Doc {
  venue_id?: string;
  consignor_id: string;
  reference: string;
  received_at: string;
  received_by?: string;
  piece_count: number;
  total_retail: number;
  notes?: string;
  status: 'open' | 'closed';
}

export interface ProductVariant extends Doc {
  venue_id?: string;
  menu_item_id: string;
  label: string;
  /** The original fixed four, kept only so old rows still validate. */
  kind: 'size' | 'colour' | 'finish' | 'other';
  /** What the shop calls this kind of variation. See `variant_types`. */
  kind_key?: string;
  price: number;
  sku?: string;
  barcode?: string;
  on_hand: number;
  sort: number;
  active: boolean;
}

export type MoveType =
  | 'intake' | 'sale' | 'return_to_consignor' | 'damaged' | 'lost' | 'adjustment' | 'refund';

export interface ProductMove extends Doc {
  venue_id?: string;
  menu_item_id: string;
  variant_id?: string;
  consignor_id?: string;
  type: MoveType;
  qty_delta: number;
  unit_price: number;
  ref_type?: string;
  ref_id?: string;
  shift_id?: string;
  note?: string;
  created_by?: string;
}

export interface LedgerEntry extends Doc {
  venue_id?: string;
  consignor_id: string;
  entry_at: string;
  kind: LedgerKind;
  /** Positive increases what the shop owes; negative reduces it. */
  amount: number;
  description?: string;
  order_id?: string;
  order_item_id?: string;
  menu_item_id?: string;
  variant_label?: string;
  qty?: number;
  gross?: number;
  commission?: number;
  commission_bp?: number;
  payout_id?: string;
  created_by?: string;
}

export interface ConsignorPayout extends Doc {
  venue_id?: string;
  consignor_id: string;
  reference: string;
  paid_at: string;
  amount: number;
  method: 'cash' | 'momo' | 'bank' | 'other';
  transaction_ref?: string;
  period_start?: string;
  period_end?: string;
  note?: string;
  status: 'recorded' | 'reversed';
  reversed_reason?: string;
  paid_by?: string;
}

/* -------------------------------------------------------------- the recording */

/**
 * Credit a consignor for everything of theirs on a settled order.
 *
 * Called once, when the bill is paid, not when the order is placed. An order
 * that is cancelled, voided or never paid for owes nobody anything, and a
 * credit written at the till and reversed later is two entries on a statement
 * where there should be none.
 *
 * Safe to call twice. `order_item_id` carries a unique index, so a repeat is
 * refused by the database rather than by a check that can race, which matters,
 * because a payment retried on a bad connection is exactly the case that would
 * otherwise pay somebody twice.
 */
export async function creditForOrder(opts: {
  venueId: string;
  order: Pick<Order, '$id'>;
  items: OrderItem[];
  consignors: Consignor[];
  settings?: Pick<Settings, 'default_commission_bp'>;
  userId?: string;
  at?: Date;
}): Promise<{ credited: number; total: number }> {
  const { venueId, order, items, consignors, settings, userId } = opts;
  const at = (opts.at ?? new Date()).toISOString();
  const byId = new Map(consignors.map((c) => [c.$id, c]));

  let credited = 0;
  let total = 0;

  for (const line of items) {
    if (line.status === 'void') continue;
    const consignorId = line.consignor_id;
    if (!consignorId) continue;

    const consignor = byId.get(consignorId) ?? null;
    // The rate written on the line wins over everything: it is what was agreed
    // at the moment of sale, and that is the only rate a statement may use.
    const bp = rateFor({ commission_bp: line.commission_bp }, consignor, settings);
    const split = splitSale(line.line_total ?? 0, bp);

    try {
      await db.createDocument(DB_ID, 'consignor_ledger', ID.unique(), {
        venue_id: venueId,
        consignor_id: consignorId,
        entry_at: at,
        kind: 'sale',
        amount: split.consignor,
        description: `${line.name_snapshot}${line.variant_label ? ` · ${line.variant_label}` : ''}`,
        order_id: order.$id,
        order_item_id: line.$id,
        menu_item_id: line.menu_item_id,
        variant_label: line.variant_label ?? '',
        qty: line.qty,
        gross: split.gross,
        commission: split.commission,
        commission_bp: split.bp,
        created_by: userId ?? '',
      });
      credited += 1;
      total += split.consignor;
    } catch (e) {
      // Already credited. The unique index on order_item_id is doing its job,
      // and the honest response is to carry on rather than to fail the sale
      // that has already been paid for.
      if (!/already exists|unique/i.test(e instanceof Error ? e.message : '')) throw e;
    }
  }

  return { credited, total };
}

/** Every ledger line for one consignor, oldest first. */
export const ledgerFor = (consignorId: string) =>
  listAll<LedgerEntry>('consignor_ledger', [Query.equal('consignor_id', consignorId)]).then((rows) =>
    rows.sort((a, b) => a.entry_at.localeCompare(b.entry_at)),
  );

/**
 * Write down that a consignor has been paid.
 *
 * Two records, and both are needed. The payout is the event, when, how much,
 * by what method, with a transaction reference somebody can look up. The ledger
 * line is what it does to the balance. Keeping them together in one row would
 * mean the statement had to know about payment methods, and the payout had to
 * know about balances.
 *
 * Nothing here moves money. The shop pays by momo or hands over cash and then
 * records that it did, which is the same rule the whole system follows.
 */
export async function recordPayout(opts: {
  venueId: string;
  consignor: Consignor;
  amount: number;
  method: ConsignorPayout['method'];
  reference: string;
  transactionRef?: string;
  periodStart?: string;
  periodEnd?: string;
  note?: string;
  userId?: string;
  at?: Date;
}): Promise<ConsignorPayout> {
  const at = (opts.at ?? new Date()).toISOString();
  if (!(opts.amount > 0)) throw new Error('A payout has to be more than nothing.');

  const payout = (await db.createDocument(DB_ID, 'consignor_payouts', ID.unique(), {
    venue_id: opts.venueId,
    consignor_id: opts.consignor.$id,
    reference: opts.reference,
    paid_at: at,
    amount: opts.amount,
    method: opts.method,
    transaction_ref: opts.transactionRef ?? '',
    period_start: opts.periodStart,
    period_end: opts.periodEnd,
    note: opts.note ?? '',
    status: 'recorded',
    paid_by: opts.userId ?? '',
  })) as unknown as ConsignorPayout;

  await db.createDocument(DB_ID, 'consignor_ledger', ID.unique(), {
    venue_id: opts.venueId,
    consignor_id: opts.consignor.$id,
    entry_at: at,
    kind: 'payout',
    // Negative: paying somebody reduces what they are owed.
    amount: -opts.amount,
    description: `Paid ${opts.method}${opts.transactionRef ? ` · ${opts.transactionRef}` : ''}`,
    payout_id: payout.$id,
    created_by: opts.userId ?? '',
  });

  return payout;
}

/* ------------------------------------------------------------------ loading */

export const loadConsignors = (activeOnly = false) =>
  listAll<Consignor>('consignors', activeOnly ? [Query.equal('active', true)] : []).then((rows) =>
    rows.sort((a, b) => a.name.localeCompare(b.name)),
  );

export interface VariantType extends Doc {
  key: string;
  name: string;
  singular?: string;
  sort: number;
  active: boolean;
}

/**
 * The kinds of variation this shop sells by.
 *
 * Falls back to the three it ships with when the list has not been provisioned
 * yet, so a product form opened on a fresh database offers something sensible
 * rather than an empty dropdown nobody can get past.
 */
export async function loadVariantTypes(): Promise<VariantType[]> {
  const rows = await listAll<VariantType>('variant_types').catch(() => [] as VariantType[]);
  const live = rows.filter((t) => t.active !== false).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  if (live.length) return live;
  return [
    { key: 'size', name: 'Sizes', singular: 'size', sort: 0, active: true },
    { key: 'colour', name: 'Colours', singular: 'colour', sort: 1, active: true },
    { key: 'finish', name: 'Finishes', singular: 'finish', sort: 2, active: true },
  ] as VariantType[];
}

export const loadVariants = (menuItemId?: string) =>
  listAll<ProductVariant>('product_variants', menuItemId ? [Query.equal('menu_item_id', menuItemId)] : []).then(
    (rows) => rows.sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label)),
  );

export const payoutsFor = (consignorId: string) =>
  listAll<ConsignorPayout>('consignor_payouts', [Query.equal('consignor_id', consignorId)]);

/**
 * What every consignor is owed right now, in one pass.
 *
 * One query rather than one per consignor. A shop with sixty makers and two
 * years of sales would otherwise open its own list with sixty round trips, and
 * the page that tells you who to pay is the page somebody opens every week.
 */
export async function balancesByConsignor(): Promise<Record<string, number>> {
  const entries = await listAll<LedgerEntry>('consignor_ledger');
  const totals: Record<string, number> = {};
  for (const e of entries) totals[e.consignor_id] = (totals[e.consignor_id] ?? 0) + e.amount;
  return totals;
}

/**
 * The next reference in a series, from what is already there.
 *
 * Human-readable and sequential because these get said out loud and written on
 * paper, "INT-0007" survives a phone call in a way a random id does not.
 */
export async function nextReference(
  collectionId: 'consignment_intakes' | 'consignor_payouts',
  prefix: string,
): Promise<string> {
  const rows = await listAll<{ reference?: string }>(collectionId).catch(() => []);
  let highest = 0;
  for (const r of rows) {
    const match = /(\d+)\s*$/.exec(r.reference ?? '');
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${String(highest + 1).padStart(4, '0')}`;
}

/* -------------------------------------------------------------- stock moves */

/**
 * Record a movement and move the count in one call.
 *
 * Always both. The movement is the record and the count is the convenience, and
 * the moment somebody writes one without the other the shelf and the history
 * start telling different stories, which is precisely the state this whole
 * collection exists to prevent.
 */
export async function moveStock(opts: {
  venueId: string;
  menuItemId: string;
  variant?: ProductVariant | null;
  consignorId?: string;
  type: MoveType;
  qtyDelta: number;
  unitPrice?: number;
  refType?: string;
  refId?: string;
  shiftId?: string;
  note?: string;
  userId?: string;
  /** The product row, when the count lives there rather than on a variant. */
  item?: { $id: string; on_hand?: number } | null;
}): Promise<void> {
  const { venueId, menuItemId, variant, qtyDelta } = opts;
  if (!qtyDelta) return;

  await db.createDocument(DB_ID, 'product_moves', ID.unique(), {
    venue_id: venueId,
    menu_item_id: menuItemId,
    variant_id: variant?.$id ?? '',
    consignor_id: opts.consignorId ?? '',
    type: opts.type,
    qty_delta: qtyDelta,
    unit_price: opts.unitPrice ?? 0,
    ref_type: opts.refType ?? '',
    ref_id: opts.refId ?? '',
    shift_id: opts.shiftId ?? '',
    note: opts.note ?? '',
    created_by: opts.userId ?? '',
  });

  if (variant) {
    await db.updateDocument(DB_ID, 'product_variants', variant.$id, {
      on_hand: (variant.on_hand ?? 0) + qtyDelta,
    });
  } else if (opts.item) {
    await db.updateDocument(DB_ID, 'menu_items', opts.item.$id, {
      on_hand: (opts.item.on_hand ?? 0) + qtyDelta,
    });
  }
}
