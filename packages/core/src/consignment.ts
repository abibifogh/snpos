import { db, DB_ID, ID, Query, listAll } from './client';
import { rateFor, flatFor, splitSale } from './consignment-math';
import type { LedgerKind } from './consignment-math';
import type { Doc, Settings, MenuItem } from './types';
import type { Order, OrderItem } from './orders';
import { differencesIn, summariseCount, MOVE_FOR_REASON } from './stocktake';
import type { CountLine, PendingCount, PendingCountLine } from './stocktake';
import type { ImportMaker } from './maker-import';

/**
 * The arithmetic lives next door, in a file that imports nothing.
 *
 * Re-exported here so every existing caller keeps working and nobody has to
 * know which of the two files a function came from. The split exists so the
 * money logic can be tested without a database, not to make callers choose.
 */
export {
  rateFor, flatFor, splitSale, dueFor, balanceOf, buildStatement, labelForKind, onHandFor,
} from './consignment-math';
export type {
  Split, Statement, StatementLine, LedgerKind, LedgerLike, IntakeLine, UnsoldLine, IntakeLike,
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
  /** Or a flat amount per piece. Above zero, this wins over the percentage. */
  commission_flat?: number;
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
  /** The consignor's share of that, at the rate agreed on the day. */
  total_due?: number;
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
  commission_flat?: number;
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
    const flat = flatFor({ commission_flat: line.commission_flat }, consignor);
    const split = splitSale(line.line_total ?? 0, bp, flat, line.qty ?? 1);

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
        commission_flat: split.flat,
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
 * Only the payout is written here. The ledger line is written by the server,
 * on the payout's own creation event, because nothing in a browser may create a
 * ledger entry: the ledger is the number a maker is paid from, and a balance
 * anybody can type into is not evidence of anything. Trying to write it from
 * the admin app is what produced "No permissions provided for action create",
 * and the permission was right. This was wrong.
 *
 * So this waits for the server to catch up rather than reporting a payment
 * whose effect on the balance has not landed yet. If it does not land, that is
 * said out loud instead of leaving somebody to wonder why the figure has not
 * moved.
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
}): Promise<{ payout: ConsignorPayout; postedToLedger: boolean }> {
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

  return { payout, postedToLedger: await waitForPayoutEntry(payout.$id) };
}

/**
 * Wait for the server's ledger line for a payout to appear.
 *
 * A few seconds at most. The function that writes it fires on the payout being
 * created, so this is normally one or two attempts; the loop exists for the
 * cold start, not for a failure. Returns false rather than throwing, because
 * the payment itself is recorded either way and losing that would be the worse
 * outcome by a distance.
 */
export async function waitForPayoutEntry(payoutId: string, attempts = 8): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    // Half a second, then a second, then longer. A tight loop against a
    // database achieves nothing except load.
    await new Promise((r) => setTimeout(r, i === 0 ? 600 : 1200));
    const rows = await listAll<LedgerEntry>('consignor_ledger', [Query.equal('payout_id', payoutId)]).catch(
      () => [] as LedgerEntry[],
    );
    if (rows.length > 0) return true;
  }
  return false;
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

/* ------------------------------------------------------------ bulk intake */

export interface ImportOutcome {
  intakes: { reference: string; consignorName: string; pieces: number }[];
  products: number;
  variants: number;
  failures: { name: string; reason: string }[];
}

/**
 * Write a whole spreadsheet of stock in, as deliveries rather than as products.
 *
 * The difference matters. Creating the products alone would put stock on the
 * shelf that arrived from nowhere: no delivery to reprint a slip from, nothing
 * in the "what you brought in" half of a maker's statement, and no movement
 * behind the count. A bulk upload has to leave the same trail the intake desk
 * leaves, or it is a side door around the records the whole craft side is
 * built on.
 *
 * So the rows are grouped by maker and each maker gets a delivery, exactly as
 * if somebody had stood at the counter and typed it. Pieces the shop owns
 * outright have no maker and so get no delivery, which is right: there is
 * nobody to give a slip to and nobody to credit.
 *
 * Failures are collected rather than thrown. Nothing is written until the file
 * has already been judged clean by readImport, so anything failing here is the
 * database refusing a write, and stopping halfway would leave the shop in the
 * state this is trying to avoid. What did not land is named at the end.
 */
