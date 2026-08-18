import { db, DB_ID, ID, Query, listAll } from './client';
import type { PurchaseRow } from './price-history';
import type { Module } from './access';
import { variancesIn, wasCountedBar, shiftCounted } from './bar-count';
import { levelFor, transferQty, transferMovements, purchaseLocation, saleLocation } from './locations';
import type { StockLocation, LocationStock, TransferLine } from './locations';
import type { LevelRow } from './level-import';
import type { BarCountLine } from './bar-count';
import type { Doc } from './types';
import type { OrderItem } from './orders';

export interface Ingredient extends Doc {
  venue_id: string;
  name: string;
  unit: string;
  base_unit_cost: number;
  current_qty: number;
  par_level: number;
  low_threshold?: number;
  critical: boolean;
  supplier_id?: string;
  category?: string;
  /** Which side of the business keeps this on its shelves. Absent is kitchen. */
  module?: Module;
  /** The rule a cook reads at the shift-end check, in the restaurant's words. */
  check_guide?: string;
  /** Which expense category a delivery of this counts as. */
  expense_category_key?: string;
  /**
   * Whether somebody has to count this at the end of a shift.
   *
   * Absent means yes. Transport, a delivery fee, a repair: things worth
   * itemising on a shop run so the spending is not one lump called "other",
   * with nothing on a shelf to walk over and look at.
   */
  counted_at_close?: boolean;
  /**
   * How many counting units come in one pack, and what the pack is called.
   *
   * A bar buys bottles and pours shots. Absent or 0 or 1 means it is bought in
   * whatever it is counted in, which is every kitchen ingredient there has
   * ever been. See packs.ts.
   */
  pack_size?: number;
  pack_name?: string;
  /** Counted at the start and end of every shift. See shiftCounted. */
  count_each_shift?: boolean;
  consecutive_low_count?: number;
  consecutive_low_since?: string;
  last_low_severity?: 'low' | 'out';
  active: boolean;
}

export interface Recipe extends Doc {
  menu_item_id?: string;
  addon_option_id?: string;
  ingredient_id: string;
  qty_per_unit: number;
  wastage_bp: number;
}

export interface StockMovement extends Doc {
  venue_id: string;
  ingredient_id: string;
  type: string;
  qty_delta: number;
  unit_cost: number;
  ref_type?: string;
  ref_id?: string;
  shift_id?: string;
  created_by?: string;
  note?: string;
}

/**
 * How much of each ingredient a set of sold items should have consumed.
 *
 * "Should have" is the operative phrase: this is the theoretical figure that a
 * physical count is later measured against. The gap between them is the whole
 * point; it is where waste, over-portioning and theft show up.
 */
export function theoreticalUsage(items: OrderItem[], recipes: Recipe[]): Record<string, number> {
  const usage: Record<string, number> = {};

  for (const item of items) {
    if (item.status === 'void') continue;

    const forItem = recipes.filter((r) => r.menu_item_id === item.menu_item_id);
    for (const r of forItem) {
      // Wastage covers trim and spillage, the peel on an onion is consumed
      // even though it never reaches the plate.
      const perUnit = r.qty_per_unit * (1 + (r.wastage_bp || 0) / 10000);
      usage[r.ingredient_id] = (usage[r.ingredient_id] ?? 0) + perUnit * item.qty;
    }

    // Add-ons consume too: an extra portion of chicken is real chicken.
    const addons: { option_id: string }[] = item.addons ? JSON.parse(item.addons) : [];
    for (const a of addons) {
      for (const r of recipes.filter((x) => x.addon_option_id === a.option_id)) {
        const perUnit = r.qty_per_unit * (1 + (r.wastage_bp || 0) / 10000);
        usage[r.ingredient_id] = (usage[r.ingredient_id] ?? 0) + perUnit * item.qty;
      }
    }
  }
  return usage;
}

