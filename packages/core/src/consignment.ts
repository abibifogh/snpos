import { db, DB_ID, ID, Query, listAll } from './client';
import type { Doc, Settings } from './types';
import type { Order, OrderItem } from './orders';

/**
 * The craft-shop side: goods that belong to somebody else.
 *
 * A consignment shop sells things it does not own. Somebody brings work in, the
 * shop sells it, keeps an agreed share and owes the rest. Everything difficult
 * about the trade lives in that last clause — and it is the part a spreadsheet
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
  kind: 'size' | 'colour' | 'finish' | 'other';
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

export type LedgerKind = 'sale' | 'refund' | 'payout' | 'adjustment' | 'fee';

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

/* ------------------------------------------------------------------ the split */

/**
 * Which commission rate applies to one sale.
 *
 * Three places can set it, most specific first: the piece, the consignor, then
 * the shop's default. The order matters — a shop negotiates a lower rate on a
 * large commissioned work without wanting that to become everybody's rate — and
 * getting it backwards would silently pay the wrong people the wrong amount for
 * as long as nobody checked.
 */
export function rateFor(
  item: { commission_bp?: number | null },
  consignor: { commission_bp?: number | null } | null | undefined,
  settings?: Pick<Settings, 'default_commission_bp'>,
): number {
  const candidates = [item?.commission_bp, consignor?.commission_bp, settings?.default_commission_bp];
  for (const bp of candidates) {
    if (typeof bp === 'number' && bp >= 0) return bp;
  }
  return 3000;
}

export interface Split {
  /** What the customer paid for this line. */
  gross: number;
  /** What the shop keeps. */
  commission: number;
  /** What the consignor is owed. */
  consignor: number;
  /** The rate used, so it can be written down beside the numbers. */
  bp: number;
}

/**
 * Divide one sale between the shop and the maker.
 *
 * The commission is rounded and the consignor gets the remainder, rather than
 * both being rounded independently. Two roundings of the same amount do not
 * have to add back up to it, and a shop that keeps one pesewa more than it
 * should on every sale of an odd-priced item will eventually be asked about it
 * by somebody with a calculator. Whatever is left after the shop's share is the
 * maker's share, by construction.
 *
 * A discount reduces what the customer paid, so it reduces both sides in
 * proportion — the shop does not fund a sale out of somebody else's work, and
 * it does not pass the whole cost of its own promotion to them either. Pass the
 * line's actual money, after discount.
 */
export function splitSale(gross: number, commissionBp: number): Split {
  const bp = Math.max(0, Math.min(10000, Math.round(commissionBp)));
  const commission = Math.round((gross * bp) / 10000);
  return { gross, commission, consignor: gross - commission, bp };
}

/**
 * What a set of ledger entries comes to.
 *
 * Summed rather than read from anywhere, everywhere, always. See the note at
 * the top of this file: the balance is a conclusion, not a stored fact.
 */
export const balanceOf = (entries: Pick<LedgerEntry, 'amount'>[]): number =>
  entries.reduce((sum, e) => sum + e.amount, 0);

/* -------------------------------------------------------------- the recording */

/**
 * Credit a consignor for everything of theirs on a settled order.
 *
 * Called once, when the bill is paid — not when the order is placed. An order
 * that is cancelled, voided or never paid for owes nobody anything, and a
 * credit written at the till and reversed later is two entries on a statement
 * where there should be none.
 *
 * Safe to call twice. `order_item_id` carries a unique index, so a repeat is
 * refused by the database rather than by a check that can race — which matters,
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
 * Two records, and both are needed. The payout is the event — when, how much,
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

/* ---------------------------------------------------------------- statements */

export interface StatementLine {
  at: string;
  kind: LedgerKind;
  description: string;
  qty: number;
  gross: number;
  commission: number;
  /** What this line did to the balance. */
  amount: number;
}

