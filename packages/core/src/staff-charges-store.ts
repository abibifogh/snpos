import { db, DB_ID, ID, Query, Permission, Role, listAll, listByIds, tryWrite } from './client';
import {
  approveBarCount, countsForShift, loadLocations, adjustLevel, loadRecipes,
} from './stock';
import { approveCount, countLines, moveStock } from './consignment';
import type { ProductVariant } from './consignment';
import { filedCounts, isPending, countSide, isStoreCount, STORE_COUNT_PREFIX } from './bar-count';
import { lineUndecided } from './stocktake';
import { saleLocation } from './locations';
import type { Module } from './access';
import {
  chargeProblem, chargeAmount, settleProblem, foundAmount, afterSettle, chargeLeft, sellingPrices, creditMatches, isCredit,
} from './staff-charges';
import type { StaffCharge, StaffSettlement, SettleKind, PriceBasis, ChargeDirection } from './staff-charges';

/**
 * Reading and writing staff charges. The rules are in staff-charges.ts.
 *
 * Every row is written readable by the person it is about, so their own till
 * can tell them what they owe; managers read them all through the collection.
 */

export interface ChargePerson { $id: string; user_id?: string | null; display_name: string }

const readableBy = (person: ChargePerson): string[] =>
  person.user_id ? [Permission.read(Role.user(person.user_id))] : [];

/**
 * What one unit of each shelf item sells for, from the drinks and dishes that
 * use it. Items nothing on the menu sells are left out; see sellingPrices.
 */
export async function loadSellingPrices(ingredientIds: string[]): Promise<Record<string, { price: number; from: string }>> {
  if (ingredientIds.length === 0) return {};
  const wanted = new Set(ingredientIds);
  const all = await loadRecipes();
  // Every row of the drinks that use these, so a cocktail that also takes
  // juice and syrup can be told from the item sold on its own.
  const drinks = new Set(all.filter((r) => wanted.has(r.ingredient_id)).map((r) => r.menu_item_id ?? ''));
  const mine = all.filter((r) => drinks.has(r.menu_item_id ?? ''));
  const [items, variants] = await Promise.all([
    listByIds<{ $id: string; name?: string; price?: number }>('menu_items', '$id', [...new Set(mine.map((r) => r.menu_item_id ?? '').filter(Boolean))]),
    listByIds<{ $id: string; label?: string; price?: number }>('product_variants', '$id', [...new Set(mine.map((r) => r.variant_id ?? '').filter(Boolean))]),
  ]);
  return sellingPrices(ingredientIds, mine, items, variants);
}

/** Selling price and cost of one unit of a shelf item, for the charge form. */
export async function barChargePrices(ingredientId: string): Promise<{
  selling: number | null;
  sellingFrom: string;
  cost: number;
}> {
  const [ing, prices] = await Promise.all([
    db.getDocument(DB_ID, 'ingredients', ingredientId).catch(() => null) as Promise<{ base_unit_cost?: number } | null>,
    loadSellingPrices([ingredientId]).catch(() => ({} as Record<string, { price: number; from: string }>)),
  ]);
  const sell = prices[ingredientId];
  return { selling: sell?.price ?? null, sellingFrom: sell?.from ?? '', cost: Math.round(ing?.base_unit_cost ?? 0) };
}

/**
 * Charge one short line of a bar, kitchen or store-room count to a person.
 *
 * The charge is written first and the line approved second, so a line is
 * never corrected without the charge that explains it: if the approval does
 * not go through, the charge is taken back out and the line stays waiting.
 */