/** Deplete stock for what a shift sold, and record why each figure moved. */
export async function depleteForShift(
  venueId: string,
  shiftId: string,
  items: OrderItem[],
  recipes: Recipe[],
  ingredients: Ingredient[],
  userId: string,
): Promise<Record<string, number>> {
  const usage = theoreticalUsage(items, recipes);
  const byId = new Map(ingredients.map((i) => [i.$id, i]));

  for (const [ingredientId, qty] of Object.entries(usage)) {
    const ing = byId.get(ingredientId);
    if (!ing || qty <= 0) continue;
    /*
      A bar's bottles have already been poured.

      The bar deducts as each drink is paid for rather than at close, because
      the point of watching a gin level is to see it running out before
      somebody orders the drink it makes. Depleting it again here would take
      every measure off twice and report a bar that loses half its stock every
      night. See pourFromBottles in order-guard.
    */
    if (ing.module === 'bar') continue;

    await db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
      venue_id: venueId,
      ingredient_id: ingredientId,
      type: 'sale_depletion',
      qty_delta: -qty,
      unit_cost: ing.base_unit_cost,
      ref_type: 'shift',
      ref_id: shiftId,
      shift_id: shiftId,
      created_by: userId,
    });

    await db.updateDocument(DB_ID, 'ingredients', ingredientId, {
      current_qty: Number((ing.current_qty - qty).toFixed(4)),
    });
  }
  return usage;
}

/**
 * Put bought stock on the shelf.
 *
 * The counterpart to depletion, and written the same way: a movement recording
 * that it happened, then the running quantity. The movement is the record; the
 * quantity on the ingredient is a convenience that can always be rebuilt from
 * the movements if it ever drifts.
 *
 * When a unit cost is given it becomes the ingredient's cost from now on. What
 * you last paid is the honest basis for valuing what is on the shelf and for
 * telling you what a dish costs to make.
 */
export async function receiveStock(opts: {
  venueId: string;
  ingredient: Ingredient;
  qty: number;
  unitCost?: number;
  refType: string;
  refId: string;
  shiftId?: string;
  createdBy?: string;
  note?: string;
}): Promise<void> {
  const { venueId, ingredient, qty, unitCost, refType, refId, shiftId, createdBy, note } = opts;
  if (qty <= 0) return;

  /*
    A delivery is put down in the store, not behind the bar.

    Where it lands is decided in one place — see locationForMovement — because
    the day the till decides a sale comes off the store while the count checks
    the counter is the day the two stop being reconcilable, with nothing on
    screen to say which is wrong.

    A business with one location has both answers the same, which is why none
    of this changes anything for a kitchen that has never heard of a store room.
  */
  const where = purchaseLocation(
    await loadLocations(venueId),
    (ingredient as { module?: string }).module ?? 'kitchen',
  );

  await db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
    venue_id: venueId,
    ingredient_id: ingredient.$id,
    type: 'purchase',
    qty_delta: qty,
    unit_cost: unitCost ?? ingredient.base_unit_cost,
    location_id: where?.$id ?? '',
    ref_type: refType,
    ref_id: refId,
    shift_id: shiftId ?? '',
    created_by: createdBy ?? '',
    note: note ?? '',
  });

  if (where) {
    // The level moves and the total follows from it. See adjustLevel: the
    // total is the sum of the places, never a second record of the same fact.
    await adjustLevel({ ingredientId: ingredient.$id, locationId: where.$id, delta: qty });
    if (unitCost && unitCost > 0) {
      await db.updateDocument(DB_ID, 'ingredients', ingredient.$id, { base_unit_cost: unitCost })
        .catch(() => undefined);
    }
  } else {
    // No locations set up at all, which is every venue until somebody makes
    // one. Exactly the old behaviour, so nothing has to be configured before
    // a delivery can be recorded.
    await db.updateDocument(DB_ID, 'ingredients', ingredient.$id, {
      current_qty: Number((ingredient.current_qty + qty).toFixed(4)),
      ...(unitCost && unitCost > 0 ? { base_unit_cost: unitCost } : {}),
    });
  }
}

/**
 * What one portion of a dish costs in ingredients.
 *
 * Wastage counts: the part of an onion you throw away was still bought and
 * paid for, so leaving it out would flatter every margin on the menu.
 */
export function recipeCost(recipes: Recipe[], ingredients: Ingredient[]): number {
  const byId = new Map(ingredients.map((i) => [i.$id, i]));
  return Math.round(
    recipes.reduce((sum, r) => {
      const ing = byId.get(r.ingredient_id);
      if (!ing) return sum;
      return sum + r.qty_per_unit * (1 + (r.wastage_bp || 0) / 10000) * ing.base_unit_cost;
    }, 0),
  );
}

export type StockLevel = 'ok' | 'low' | 'out';

/**
 * The amount at or below which something counts as low.
 *
 * Either set explicitly on the ingredient, or a share of its par level. Named
 * so the shift-end count can show the same number the alerts are judged
 * against, rather than working it out a second time and disagreeing.
 */