export async function importStock(opts: {
  venueId: string;
  products: {
    name: string;
    categoryId: string;
    description: string;
    price: number;
    quantity: number;
    consignorId: string;
    commissionBp: number | null;
    commissionFlat: number;
    barcode: string;
    oneOff: boolean;
    makerNote: string;
    variants: { kindKey: string; label: string; price: number; quantity: number; barcode: string }[];
  }[];
  consignors: Consignor[];
  settings?: Pick<Settings, 'default_commission_bp'>;
  userId?: string;
  receivedAt?: Date;
}): Promise<ImportOutcome> {
  const { venueId, products, consignors, settings, userId } = opts;
  const at = (opts.receivedAt ?? new Date()).toISOString();

  const outcome: ImportOutcome = { intakes: [], products: 0, variants: 0, failures: [] };

  // Grouped by maker, so one delivery covers everything that came from one
  // person, which is what both sides will remember it as.
  const byConsignor = new Map<string, typeof products>();
  for (const p of products) {
    byConsignor.set(p.consignorId, [...(byConsignor.get(p.consignorId) ?? []), p]);
  }

  for (const [consignorId, mine] of byConsignor) {
    const consignor = consignors.find((c) => c.$id === consignorId) ?? null;

    let intakeId = '';
    if (consignorId && consignor) {
      const pieces = mine.reduce((n, p) => n + p.quantity, 0);
      const retail = mine.reduce(
        (n, p) => n + (p.variants.length
          ? p.variants.reduce((v, x) => v + x.price * x.quantity, 0)
          : p.price * p.quantity),
        0,
      );
      // What it is worth to them, at the terms agreed today. Snapshotted for
      // the same reason the intake desk snapshots it: a rate renegotiated next
      // year must not restate what this delivery was worth.
      const bp = rateFor(null, consignor, settings);
      const flat = flatFor(null, consignor);
      const due = mine.reduce(
        (n, p) => n + (p.variants.length
          ? p.variants.reduce((v, x) => v + splitSale(x.price, bp, flat, 1).consignor * x.quantity, 0)
          : splitSale(p.price, bp, flat, 1).consignor * p.quantity),
        0,
      );

      const reference = await nextReference('consignment_intakes', 'INT').catch(() => `INT-${Date.now()}`);
      try {
        const intake = await db.createDocument(DB_ID, 'consignment_intakes', ID.unique(), {
          venue_id: venueId,
          consignor_id: consignorId,
          reference,
          received_at: at,
          received_by: userId ?? '',
          piece_count: pieces,
          total_retail: retail,
          total_due: due,
          notes: 'Received by bulk upload.',
          status: 'open',
        });
        intakeId = intake.$id;
        outcome.intakes.push({ reference, consignorName: consignor.name, pieces });
      } catch (e) {
        outcome.failures.push({
          name: consignor.name,
          reason: `The delivery could not be created: ${e instanceof Error ? e.message : 'unknown'}`,
        });
      }
    }

    for (const p of mine) {
      try {
        const item = await db.createDocument(DB_ID, 'menu_items', ID.unique(), {
          category_id: p.categoryId,
          name: p.name,
          description: p.description,
          price: p.price,
          active: true,
          // Not a dish. The kitchen's own fields are required by the database
          // and mean nothing here, so they get the quietest values they can.
          prep_minutes: 0,
          station: 'inherit',
          station_key: '',
          sort: 0,
          track_stock: false,
          image_focal_x: 0.5,
          image_focal_y: 0.5,
          module: 'craft',
          consignor_id: consignorId,
          intake_id: intakeId,
          // With sizes the count lives on each one, and a figure here as well
          // would be the same stock counted twice.
          on_hand: p.variants.length ? 0 : p.quantity,
          is_one_off: p.oneOff,
          maker_note: p.makerNote,
          barcode: p.barcode,
          commission_bp: p.commissionBp ?? undefined,
          commission_flat: p.commissionFlat,
        });
        outcome.products += 1;

        for (const [i, v] of p.variants.entries()) {
          await db.createDocument(DB_ID, 'product_variants', ID.unique(), {
            venue_id: venueId,
            menu_item_id: item.$id,
            label: v.label,
            // The original fixed four, kept only so old rows still validate.
            kind: ['size', 'colour', 'finish'].includes(v.kindKey) ? v.kindKey : 'other',
            kind_key: v.kindKey,
            price: v.price,
            barcode: v.barcode,
            on_hand: v.quantity,
            sort: i,
            active: true,
          });
          outcome.variants += 1;
        }

        // The arrival, written down. A product can be edited and a movement
        // cannot, which is what makes the history worth having.
        await moveStock({
          venueId,
          menuItemId: item.$id,
          consignorId: consignorId || undefined,
          type: 'intake',
          qtyDelta: p.quantity,
          unitPrice: p.price,
          refType: 'intake',
          refId: intakeId,
          userId,
          note: 'Bulk upload',
          // The counts were set as the rows were created, so this must not add
          // them a second time.
          item: null,
        }).catch(() => undefined);
      } catch (e) {
        outcome.failures.push({
          name: p.name,
          reason: e instanceof Error ? e.message : 'unknown',
        });
      }
    }
  }

  return outcome;
}