export async function chargeBarLine(opts: {
  venueId: string;
  shiftId: string;
  phase: 'open' | 'close';
  lineId: string;
  person: ChargePerson;
  qty: number;
  unitPrice: number;
  basis: PriceBasis;
  note?: string;
  userId: string;
  itemName: string;
}): Promise<StaffCharge> {
  const count = filedCounts(await countsForShift(opts.shiftId)).find((c) => c.phase === opts.phase);
  const line = count?.lines.find((l) => l.$id === opts.lineId);
  if (!count || !line) throw new Error('That line could not be found.');
  if (!isPending(line)) throw new Error('That line has already been decided.');
  // Short is owed; over is credited. See creditMatches.
  const direction: ChargeDirection = (line.variance_qty ?? 0) > 0 ? 'credit' : 'owed';
  const short = Math.abs(line.variance_qty ?? 0);
  const problem = chargeProblem({ personId: opts.person.$id, qty: opts.qty, short, unitPrice: opts.unitPrice, direction });
  if (problem) throw new Error(problem);

  const places = await loadLocations(opts.venueId);
  const roomId = isStoreCount(opts.shiftId) ? opts.shiftId.slice(STORE_COUNT_PREFIX.length) : undefined;
  const side = countSide(count.lines) as Module;
  const shelf = places.find((l) => l.$id === roomId) ?? saleLocation(places, side);

  const charge = await db.createDocument(DB_ID, 'staff_charges', ID.unique(), {
    venue_id: opts.venueId,
    person_id: opts.person.$id,
    person_user_id: opts.person.user_id ?? '',
    person_name: opts.person.display_name,
    source: 'bar_count',
    direction,
    count_ref: `${opts.shiftId}|${opts.phase}`,
    line_id: line.$id,
    module: side,
    item_name: opts.itemName,
    ingredient_id: line.ingredient_id,
    location_id: shelf?.$id ?? '',
    qty: opts.qty,
    unit_price: Math.round(opts.unitPrice),
    amount: chargeAmount(opts.qty, opts.unitPrice),
    price_basis: opts.basis,
    note: (opts.note ?? '').trim().slice(0, 300),
    charged_by: opts.userId,
    charged_at: new Date().toISOString(),
    settled_total: 0,
    status: 'open',
  }, readableBy(opts.person)) as unknown as StaffCharge;

  try {
    const { failed } = await approveBarCount({
      venueId: opts.venueId, shiftId: opts.shiftId, phase: opts.phase, userId: opts.userId, lineIds: [line.$id],
    });
    if (failed > 0) throw new Error(`${opts.itemName} could not be applied to the shelf. Nothing was charged.`);
  } catch (e) {
    await tryWrite(db.deleteDocument(DB_ID, 'staff_charges', charge.$id));
    throw e;
  }
  await tryWrite(db.updateDocument(DB_ID, 'shift_stock_checks', line.$id, { charge_id: charge.$id }));
  await applyCredits(opts.venueId, opts.person.$id, opts.userId).catch(() => undefined);
  return charge;
}

/** The same, for one short line of a shop stocktake. */
export async function chargeShopLine(opts: {
  venueId: string;
  countId: string;
  lineId: string;
  person: ChargePerson;
  qty: number;
  unitPrice: number;
  basis: PriceBasis;
  note?: string;
  userId: string;
}): Promise<StaffCharge> {
  const line = (await countLines(opts.countId)).find((l) => l.$id === opts.lineId);
  if (!line) throw new Error('That line could not be found.');
  if (!lineUndecided(line)) throw new Error('That line has already been decided.');
  const direction: ChargeDirection = line.delta > 0 ? 'credit' : 'owed';
  const problem = chargeProblem({ personId: opts.person.$id, qty: opts.qty, short: Math.abs(line.delta), unitPrice: opts.unitPrice, direction });
  if (problem) throw new Error(problem);

  const name = [line.name_snapshot, line.variant_label].filter(Boolean).join(' · ');
  const charge = await db.createDocument(DB_ID, 'staff_charges', ID.unique(), {
    venue_id: opts.venueId,
    person_id: opts.person.$id,
    person_user_id: opts.person.user_id ?? '',
    person_name: opts.person.display_name,
    source: 'shop_count',
    direction,
    count_ref: opts.countId,
    line_id: line.$id,
    module: 'craft',
    item_name: name,
    menu_item_id: line.menu_item_id,
    variant_id: line.variant_id ?? '',
    qty: opts.qty,
    unit_price: Math.round(opts.unitPrice),
    amount: chargeAmount(opts.qty, opts.unitPrice),
    price_basis: opts.basis,
    note: (opts.note ?? '').trim().slice(0, 300),
    charged_by: opts.userId,
    charged_at: new Date().toISOString(),
    settled_total: 0,
    status: 'open',
  }, readableBy(opts.person)) as unknown as StaffCharge;

  try {
    const { failed } = await approveCount({ countId: opts.countId, reviewerId: opts.userId, lineIds: [line.$id] });
    if (failed > 0) throw new Error(`${name} could not be applied to the shelf. Nothing was charged.`);
  } catch (e) {
    await tryWrite(db.deleteDocument(DB_ID, 'staff_charges', charge.$id));
    throw e;
  }
  await tryWrite(db.updateDocument(DB_ID, 'stock_count_lines', line.$id, { charge_id: charge.$id }));
  await applyCredits(opts.venueId, opts.person.$id, opts.userId).catch(() => undefined);
  return charge;
}