export const lowThresholdFor = (ing: Pick<Ingredient, 'low_threshold' | 'par_level'>, lowDefaultBp = 3000) =>
  ing.low_threshold ?? (ing.par_level * lowDefaultBp) / 10000;

/** Where an ingredient sits against its own thresholds. */
export function levelOf(ing: Ingredient, lowDefaultBp = 3000): StockLevel {
  if (ing.current_qty <= 0) return 'out';
  return ing.current_qty <= lowThresholdFor(ing, lowDefaultBp) ? 'low' : 'ok';
}

/**
 * The same judgement, made from a number somebody has just counted.
 *
 * The point of counting rather than tapping is that the answer stops being an
 * opinion. Two cooks looking at the same four crates should file the same
 * status, and they will if the status comes from the number rather than from
 * how the night went.
 */
export function statusFromCount(qty: number, lowAt: number): 'OK' | 'LOW' | 'OUT' {
  if (!(qty > 0)) return 'OUT';
  return qty <= lowAt ? 'LOW' : 'OK';
}

export interface StockAlert {
  ingredient: Ingredient;
  level: 'low' | 'out';
  /** How many shifts running, counting this one. */
  consecutive: number;
  since?: string;
  isNew: boolean;
}

/**
 * Update each ingredient's run of consecutive low readings, and split the
 * result into first-time alerts and persistent ones.
 *
 * The split is the point. A first-time flag is routine restocking; the same
 * item low for the fourth shift running is a supply problem or something
 * leaving the building, and merging the two lists is how the second kind gets
 * lost in the noise of the first.
 */
export async function updateStockAlerts(
  ingredients: Ingredient[],
  lowDefaultBp: number,
  persistentThreshold: number,
  /**
   * What staff said at the shift-end check, keyed by ingredient.
   *
   * This overrides the arithmetic, and it has to. The running quantity only
   * moves when a recipe deplete it or somebody counts, so a cook tapping LOW
   * changed nothing at all: the number stayed where it was, `levelOf` read it
   * as fine, and the item was never flagged. OUT survived only because closing
   * a shift writes the quantity to zero, which is why out reached the email and
   * low never did.
   *
   * A person standing in front of the shelf outranks a figure derived from
   * recipes that may not even be set up.
   */
  reported: Record<string, 'OK' | 'LOW' | 'OUT'> = {},
): Promise<{ fresh: StockAlert[]; persistent: StockAlert[]; all: StockAlert[] }> {
  const fresh: StockAlert[] = [];
  const persistent: StockAlert[] = [];
  /**
   * Every flagged item, not just the two ends of the range.
   *
   * `fresh` is exactly one shift and `persistent` is three or more, so an
   * ingredient on its SECOND consecutive shift belonged to neither, and
   * anything reading only those two lists lost it. The shift-close email did
   * exactly that, which is how an item a cook had marked OUT could disappear
   * from the report on the night it mattered most.
   */
  const all: StockAlert[] = [];
  const now = new Date().toISOString();

  for (const ing of ingredients) {
    const said = reported[ing.$id];
    const level: StockLevel = said
      ? said === 'OK' ? 'ok' : said === 'LOW' ? 'low' : 'out'
      : levelOf(ing, lowDefaultBp);

    if (level === 'ok') {
      // Recovered: clear the run so a later dip reads as new rather than
      // inheriting a stale history.
      if ((ing.consecutive_low_count ?? 0) > 0) {
        await db.updateDocument(DB_ID, 'ingredients', ing.$id, {
          consecutive_low_count: 0,
          consecutive_low_since: null,
          last_low_severity: null,
        }).catch(() => undefined);
      }
      continue;
    }

    const count = (ing.consecutive_low_count ?? 0) + 1;
    const since = ing.consecutive_low_since || now;
    await db.updateDocument(DB_ID, 'ingredients', ing.$id, {
      consecutive_low_count: count,
      consecutive_low_since: since,
      last_low_severity: level,
    }).catch(() => undefined);

    const alert: StockAlert = { ingredient: ing, level, consecutive: count, since, isNew: count === 1 };
    all.push(alert);
    if (count >= persistentThreshold) persistent.push(alert);
    else if (count === 1) fresh.push(alert);
  }

  // Worst first: the longest-running problems, then anything out, then low.
  all.sort(
    (a, b) =>
      Number(b.consecutive >= persistentThreshold) - Number(a.consecutive >= persistentThreshold) ||
      Number(b.level === 'out') - Number(a.level === 'out') ||
      a.ingredient.name.localeCompare(b.ingredient.name),
  );

  return { fresh, persistent, all };
}