/* ------------------------------------------------------- counting the shelf */

/**
 * Every piece the shop has on its shelves, ready to be counted.
 *
 * A row per sellable thing rather than per product: a basket in three sizes is
 * three lines, because three sizes are what somebody standing at the shelf is
 * actually looking at and one line saying "11" tells them nothing about which
 * eleven.
 *
 * Sold-out lines are included. "There should be none and there are two" is a
 * real finding — a piece put back after a refund, a return nobody recorded —
 * and a count that only shows what it expects to find can never report it.
 */
export async function shelfLines(): Promise<CountLine[]> {
  const [items, variants, consignors, links, categories] = await Promise.all([
    listAll<MenuItem & { module?: string; consignor_id?: string; on_hand?: number; price: number }>('menu_items'),
    listAll<ProductVariant>('product_variants'),
    listAll<Consignor>('consignors').catch(() => [] as Consignor[]),
    listAll<{ menu_item_id: string; category_id: string }>('menu_item_categories').catch(() => []),
    listAll<{ $id: string; name: string }>('categories').catch(() => []),
  ]);

  const craft = items.filter((i) => (i.module ?? 'kitchen') === 'craft' && i.active !== false);
  const nameOf = new Map(consignors.map((c) => [c.$id, c.name]));
  // The first category a piece is in. A product can sit in several; for
  // deciding which shelf somebody walks to, the first is as good an answer as
  // any and a piece appearing under two headings would be counted twice.
  const categoryName = new Map(categories.map((c) => [c.$id, c.name]));
  const categoryOf = new Map<string, { id: string; name: string }>();
  for (const l of links) {
    if (categoryOf.has(l.menu_item_id)) continue;
    const name = categoryName.get(l.category_id);
    if (name) categoryOf.set(l.menu_item_id, { id: l.category_id, name });
  }
  const byItem = new Map<string, ProductVariant[]>();
  for (const v of variants) {
    if (!v.active) continue;
    (byItem.get(v.menu_item_id) ?? byItem.set(v.menu_item_id, []).get(v.menu_item_id)!).push(v);
  }

  const lines: CountLine[] = [];
  for (const item of craft) {
    const sizes = byItem.get(item.$id) ?? [];
    const cat = categoryOf.get(item.$id);
    if (sizes.length > 0) {
      // The variant is what sells when there is one; the product's own count
      // means nothing then, so counting it would invent a shelf that is not
      // there.
      for (const v of sizes.sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label))) {
        lines.push({
          menuItemId: item.$id,
          variantId: v.$id,
          name: item.name,
          variantLabel: v.label,
          consignorId: item.consignor_id || undefined,
          consignorName: item.consignor_id ? nameOf.get(item.consignor_id) : undefined,
          categoryId: cat?.id,
          categoryName: cat?.name,
          onHand: v.on_hand ?? 0,
          unitPrice: v.price,
        });
      }
    } else {
      lines.push({
        menuItemId: item.$id,
        name: item.name,
        consignorId: item.consignor_id || undefined,
        consignorName: item.consignor_id ? nameOf.get(item.consignor_id) : undefined,
        categoryId: cat?.id,
        categoryName: cat?.name,
        onHand: item.on_hand ?? 0,
        unitPrice: item.price,
      });
    }
  }

  return lines.sort(
    (a, b) => (a.consignorName ?? '~').localeCompare(b.consignorName ?? '~')
      || a.name.localeCompare(b.name)
      || (a.variantLabel ?? '').localeCompare(b.variantLabel ?? ''),
  );
}