/**
 * Set this person's credits against what they owe, oldest first.
 *
 * Run after every charge and credit, so a credit is used the moment there is
 * something to use it on. Each match is written as a settlement of the
 * shortage pointing at the credit, and both rows carry what is left of them.
 */
async function applyCredits(venueId: string, personId: string, userId: string): Promise<number> {
  const rows = await listAll<StaffCharge>('staff_charges', [Query.equal('person_id', personId), Query.equal('status', 'open')]);
  const matches = creditMatches(rows);
  for (const m of matches) {
    const owed = rows.find((r) => r.$id === m.chargeId)!;
    const credit = rows.find((r) => r.$id === m.creditId)!;
    await db.createDocument(DB_ID, 'staff_charge_settlements', ID.unique(), {
      venue_id: venueId,
      charge_id: owed.$id,
      person_id: personId,
      kind: 'credit',
      amount: m.amount,
      qty_found: 0,
      shift_id: '',
      method_id: '',
      credit_id: credit.$id,
      note: `Set against ${credit.item_name} over`,
      recorded_by: userId,
      recorded_at: new Date().toISOString(),
    }, owed.person_user_id ? [Permission.read(Role.user(owed.person_user_id))] : []);
    const nextOwed = afterSettle(owed, m.amount);
    const nextCredit = afterSettle(credit, m.amount);
    await db.updateDocument(DB_ID, 'staff_charges', owed.$id, nextOwed);
    await db.updateDocument(DB_ID, 'staff_charges', credit.$id, nextCredit);
    owed.settled_total = nextOwed.settled_total; owed.status = nextOwed.status;
    credit.settled_total = nextCredit.settled_total; credit.status = nextCredit.status;
  }
  return matches.length;
}

/**
 * Record something done about a charge.
 *
 * "Found" puts the pieces back on the shelf they were charged off, then takes
 * what they were charged each off what is owed. The charge row is read again
 * first, so two people settling the same charge cannot take it below nothing.
 */