/**
 * Compare counted stock with what should be there, and raise a flag when the
 * gap is both proportionally and absolutely material.
 *
 * Both tests matter: 30% of a pinch of saffron is not worth a conversation,
 * and GHS 200 of rice is, even at 4%.
 */
export async function flagVariances(
  venueId: string,
  shiftId: string,
  counts: { ingredient: Ingredient; theoretical: number; counted: number; openingQty: number }[],
  thresholdBp: number,
  valueFloor: number,
  userId: string,
): Promise<number> {
  const periodStart = new Date().toISOString();
  let flagged = 0;

  for (const c of counts) {
    const varianceQty = c.counted - c.theoretical;
    const varianceValue = Math.round(Math.abs(varianceQty) * c.ingredient.base_unit_cost);
    const varianceBp = c.theoretical > 0 ? Math.round((Math.abs(varianceQty) / c.theoretical) * 10000) : 0;

    await db.createDocument(DB_ID, 'shift_stock_checks', ID.unique(), {
      venue_id: venueId,
      shift_id: shiftId,
      ingredient_id: c.ingredient.$id,
      opening_qty: c.openingQty,
      theoretical_qty: c.theoretical,
      counted_qty: c.counted,
      status: 'counted',
      status_source: 'manual',
      variance_qty: Number(varianceQty.toFixed(4)),
      variance_value: varianceValue,
      checked_by: userId,
    }).catch(() => undefined);

    if (varianceBp >= thresholdBp && varianceValue >= valueFloor) {
      flagged++;
      await db.createDocument(DB_ID, 'stock_flags', ID.unique(), {
        venue_id: venueId,
        ingredient_id: c.ingredient.$id,
        period_start: periodStart,
        period_end: periodStart,
        theoretical_usage: c.theoretical,
        actual_usage: c.counted,
        variance_qty: Number(varianceQty.toFixed(4)),
        variance_bp: varianceBp,
        variance_value: varianceValue,
        severity: varianceValue >= valueFloor * 4 ? 'high' : varianceValue >= valueFloor * 2 ? 'medium' : 'low',
        likely_causes: varianceQty < 0
          ? 'Over-portioning, unrecorded waste, or stock leaving unrecorded'
          : 'Under-portioning, a delivery not booked in, or a miscount',
        status: 'open',
      }).catch(() => undefined);
    }

    // Counting is also the moment the book figure is corrected to reality.
    if (c.counted !== c.ingredient.current_qty) {
      await db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
        venue_id: venueId,
        ingredient_id: c.ingredient.$id,
        type: 'count_adjustment',
        qty_delta: Number((c.counted - c.ingredient.current_qty).toFixed(4)),
        unit_cost: c.ingredient.base_unit_cost,
        ref_type: 'shift',
        ref_id: shiftId,
        shift_id: shiftId,
        created_by: userId,
      }).catch(() => undefined);
      await db.updateDocument(DB_ID, 'ingredients', c.ingredient.$id, { current_qty: c.counted }).catch(() => undefined);
    }
  }

  return flagged;
}

/**
 * One side's larder, or the whole building when no side is named.
 *
 * Filtered here rather than in the query on purpose: every ingredient written
 * before `module` existed has no value for it, so asking the database for
 * module = kitchen would silently miss the entire original larder. Absent
 * means kitchen, and that has to be decided in code.
 */
export const loadIngredients = async (venueId: string, module?: Module): Promise<Ingredient[]> => {
  const rows = await listAll<Ingredient>('ingredients', [Query.equal('venue_id', venueId)]);
  return module ? rows.filter((i) => (i.module ?? 'kitchen') === module) : rows;
};

export const loadRecipes = () => listAll<Recipe>('recipes');

export interface StockCheckRow {
  $id: string;
  name: string;
  critical: boolean;
  unit?: string;
  parLevel?: number;
  lowAt?: number;
  onHand?: number;
  /** Heading this sits under. Blank for anything uncategorised. */
  group?: string;
  /** The written rule, if somebody has set one. */
  guide?: string;
}