/**
 * Submit a count for approval. Nothing on the shelf moves yet.
 *
 * The shelf moves when an admin approves what was found, and the gap between
 * those two moments is the point. An adjustment is the only write in the shop
 * that can make stock disappear with no sale behind it, so the person holding
 * the clipboard should not also be the person who signs it off.
 *
 * Stored rather than applied-and-reversed. A pending count changes nothing —
 * the till still sells what the shelf says — so an approval that never comes
 * costs nothing, and a rejection is not an unpicking.
 *
 * The header is written last. A count row with no lines under it reads as a
 * count that found nothing, which is the one wrong answer this could give; a
 * few orphan lines with no header are invisible and harmless.
 */
export async function submitCount(opts: {
  venueId: string;
  lines: CountLine[];
  userId: string;
  note?: string;
}): Promise<{ countId: string; lines: number }> {
  const differences = differencesIn(opts.lines);
  if (differences.length === 0) return { countId: '', lines: 0 };

  const summary = summariseCount(opts.lines);
  const countId = ID.unique();

  for (const d of differences) {
    await db.createDocument(DB_ID, 'stock_count_lines', ID.unique(), {
      count_id: countId,
      menu_item_id: d.line.menuItemId,
      variant_id: d.line.variantId ?? '',
      name_snapshot: d.line.name,
      variant_label: d.line.variantLabel ?? '',
      consignor_id: d.line.consignorId ?? '',
      consignor_name: d.line.consignorName ?? '',
      expected: d.line.onHand,
      counted: d.counted,
      delta: d.delta,
      reason: d.reason,
      unit_price: d.line.unitPrice,
      applied: false,
    });
  }

  await db.createDocument(DB_ID, 'stock_counts', countId, {
    venue_id: opts.venueId,
    counted_by: opts.userId,
    counted_at: new Date().toISOString(),
    note: opts.note?.trim() ?? '',
    status: 'pending',
    line_count: differences.length,
    missing_pieces: summary.missingPieces,
    missing_value: summary.missingValue,
    surplus_pieces: summary.surplusPieces,
  });

  return { countId, lines: differences.length };
}

export const pendingCounts = () =>
  listAll<PendingCount & Doc>('stock_counts', [Query.equal('status', 'pending')]).then((rows) =>
    rows.sort((a, b) => (b.counted_at ?? '').localeCompare(a.counted_at ?? '')),
  );

export const countLines = (countId: string) =>
  listAll<PendingCountLine & Doc>('stock_count_lines', [Query.equal('count_id', countId)]);

/**
 * Apply an approved count to the shelf.
 *
 * The DELTA is applied, never the counted figure. A count measures a
 * discrepancy at a moment; sales between the count and the approval are real
 * movements of their own, and overwriting the shelf with an absolute number
 * would erase them. Eleven on the shelf, nine found, two sold while it waited:
 * applying minus two leaves seven, which is what is actually there.
 *
 * Each line is marked as it goes, so approving twice — a double tap, a retried
 * request — cannot take the same pieces off the shelf again.
 */