export async function settleCharge(opts: {
  venueId: string;
  chargeId: string;
  kind: SettleKind;
  amount: number;
  qtyFound?: number;
  shiftId?: string;
  methodId?: string;
  note?: string;
  userId: string;
  isAdmin: boolean;
}): Promise<{ settled: number; left: number }> {
  const charge = await db.getDocument(DB_ID, 'staff_charges', opts.chargeId) as unknown as StaffCharge & { venue_id?: string };
  const left = chargeLeft(charge);
  const problem = settleProblem({
    kind: opts.kind, amount: opts.amount, left, isAdmin: opts.isAdmin, note: opts.note ?? '',
    qtyFound: opts.qtyFound, charged: charge.qty, isCredit: isCredit(charge),
  });
  if (problem) throw new Error(problem);
  if (opts.kind === 'cash' && (!opts.shiftId || !opts.methodId)) {
    throw new Error('Cash has to go into a drawer: choose the shift it was paid into.');
  }

  const amount = opts.kind === 'found' ? foundAmount(opts.qtyFound ?? 0, charge.unit_price, left) : Math.round(opts.amount);

  if (opts.kind === 'found') {
    const qty = opts.qtyFound ?? 0;
    if (charge.ingredient_id) {
      await db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
        venue_id: opts.venueId,
        ingredient_id: charge.ingredient_id,
        type: 'count_correction',
        qty_delta: qty,
        unit_cost: 0,
        location_id: charge.location_id ?? '',
        ref_type: 'staff_charge',
        ref_id: charge.$id,
        shift_id: '',
        created_by: opts.userId,
        note: `Found after being charged to ${charge.person_name}`,
      });
      if (charge.location_id) {
        await adjustLevel({ ingredientId: charge.ingredient_id, locationId: charge.location_id, delta: qty });
      } else {
        const now = await db.getDocument(DB_ID, 'ingredients', charge.ingredient_id).catch(() => null) as { current_qty?: number } | null;
        await tryWrite(db.updateDocument(DB_ID, 'ingredients', charge.ingredient_id, {
          current_qty: Number(((now?.current_qty ?? 0) + qty).toFixed(4)),
        }));
      }
    } else if (charge.menu_item_id) {
      const variant = charge.variant_id
        ? await db.getDocument(DB_ID, 'product_variants', charge.variant_id).catch(() => null) as ProductVariant | null
        : null;
      const item = charge.variant_id
        ? null
        : await db.getDocument(DB_ID, 'menu_items', charge.menu_item_id).catch(() => null) as { $id: string; on_hand?: number } | null;
      await moveStock({
        venueId: opts.venueId, menuItemId: charge.menu_item_id, variant, item,
        type: 'adjustment', qtyDelta: qty, unitPrice: charge.unit_price,
        refType: 'staff_charge', refId: charge.$id, userId: opts.userId,
        note: `Found after being charged to ${charge.person_name}`,
      });
    }
  }

  await db.createDocument(DB_ID, 'staff_charge_settlements', ID.unique(), {
    venue_id: opts.venueId,
    charge_id: charge.$id,
    person_id: charge.person_id,
    kind: opts.kind,
    amount,
    qty_found: opts.kind === 'found' ? (opts.qtyFound ?? 0) : 0,
    shift_id: opts.kind === 'cash' ? (opts.shiftId ?? '') : '',
    method_id: opts.kind === 'cash' ? (opts.methodId ?? '') : '',
    note: (opts.note ?? '').trim().slice(0, 300),
    recorded_by: opts.userId,
    recorded_at: new Date().toISOString(),
  }, charge.person_user_id ? [Permission.read(Role.user(charge.person_user_id))] : []);

  const next = afterSettle(charge, amount);
  await db.updateDocument(DB_ID, 'staff_charges', charge.$id, next);
  return { settled: amount, left: Math.max(0, charge.amount - next.settled_total) };
}

/** Every charge on the business, newest first. */
export const loadStaffCharges = (venueId: string): Promise<StaffCharge[]> =>
  listAll<StaffCharge>('staff_charges', [Query.equal('venue_id', venueId)])
    .then((rows) => rows.sort((a, b) => b.charged_at.localeCompare(a.charged_at)));

/** Everything done about these charges, oldest first. */
export const loadSettlements = (chargeIds: string[]): Promise<StaffSettlement[]> =>
  chargeIds.length === 0
    ? Promise.resolve([])
    : listByIds<StaffSettlement>('staff_charge_settlements', 'charge_id', chargeIds)
      .then((rows) => rows.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at)));

/**
 * What the person signed in owes, for their till. Only their own rows come
 * back: each is readable by them and nobody else below a manager.
 *
 * Null when it could not be read, so the till says nothing rather than
 * telling somebody they owe nothing.
 */
export const myOpenCharges = (userId: string): Promise<StaffCharge[] | null> =>
  userId
    ? listAll<StaffCharge>('staff_charges', [Query.equal('person_user_id', userId), Query.equal('status', 'open')])
      .catch(() => null)
    : Promise.resolve([]);