/**
 * The shift-end stock list, in the order it should be worked through.
 *
 * Grouped the way the shelves are, because that is the order somebody walks
 * the kitchen in. A single alphabetical list of forty ingredients means
 * crossing the room for the letter B and crossing back for the letter C, and
 * the thing that gets skipped is whatever is furthest away.
 *
 * Built here rather than in each screen. The terminal and the kitchen display
 * both ask this question, and two copies of it is two chances for the list a
 * cook sees to depend on which device they picked up.
 */
export async function stockCheckRows(venueId: string, module: Module = 'kitchen'): Promise<StockCheckRow[]> {
  const [ingredients, categories] = await Promise.all([
    loadIngredients(venueId),
    listAll<{ key: string; name: string; sort?: number; active?: boolean }>('ingredient_categories').catch(() => []),
  ]);

  const order = new Map(categories.map((c, i) => [c.key, c.sort ?? i]));
  const label = new Map(categories.map((c) => [c.key, c.name]));
  // Anything uncategorised goes last under its own heading, rather than
  // silently at the top where it reads as belonging to nothing.
  const rank = (key?: string) => (key && order.has(key) ? (order.get(key) as number) : 9999);

  /*
    A shift's check asks for what is counted every shift.

    "At stocktake" has to mean at stocktake ONLY, or it is not a third answer
    at all — a spirit marked that way would still be on the sheet twice a day,
    which is the thing somebody chose it to avoid.

    shiftCounted keeps the old behaviour for anyone who has marked nothing:
    with no choice made, the check asks for everything, exactly as it did.
  */
  return shiftCounted(ingredients)
    // Everything active that is actually on a shelf. A list with a taxi in it
    // is a list people learn to tap through, which costs the count on the
    // things that do matter.
    // This side's shelves only. A bar counting rice and a kitchen counting gin
    // are both counting somebody else's larder, and a sheet with forty lines
    // on it that are not yours is a sheet people tap through.
    .filter((i) => i.active && i.counted_at_close !== false && (i.module ?? 'kitchen') === module)
    .sort(
      (a, b) =>
        rank(a.category) - rank(b.category) ||
        (a.category ?? '').localeCompare(b.category ?? '') ||
        // Critical items lead their group: if service stops without it, it
        // belongs at the top of a list somebody is working through at the end
        // of a long day.
        Number(b.critical) - Number(a.critical) ||
        a.name.localeCompare(b.name),
    )
    .map((i) => ({
      $id: i.$id,
      name: i.name,
      critical: i.critical,
      unit: i.unit,
      lowAt: i.low_threshold ?? undefined,
      parLevel: i.par_level || undefined,
      onHand: Math.round(i.current_qty * 100) / 100,
      group: i.category ? label.get(i.category) ?? i.category : '',
      guide: i.check_guide?.trim() || undefined,
    }));
}

/**
 * Every purchase of one ingredient, newest first from the database's point of
 * view and re-sorted by `priceHistory` into the order a price moves in.
 *
 * Read from stock movements rather than from expense lines, because those are
 * not the only way stock arrives at a price: a delivery received directly, a
 * correction, an opening balance. The question is "what has this cost me", and
 * answering it from one of the two routes would quietly leave out the other.
 */
export async function purchasesFor(ingredientId: string, limit = 200): Promise<PurchaseRow[]> {
  const rows = await listAll<{
    $createdAt: string;
    qty_delta: number;
    unit_cost: number;
    ref_type?: string;
    ref_id?: string;
    note?: string;
  }>('stock_movements', [
    Query.equal('ingredient_id', ingredientId),
    Query.equal('type', 'purchase'),
    Query.orderDesc('$createdAt'),
    Query.limit(limit),
  ]).catch(() => []);

  return rows.map((r) => ({
    at: r.$createdAt,
    qty: r.qty_delta,
    unitCost: r.unit_cost,
    refType: r.ref_type,
    refId: r.ref_id,
    note: r.note,
  }));
}

/* ------------------------------------------- what a bar accepts and hands over */

/**
 * The bar's shelves, as a sheet to walk with.
 *
 * Everything the bar counts, with what the system believes is there, ready to
 * be grouped by unit. Not filtered to what is expected to be in stock: "there
 * should be none and there are two" is a real finding — a bottle put back, a
 * delivery nobody booked in — and a sheet that only lists what it expects can
 * never report it.
 */