export interface Statement {
  consignor: Consignor;
  from: string;
  to: string;
  /** What was owed before the first line of this statement. */
  openingBalance: number;
  lines: StatementLine[];
  soldCount: number;
  grossSales: number;
  commissionKept: number;
  earned: number;
  paidOut: number;
  adjustments: number;
  /** What is owed at the end of the period. */
  closingBalance: number;
}

/**
 * A consignor's statement for a period.
 *
 * Built from the ledger and nothing else, which is what lets it be checked. The
 * opening balance is every entry before the window, so the statement adds up on
 * its own — a period statement whose figures only reconcile against a different
 * document is a statement that starts an argument rather than settling one.
 *
 * Dates are inclusive at both ends: somebody asking for March means March, and
 * losing the 31st to an off-by-one is the kind of error that is only noticed by
 * the person it costs.
 */
export function buildStatement(
  consignor: Consignor,
  entries: LedgerEntry[],
  from: Date,
  to: Date,
): Statement {
  const start = from.toISOString();
  // To the last instant of the closing day, so entries on it are included.
  const endOfDay = new Date(to);
  endOfDay.setHours(23, 59, 59, 999);
  const end = endOfDay.toISOString();

  const before = entries.filter((e) => e.entry_at < start);
  const within = entries
    .filter((e) => e.entry_at >= start && e.entry_at <= end)
    .sort((a, b) => a.entry_at.localeCompare(b.entry_at));

  const openingBalance = balanceOf(before);

  const lines: StatementLine[] = within.map((e) => ({
    at: e.entry_at,
    kind: e.kind,
    description: e.description || labelForKind(e.kind),
    qty: e.qty ?? 0,
    gross: e.gross ?? 0,
    commission: e.commission ?? 0,
    amount: e.amount,
  }));

  const sales = within.filter((e) => e.kind === 'sale');
  const refunds = within.filter((e) => e.kind === 'refund');

  return {
    consignor,
    from: start,
    to: end,
    openingBalance,
    lines,
    soldCount: sales.reduce((n, e) => n + (e.qty ?? 1), 0),
    grossSales: sales.reduce((n, e) => n + (e.gross ?? 0), 0) + refunds.reduce((n, e) => n + (e.gross ?? 0), 0),
    commissionKept:
      sales.reduce((n, e) => n + (e.commission ?? 0), 0) + refunds.reduce((n, e) => n + (e.commission ?? 0), 0),
    earned: [...sales, ...refunds].reduce((n, e) => n + e.amount, 0),
    // Stored negative; reported as the positive amount that was handed over.
    paidOut: -within.filter((e) => e.kind === 'payout').reduce((n, e) => n + e.amount, 0),
    adjustments: within.filter((e) => e.kind === 'adjustment' || e.kind === 'fee').reduce((n, e) => n + e.amount, 0),
    closingBalance: openingBalance + balanceOf(within),
  };
}

const labelForKind = (kind: LedgerKind) =>
  kind === 'sale' ? 'Sale'
    : kind === 'refund' ? 'Refund'
      : kind === 'payout' ? 'Payment to you'
        : kind === 'fee' ? 'Fee'
          : 'Adjustment';

/* ------------------------------------------------------------------ loading */

export const loadConsignors = (activeOnly = false) =>
  listAll<Consignor>('consignors', activeOnly ? [Query.equal('active', true)] : []).then((rows) =>
    rows.sort((a, b) => a.name.localeCompare(b.name)),
  );

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
 * paper — "INT-0007" survives a phone call in a way a random id does not.
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
 * start telling different stories — which is precisely the state this whole
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

/**
 * How much of a product is on the shelf.
 *
 * With variants the count lives on each one and the product's own figure means
 * nothing — one place to ask, so a screen cannot pick the wrong one.
 */
export const onHandFor = (
  item: { on_hand?: number },
  variants: Pick<ProductVariant, 'on_hand' | 'active'>[] = [],
): number =>
  variants.length
    ? variants.filter((v) => v.active).reduce((n, v) => n + (v.on_hand ?? 0), 0)
    : item.on_hand ?? 0;