export async function approveCount(opts: {
  countId: string;
  reviewerId: string;
  note?: string;
}): Promise<{ applied: number; failed: number }> {
  const lines = await countLines(opts.countId);
  let applied = 0;
  let failed = 0;

  for (const line of lines) {
    if (line.applied) continue;

    const variant = line.variant_id
      ? await db.getDocument(DB_ID, 'product_variants', line.variant_id).catch(() => null)
      : null;
    const item = line.variant_id
      ? null
      : await db.getDocument(DB_ID, 'menu_items', line.menu_item_id).catch(() => null);

    if (!variant && !item) { failed += 1; continue; }

    try {
      await moveStock({
        venueId: '',
        menuItemId: line.menu_item_id,
        variant: variant as ProductVariant | null,
        item: item as { $id: string; on_hand?: number } | null,
        consignorId: line.consignor_id,
        type: MOVE_FOR_REASON[line.reason],
        qtyDelta: line.delta,
        unitPrice: line.unit_price,
        refType: 'stocktake',
        refId: opts.countId,
        userId: opts.reviewerId,
        note: `Counted ${line.counted}, shelf said ${line.expected}`,
      });
      // Marked immediately after the movement rather than in a second pass, so
      // a run that stops half way leaves every applied line marked applied.
      await db.updateDocument(DB_ID, 'stock_count_lines', line.$id, { applied: true }).catch(() => undefined);
      applied += 1;
    } catch {
      failed += 1;
    }
  }

  // Left pending when anything failed, so it comes back to be finished rather
  // than being filed as done with half of it not done.
  if (failed === 0) {
    await db.updateDocument(DB_ID, 'stock_counts', opts.countId, {
      status: 'approved',
      reviewed_by: opts.reviewerId,
      reviewed_at: new Date().toISOString(),
      review_note: opts.note?.trim() ?? '',
    });
  }

  return { applied, failed };
}

/**
 * Turn a count down.
 *
 * Kept rather than deleted, with the reason on it. "Why is the shelf still
 * wrong" is a question somebody asks a week later, and "because that count was
 * rejected on the 14th, by this person, for this reason" is the answer. A
 * deleted count answers it with silence.
 */
export async function rejectCount(opts: {
  countId: string;
  reviewerId: string;
  note?: string;
}): Promise<void> {
  await db.updateDocument(DB_ID, 'stock_counts', opts.countId, {
    status: 'rejected',
    reviewed_by: opts.reviewerId,
    reviewed_at: new Date().toISOString(),
    review_note: opts.note?.trim() ?? '',
  });
}

/* ---------------------------------------------------------- makers in bulk */

/**
 * Write a read-back list of makers.
 *
 * Rows whose code is already on file are updated rather than refused — see
 * `readMakerImport`, which decides that and says so before anything is
 * written. A blank commission leaves whatever the maker already had, so a file
 * correcting phone numbers cannot silently reset everybody's terms to the
 * house default.
 */
export async function importMakers(opts: {
  venueId: string;
  makers: ImportMaker[];
  existing: { $id: string; code: string }[];
  defaultCommissionBp: number;
}): Promise<{ created: number; updated: number; failed: { code: string; why: string }[] }> {
  const byCode = new Map(opts.existing.map((e) => [e.code.toUpperCase(), e.$id]));
  let created = 0;
  let updated = 0;
  const failed: { code: string; why: string }[] = [];

  for (const m of opts.makers) {
    const payload: Record<string, unknown> = {
      venue_id: opts.venueId,
      code: m.code,
      name: m.name,
      phone: m.phone,
      email: m.email,
      address: m.address,
      notes: m.notes,
      payout_method: m.payoutMethod,
      payout_details: m.payoutDetails,
      active: true,
    };

    /*
      Terms are only touched when the file says something about them.

      A file put together to correct four phone numbers must not reset every
      maker's rate to the house default on its way through. Absent means "leave
      it as it is", which is the only reading that makes a partial file safe.
    */
    const existingId = byCode.get(m.code.toUpperCase());
    if (m.commissionFlat > 0) {
      payload.commission_flat = m.commissionFlat;
      payload.commission_bp = 0;
    } else if (m.commissionBp !== null) {
      payload.commission_bp = m.commissionBp;
      payload.commission_flat = 0;
    } else if (!existingId) {
      // A new maker has to start somewhere, and the house rate is the answer.
      payload.commission_bp = opts.defaultCommissionBp;
      payload.commission_flat = 0;
    }

    try {
      if (existingId) {
        await db.updateDocument(DB_ID, 'consignors', existingId, payload);
        updated += 1;
      } else {
        await db.createDocument(DB_ID, 'consignors', ID.unique(), payload);
        created += 1;
      }
    } catch (e) {
      failed.push({ code: m.code, why: e instanceof Error ? e.message : 'could not be saved' });
    }
  }

  return { created, updated, failed };
}