export async function barCountSheet(venueId: string, locationId?: string): Promise<BarCountLine[]> {
  const [ingredients, locations] = await Promise.all([loadIngredients(venueId), loadLocations(venueId)]);
  /*
    ONE PLACE is counted, not the business.

    A bar with nine tonics behind it and a store room holding thirty-three is
    not "forty-two tonics" to the person counting — they are counting the nine,
    and checking them against forty-two would report a shortage of thirty-three
    every single night.

    Which place is now asked for rather than assumed. The bar is counted every
    shift and the store room every few weeks, and a store room that could only
    be counted as part of the bar could not be counted at all: its stock would
    show up as an enormous surplus against the counter's expected level.
  */
  const counter = locations.find((l) => l.$id === locationId) ?? saleLocation(locations, 'bar');
  const levels = counter ? await loadLevels([counter.$id]) : [];

  /*
    The shift's narrowing applies to the BAR, not to a store room.

    What a bartender is asked for twice a day is the bottled drinks. A store
    room is counted every few weeks and the whole point is the spirits — so
    narrowing it to the shift list would leave the one thing being counted off
    the sheet entirely, and the count would come back saying the store holds
    nothing but beer.
  */
  const onShelf = ingredients.filter((i) => i.active && (i.module ?? 'kitchen') === 'bar');
  const rows = counter?.kind === 'store' ? onShelf : shiftCounted(onShelf);

  return rows
    .map((i) => ({
      ingredientId: i.$id,
      name: i.name,
      unit: i.unit,
      // Without a location set up, the business total IS the bar's, which is
      // what it was before any of this existed.
      expected: counter ? levelFor(levels, i.$id, counter.$id) : i.current_qty,
      unitCost: i.base_unit_cost,
    }));
}

/**
 * Write a count of one room.
 *
 * Two different events wear the same form, and the difference is the shift.
 *
 * Counting THE BAR is a shift event. Somebody accepts the stock at the start
 * and hands it over at the end, and the variance at close against what the
 * pours said should be left is the figure the whole bar stock system exists
 * to produce. It is filed against the shift because it is a fact about that
 * shift and about the person who worked it.
 *
 * Counting a STORE ROOM is not. Nobody pours from a store room, no shift
 * accepts it and no shift hands it over — it is walked every few weeks
 * because somebody wants to know what is in there. Filing it against
 * whichever shift happened to be open would attribute a month of drift to one
 * bartender's evening, and requiring a shift at all would mean the room could
 * only be counted while the bar was trading.
 *
 * So a count with no shift writes what a stocktake writes: the movement that
 * explains the change, and the level it found. No shift check, because there
 * is no shift to make a claim about.
 */
export async function saveBarCount(opts: {
  venueId: string;
  /** The shift this belongs to. Absent for a store room, which belongs to none. */
  shiftId?: string;
  /** Which place was walked. Absent counts the bar itself. */
  locationId?: string;
  phase: 'open' | 'close';
  lines: BarCountLine[];
  userId: string;
}): Promise<{ written: number; shortValue: number }> {
  const places = await loadLocations(opts.venueId);
  const counter = places.find((l) => l.$id === opts.locationId) ?? saleLocation(places, 'bar');
  const variances = variancesIn(opts.lines);
  const shortValue = variances.filter((v) => v.delta < 0).reduce((s, v) => s + v.value, 0);
  let written = 0;

  for (const line of opts.lines) {
    if (!wasCountedBar(line)) continue;
    const counted = Number((line.countedText ?? '').trim());
    const variance = Number((counted - line.expected).toFixed(4));

    // Only where there is a shift to make the claim about. A store room's
    // count is not a statement about anybody's evening.
    if (opts.shiftId) await db.createDocument(DB_ID, 'shift_stock_checks', ID.unique(), {
      venue_id: opts.venueId,
      shift_id: opts.shiftId,
      ingredient_id: line.ingredientId,
      phase: opts.phase,
      opening_qty: line.expected,
      theoretical_qty: line.expected,
      counted_qty: counted,
      status: counted <= 0 ? 'OUT' : 'OK',
      status_source: 'manual_override',
      variance_qty: variance,
      variance_value: Math.round(Math.abs(variance) * line.unitCost),
      checked_by: opts.userId,
      note: line.note ?? '',
    }).catch(() => undefined);

    /*
      A movement for the difference, not just a note about it.

      Without one the shelf would jump and the history would not explain why.
      A count correction is a real movement of stock — it is the one that says
      "this is what is actually here" — and leaving it out is what makes a
      stock history stop adding up.
    */
    if (variance !== 0) {
      await db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
        venue_id: opts.venueId,
        ingredient_id: line.ingredientId,
        type: 'count_correction',
        qty_delta: variance,
        unit_cost: line.unitCost,
        location_id: counter?.$id ?? '',
        // A stocktake refers to the room it counted; a shift count refers to
        // the shift. Stamping a store room's correction with a shift id is
        // what would put a month of drift on one bartender's evening.
        ref_type: opts.shiftId ? 'shift' : 'stocktake',
        ref_id: opts.shiftId || (counter?.$id ?? ''),
        shift_id: opts.shiftId ?? '',
        created_by: opts.userId,
        note: opts.shiftId
          ? (opts.phase === 'open' ? 'Counted on opening' : 'Counted at close')
          : `Stocktake in ${counter?.name ?? 'the store'}`,
      }).catch(() => undefined);
    }

    /*
      A count sets the level where the person was standing.

      Not the business total: they counted the bar, and writing what they found
      over everything the business owns would erase the store room without
      anybody visiting it. adjustLevel puts the total back together from the
      places afterwards.
    */
    if (counter) {
      await adjustLevel({ ingredientId: line.ingredientId, locationId: counter.$id, delta: 0, setTo: counted });
    } else {
      await db.updateDocument(DB_ID, 'ingredients', line.ingredientId, {
        current_qty: counted,
      }).catch(() => undefined);
    }

    written += 1;
  }

  return { written, shortValue };
}

/** Whether this shift has already been counted in on the way in. */
export async function hasOpeningCount(shiftId: string): Promise<boolean> {
  const rows = await listAll<Doc>('shift_stock_checks', [
    Query.equal('shift_id', shiftId),
    Query.equal('phase', 'open'),
    Query.limit(1),
  ]).catch(() => []);
  return rows.length > 0;
}

/* -------------------------------------------------- where the stock actually is */

export const loadLocations = (venueId: string) =>
  listAll<StockLocation & Doc>('stock_locations', [Query.equal('venue_id', venueId)])
    .catch(() => [] as (StockLocation & Doc)[]);

export const loadLevels = (locationIds?: string[]) =>
  listAll<LocationStock & Doc>('stock_levels', locationIds?.length ? [Query.equal('location_id', locationIds)] : [])
    .catch(() => [] as (LocationStock & Doc)[]);

/**
 * Move one ingredient's level at one place, and keep the total in step.
 *
 * The total on the ingredient is the SUM of the places, so it is written here
 * rather than anywhere else — the moment two pieces of code both maintain it,
 * they disagree, and the disagreement is invisible because both figures look
 * authoritative.
 *
 * A level row is created on first use rather than seeded for every ingredient
 * at every location. Most things live in one place, and a row per ingredient
 * per location would be mostly zeros nobody wrote.
 */
export async function adjustLevel(opts: {
  ingredientId: string;
  locationId: string;
  delta: number;
  /** Set the level outright instead of moving it, for a count. */
  setTo?: number;
}): Promise<number> {
  const { ingredientId, locationId, delta } = opts;
  const rows = await listAll<LocationStock & Doc>('stock_levels', [
    Query.equal('ingredient_id', ingredientId),
    Query.equal('location_id', locationId),
    Query.limit(1),
  ]).catch(() => []);

  const current = rows[0]?.qty ?? 0;
  const next = opts.setTo !== undefined ? opts.setTo : current + delta;

  if (rows[0]) {
    await db.updateDocument(DB_ID, 'stock_levels', rows[0].$id, { qty: next }).catch(() => undefined);
  } else {
    await db.createDocument(DB_ID, 'stock_levels', ID.unique(), {
      ingredient_id: ingredientId, location_id: locationId, qty: next,
    }).catch(() => undefined);
  }

  // And the total, from the places, never from itself.
  const all = await listAll<LocationStock & Doc>('stock_levels', [
    Query.equal('ingredient_id', ingredientId),
  ]).catch(() => []);
  const total = all.reduce((s, l) => s + (l.$id === rows[0]?.$id ? next : l.qty), rows[0] ? 0 : next);
  await db.updateDocument(DB_ID, 'ingredients', ingredientId, {
    current_qty: Number(total.toFixed(4)),
  }).catch(() => undefined);

  return next;
}

/**
 * Carry stock from one place to another.
 *
 * A pair of movements written from one instruction, so neither can exist
 * without the other naming where the stock went. The levels move too, and the
 * business total does not: nothing has been bought, sold or lost — it has been
 * carried across a room.
 *
 * Each line is attempted on its own. A transfer is somebody walking crates out
 * of a store, and losing eleven correct lines because the twelfth hit an error
 * would mean walking them back.
 */
export async function transferStock(opts: {
  venueId: string;
  fromId: string;
  toId: string;
  lines: TransferLine[];
  userId: string;
  note?: string;
}): Promise<{ moved: number; failed: number }> {
  let moved = 0;
  let failed = 0;

  for (const line of opts.lines) {
    const qty = transferQty(line);
    if (qty === null) continue;
    try {
      const ing = await db.getDocument(DB_ID, 'ingredients', line.ingredientId).catch(() => null);
      const unitCost = (ing as unknown as Ingredient | null)?.base_unit_cost ?? 0;

      for (const m of transferMovements({
        fromId: opts.fromId, toId: opts.toId, ingredientId: line.ingredientId, qty, unitCost, note: opts.note,
      })) {
        await db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
          venue_id: opts.venueId,
          ingredient_id: line.ingredientId,
          type: 'transfer',
          qty_delta: m.qty_delta,
          unit_cost: unitCost,
          location_id: m.location_id,
          to_location_id: m.to_location_id,
          ref_type: 'transfer',
          created_by: opts.userId,
          note: opts.note?.trim() ?? '',
        });
      }

      await adjustLevel({ ingredientId: line.ingredientId, locationId: opts.fromId, delta: -qty });
      await adjustLevel({ ingredientId: line.ingredientId, locationId: opts.toId, delta: qty });
      moved += 1;
    } catch {
      failed += 1;
    }
  }

  return { moved, failed };
}

/**
 * The transfer sheet: everything this side stocks, with what the source holds.
 *
 * Ordered by what is actually at the from-end, most first, because somebody
 * restocking a bar works down from the crates they can see rather than through
 * an alphabet.
 */
export async function transferSheet(venueId: string, module: Module, fromId: string): Promise<TransferLine[]> {
  const [ingredients, levels] = await Promise.all([
    loadIngredients(venueId),
    loadLevels([fromId]),
  ]);
  return ingredients
    .filter((i) => i.active && (i.module ?? 'kitchen') === module)
    .map((i) => ({
      ingredientId: i.$id,
      name: i.name,
      unit: i.unit,
      available: levelFor(levels, i.$id, fromId),
    }))
    .sort((a, b) => b.available - a.available || a.name.localeCompare(b.name));
}

/**
 * Apply opening levels read from a file.
 *
 * SET, never added. This is an opening balance, and somebody will run it
 * twice — once to see what happens and once more after fixing a column. A
 * version that added would silently double the shop, and the doubling would
 * look exactly like a good import.
 *
 * A movement is written for the difference rather than only the level being
 * changed, because a shelf that jumps with nothing explaining why is what
 * makes a stock history stop adding up. Each row is attempted on its own: a
 * file of forty is somebody's setup, and losing the lot over one bad row
 * would mean doing it again.
 */
export async function applyLevelImport(opts: {
  venueId: string;
  rows: LevelRow[];
  userId: string;
  note?: string;
}): Promise<{ set: number; failed: number }> {
  let set = 0;
  let failed = 0;

  for (const row of opts.rows) {
    for (const level of row.levels) {
      try {
        const existing = await listAll<LocationStock & Doc>('stock_levels', [
          Query.equal('ingredient_id', row.ingredientId),
          Query.equal('location_id', level.locationId),
          Query.limit(1),
        ]).catch(() => []);
        const before = existing[0]?.qty ?? 0;
        const delta = Number((level.qty - before).toFixed(4));

        if (delta !== 0) {
          const ing = await db.getDocument(DB_ID, 'ingredients', row.ingredientId).catch(() => null);
          await db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
            venue_id: opts.venueId,
            ingredient_id: row.ingredientId,
            type: 'count_correction',
            qty_delta: delta,
            unit_cost: (ing as unknown as Ingredient | null)?.base_unit_cost ?? 0,
            location_id: level.locationId,
            ref_type: 'opening_levels',
            created_by: opts.userId,
            note: opts.note?.trim() || `Opening level at ${level.locationName}`,
          }).catch(() => undefined);
        }

        await adjustLevel({
          ingredientId: row.ingredientId,
          locationId: level.locationId,
          delta: 0,
          setTo: level.qty,
        });
        set += 1;
      } catch {
        failed += 1;
      }
    }
  }

  return { set, failed };
}
