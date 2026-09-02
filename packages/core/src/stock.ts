import { db, DB_ID, ID, Query, listAll, listByIds, tryWrite } from './client';
// Type-only, erased at compile time. The pairing itself is pure; see shift-counts.
import type { CountEntry } from './shift-counts';
import type { PurchaseRow } from './price-history';
import type { Module } from './access';
import { unpouredSales } from './unpoured';
import type { Unpoured, SoldRow, SoldItem, PourRule } from './unpoured';
import {
  variancesIn, wasCountedBar, shiftCounted, countable, countableBy, filedCounts, undoDeltas, undoProblem,
  movesOnItsOwn, storeCountId, isStoreCount, STORE_COUNT_PREFIX, isPending, approveDeltas,
} from './bar-count';
import type { FiledCheck } from './bar-count';
import { levelFor, transferQty, transferMovements, purchaseLocation, saleLocation } from './locations';
// What a sale actually pours from: a size's own rows win over the drink's.
import { recipeFor } from './variant-recipes';
import type { RecipeRow } from './recipe-card';
import {
  levelPayload, readLevelPayload, rowsFromPayload, restoreProblem, LEVEL_PAYLOAD_MAX,
} from './level-import';
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
  /** Only a manager may put a number against this. See managerCountOnly. */
  manager_count_only?: boolean;
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
  /**
   * The size this applies to, where it applies to one.
   *
   * Missing from this type while the column existed and was written and read
   * everywhere else — so anything reading a recipe through it could not see
   * which size a row belonged to, and had to be told the type was wrong.
   */
  variant_id?: string;
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
  /*
    THIS SIDE FIRST, then the shift's narrowing. The order matters.

    `shiftCounted` means "if anybody has ticked anything, count only what was
    ticked". Run across the whole building it answers for the building: a
    kitchen that ticks four items narrows the list to those four, and the bar's
    lines are then filtered out by side — leaving the bar closing with an empty
    sheet and nobody asked to count anything at all.

    Narrowed within the side, it answers the question actually being asked:
    what does THIS side count every shift, and if this side has ticked nothing,
    it counts everything of its own.
  */
  // Everything active that is actually on a shelf. A list with a taxi in it
  // is a list people learn to tap through, which costs the count on the
  // things that do matter.
  // This side's shelves only. A bar counting rice and a kitchen counting gin
  // are both counting somebody else's larder, and a sheet with forty lines
  // on it that are not yours is a sheet people tap through.
  const mine = countable(ingredients).filter(
    (i) => i.active && (i.module ?? 'kitchen') === module,
  );

  return shiftCounted(mine)
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
export async function barCountSheet(
  venueId: string,
  locationId?: string,
  /**
   * Whether the person counting may see the manager-only rows.
   *
   * Defaults to true, so every existing caller keeps the sheet it had. The
   * screens that know who is holding the clipboard say so.
   */
  isManager = true,
): Promise<BarCountLine[]> {
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
  /*
    Never counted wins over everything, in both rooms.

    It says there is no shelf to walk, and that is not a matter of which place
    is being counted or how often. Neither branch below used to ask: a store
    room's sheet had no cadence filter at all, and the bar's own fell back to
    "count everything" whenever nothing had been marked for the shift. See
    countable.
  */
  const onShelf = countable(ingredients.filter((i) => i.active && (i.module ?? 'kitchen') === 'bar'));
  const rows = counter?.kind === 'store' ? onShelf : shiftCounted(onShelf);
  /*
    And then who is holding the clipboard.

    After the cadence, never instead of it: "never counted" says there is no
    shelf, which is true whoever is asking. Held-back rows are left OFF a
    bartender's sheet rather than shown greyed — a sheet with rows nobody can
    fill reports itself unfinished for ever and can never be sent.
  */
  return countableBy(rows, isManager)
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
}): Promise<{ written: number; shortValue: number; failed: number; pending: number }> {
  const places = await loadLocations(opts.venueId);
  const counter = places.find((l) => l.$id === opts.locationId) ?? saleLocation(places, 'bar');
  const variances = variancesIn(opts.lines);
  const shortValue = variances.filter((v) => v.delta < 0).reduce((s, v) => s + v.value, 0);
  let written = 0;
  /** Lines that found a difference and are now waiting for an admin. */
  let pending = 0;
  /*
    Counted, not swallowed.

    Every write below ends in a catch so that one bad row cannot abandon a
    count of forty bottles half-way through. That is right, and it is also how
    a stocktake once corrected nothing at all for weeks while the screen said
    it was done. See tryWrite: the run finishes, and then it says what did not
    save rather than reporting a clean count.
  */
  let failed = 0;

  for (const line of opts.lines) {
    if (!wasCountedBar(line)) continue;
    const counted = Number((line.countedText ?? '').trim());
    const variance = Number((counted - line.expected).toFixed(4));

    /*
      HELD UNTIL AGREED.

      A count that found what was expected changes nothing and is recorded as
      counted. A count that found a DIFFERENCE is a claim that stock is missing
      or has appeared, and that claim used to move the real figures the moment
      it was typed — by whoever was holding the clipboard. It now waits for an
      admin to agree, and nothing below that touches the shelf runs until they
      do. See approveBarCount, which is the same movement and the same level
      change, made later by somebody who can see the whole business.

      A store room's count is recorded too, under a name that says which room
      rather than which shift — see storeCountId — so that it can be held and
      approved the same way. It used to be written to nothing at all and
      applied at once.
    */
    const held = !movesOnItsOwn(variance);
    const recordAs = opts.shiftId ?? storeCountId(counter?.$id ?? 'store');
    const wrote = await tryWrite(db.createDocument(DB_ID, 'shift_stock_checks', ID.unique(), {
      venue_id: opts.venueId,
      shift_id: recordAs,
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
      applied: !held,
    }));
    if (!wrote) { failed += 1; continue; }
    if (held) { pending += 1; written += 1; continue; }

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
      }).catch(() => { failed += 1; });
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
      // The count itself. If this is the one that does not land, the shelf is
      // unchanged and the person has been told it was counted.
      const landed = await tryWrite(db.updateDocument(DB_ID, 'ingredients', line.ingredientId, {
        current_qty: counted,
      }));
      if (!landed) { failed += 1; continue; }
    }

    written += 1;
  }

  return { written, shortValue, failed, pending };
}

/* ------------------------------------------- agreeing to a held count */

/** Every line still waiting for an admin, across every shift and store room. */
export const pendingBarChecks = (): Promise<FiledCheck[]> =>
  listAll<FiledCheck & Doc>('shift_stock_checks', [Query.equal('applied', false)])
    .then((rows) => rows.filter(isPending))
    .catch(() => [] as (FiledCheck & Doc)[]);

/**
 * Every count filed in a window, for the history.
 *
 * Bounded, because a bar counted twice a day writes forty rows a time, and a
 * history page that reads a year of that on every open is a page that stops
 * being opened.
 */
export const barCountHistory = (sinceMs: number): Promise<FiledCheck[]> =>
  listAll<FiledCheck & Doc>('shift_stock_checks', [
    Query.greaterThanEqual('$createdAt', new Date(sinceMs).toISOString()),
  ]).catch(() => [] as (FiledCheck & Doc)[]);

/**
 * Apply a held count to the shelf.
 *
 * The same movement and the same level change that saveBarCount used to make
 * at once — made now, by an admin, by the DIFFERENCE the count found rather
 * than the figure it wrote. The count was taken hours ago and the shelf has
 * been sold from since; writing the counted number over it now would erase
 * every sale in between. See approveDeltas.
 */
export async function approveBarCount(opts: {
  venueId: string;
  shiftId: string;
  phase: 'open' | 'close';
  userId: string;
  locationId?: string;
}): Promise<{ applied: number; failed: number }> {
  const all = await countsForShift(opts.shiftId);
  const count = filedCounts(all).find((c) => c.phase === opts.phase);
  if (!count) throw new Error('That count could not be found.');
  if (count.pending === 0) throw new Error('Nothing on that count is waiting to be applied.');

  const places = await loadLocations(opts.venueId);
  // A store room's count names its room in the id; a shift's count is the bar.
  const roomId = isStoreCount(opts.shiftId) ? opts.shiftId.slice(STORE_COUNT_PREFIX.length) : opts.locationId;
  const counter = places.find((l) => l.$id === roomId) ?? saleLocation(places, 'bar');
  const when = new Date().toISOString();

  let applied = 0;
  let failed = 0;

  for (const { checkId, ingredientId, delta } of approveDeltas(count)) {
    const ing = await db.getDocument(DB_ID, 'ingredients', ingredientId).catch(() => null) as
      { base_unit_cost?: number } | null;

    const wrote = await tryWrite(db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
      venue_id: opts.venueId,
      ingredient_id: ingredientId,
      type: 'count_correction',
      qty_delta: delta,
      unit_cost: ing?.base_unit_cost ?? 0,
      location_id: counter?.$id ?? '',
      ref_type: isStoreCount(opts.shiftId) ? 'stocktake' : 'shift',
      ref_id: isStoreCount(opts.shiftId) ? (counter?.$id ?? '') : opts.shiftId,
      shift_id: isStoreCount(opts.shiftId) ? '' : opts.shiftId,
      created_by: opts.userId,
      note: `Count approved (${opts.phase === 'open' ? 'counted in' : 'counted out'})`,
    }));
    if (!wrote) { failed += 1; continue; }

    if (counter) {
      await adjustLevel({ ingredientId, locationId: counter.$id, delta });
    } else {
      const now = await db.getDocument(DB_ID, 'ingredients', ingredientId).catch(() => null) as
        { current_qty?: number } | null;
      await tryWrite(db.updateDocument(DB_ID, 'ingredients', ingredientId, {
        current_qty: Number(((now?.current_qty ?? 0) + delta).toFixed(4)),
      }));
    }

    await tryWrite(db.updateDocument(DB_ID, 'shift_stock_checks', checkId, {
      applied: true,
      approved_by: opts.userId,
      approved_at: when,
    }));
    applied += 1;
  }

  return { applied, failed };
}

/**
 * Refuse a held count. The shelf is left exactly as it was.
 *
 * The rows stay, marked. Somebody stood at the shelf and wrote a number down,
 * and a count that was looked at and disagreed with is a more useful record
 * than a gap where it used to be.
 */
export async function rejectBarCount(opts: {
  shiftId: string;
  phase: 'open' | 'close';
  userId: string;
}): Promise<number> {
  const all = await countsForShift(opts.shiftId);
  const count = filedCounts(all).find((c) => c.phase === opts.phase);
  if (!count) throw new Error('That count could not be found.');
  const when = new Date().toISOString();
  let marked = 0;
  for (const line of count.lines.filter(isPending)) {
    const ok = await tryWrite(db.updateDocument(DB_ID, 'shift_stock_checks', line.$id, {
      rejected_by: opts.userId,
      rejected_at: when,
    }));
    if (ok) marked += 1;
  }
  return marked;
}

/**
 * What this shift sold that took nothing off a shelf.
 *
 * Ground truth, against the sales rather than against the catalogue: the same
 * rule the server uses to decide what to pour, run over what actually went out.
 * See unpouredSales — the catalogue check next door says "something names this
 * bottle" and can be satisfied by a recipe the server will never match.
 */
export async function unpouredForShift(
  venueId: string,
  shiftId: string,
  module: Module = 'bar',
): Promise<Unpoured[]> {
  const orders = await listAll<{ $id: string; module?: string; status?: string }>('orders', [
    Query.equal('shift_id', shiftId),
  ]).catch(() => []);
  const mine = orders.filter(
    (o) => (o.module ?? 'kitchen') === module && !['CANCELLED', 'REJECTED'].includes(o.status ?? ''),
  );
  if (mine.length === 0) return [];

  const [lines, recipes, items] = await Promise.all([
    listByIds<SoldRow>('order_items', 'order_id', mine.map((o) => o.$id)).catch(() => [] as SoldRow[]),
    loadRecipes().catch(() => [] as RecipeRow[]),
    listAll<SoldItem>('menu_items', [Query.equal('venue_id', venueId)]).catch(() => [] as SoldItem[]),
  ]);

  return unpouredSales(lines, recipes as unknown as PourRule[], items);
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
  /** Set when this is putting an earlier upload back. See restoreLevelUpload. */
  restoredFrom?: string;
}): Promise<{ set: number; failed: number; uploadId?: string }> {
  let set = 0;
  let failed = 0;

  /*
    WHAT THE FILE SAID, KEPT BEFORE ANY OF IT IS APPLIED.

    The movements below record how far each shelf MOVED, which is not the same
    as what the file said — working one back from the other needs to know what
    every shelf held beforehand, and that is precisely what has changed by the
    time anybody wants it back. So the figures are stored as figures.

    Written first, so a run that fails half way still leaves the statement it
    was making. Never allowed to fail the import: an opening balance that goes
    in without its receipt is worth more than no opening balance.
  */
  const payload = JSON.stringify(levelPayload(opts.rows));
  const uploadId = payload.length > LEVEL_PAYLOAD_MAX
    ? undefined
    : (await db.createDocument(DB_ID, 'stock_level_uploads', ID.unique(), {
      venue_id: opts.venueId,
      uploaded_at: new Date().toISOString(),
      uploaded_by: opts.userId,
      note: (opts.note ?? '').slice(0, 300),
      payload,
      lines: opts.rows.length,
      ...(opts.restoredFrom ? { restored_from: opts.restoredFrom } : {}),
    }).then((d) => d.$id).catch(() => undefined));

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

  return { set, failed, uploadId };
}


/* --------------------------------------------- taking a bar count back */

/** Every count filed against a shift, for the admin who has to look at them. */
export const countsForShift = async (shiftId: string): Promise<FiledCheck[]> =>
  listAll<FiledCheck & Doc>('shift_stock_checks', [Query.equal('shift_id', shiftId)])
    .catch(() => [] as (FiledCheck & Doc)[]);

/**
 * Put the shelf back the way it was before a count.
 *
 * A count that was wrong — a number typed into the wrong row, a shelf counted
 * before a delivery was put away — moves real stock figures, and until now
 * nothing could move them back. The only way out was to count again, which
 * files a second count against the same shift and leaves both standing with
 * nothing saying which one anybody should believe.
 *
 * NOTHING IS DELETED. The count happened: somebody stood at the shelf and
 * wrote a number down, and the stock moved because of it. The rows stay,
 * marked as taken back, and the shelf is corrected by an opposite movement —
 * the same way the books undo an entry, and for the same reason. A history
 * that can be quietly rewritten is not a history.
 *
 * And the correction is a DELTA, never the old absolute figure. See
 * undoDeltas: putting the shelf back to what it held before the count would
 * be wrong by everything poured since, and those sales are already recorded.
 */
export async function undoBarCount(opts: {
  venueId: string;
  shiftId: string;
  phase: 'open' | 'close';
  userId: string;
  locationId?: string;
}): Promise<{ put_back: number; failed: number }> {
  const all = await countsForShift(opts.shiftId);
  const count = filedCounts(all).find((c) => c.phase === opts.phase);

  const problem = undoProblem(count);
  if (problem || !count) throw new Error(problem ?? 'That count could not be found.');

  const places = await loadLocations(opts.venueId);
  const counter = places.find((l) => l.$id === opts.locationId) ?? saleLocation(places, 'bar');
  const when = new Date().toISOString();

  let put_back = 0;
  let failed = 0;

  for (const { ingredientId, delta } of undoDeltas(count)) {
    const ing = await db.getDocument(DB_ID, 'ingredients', ingredientId).catch(() => null) as
      { base_unit_cost?: number } | null;

    const wrote = await tryWrite(db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
      venue_id: opts.venueId,
      ingredient_id: ingredientId,
      type: 'count_correction',
      qty_delta: delta,
      unit_cost: ing?.base_unit_cost ?? 0,
      location_id: counter?.$id ?? '',
      ref_type: 'shift',
      ref_id: opts.shiftId,
      shift_id: opts.shiftId,
      created_by: opts.userId,
      note: `Count taken back (${opts.phase === 'open' ? 'counted in' : 'counted out'})`,
    }));
    if (!wrote) { failed += 1; continue; }

    // The shelf itself, through the same door every other correction uses, so
    // the room's level and the business total stay in step.
    if (counter) {
      await adjustLevel({ ingredientId, locationId: counter.$id, delta });
    } else if (ing) {
      const now = await db.getDocument(DB_ID, 'ingredients', ingredientId).catch(() => null) as
        { current_qty?: number } | null;
      await tryWrite(db.updateDocument(DB_ID, 'ingredients', ingredientId, {
        current_qty: Number(((now?.current_qty ?? 0) + delta).toFixed(4)),
      }));
    }
    put_back += 1;
  }

  /*
    Marked last, and every row of it including the ones that moved nothing.

    A count is one statement, so it is taken back as one: leaving the
    unchanged lines unmarked would show a count half undone, which is not a
    thing that happened.
  */
  for (const line of count.lines) {
    await tryWrite(db.updateDocument(DB_ID, 'shift_stock_checks', line.$id, {
      undone_at: when,
      undone_by: opts.userId,
    }));
  }

  return { put_back, failed };
}


/* ---------------------------------------- putting an upload back */

export interface LevelUploadDoc extends Doc {
  venue_id: string;
  uploaded_at: string;
  uploaded_by?: string;
  note?: string;
  payload: string;
  lines: number;
  restored_from?: string;
}

/** The opening-level uploads this venue has had, newest first. */
export const loadLevelUploads = async (venueId: string): Promise<LevelUploadDoc[]> =>
  (await listAll<LevelUploadDoc>('stock_level_uploads', [Query.equal('venue_id', venueId)])
    .catch(() => [] as LevelUploadDoc[]))
    .sort((a, b) => (b.uploaded_at ?? b.$createdAt).localeCompare(a.uploaded_at ?? a.$createdAt));

/**
 * Set the shelves back to what an upload said.
 *
 * The same door the upload itself went through, deliberately: restoring is not
 * a special kind of write, it is the same statement being made again. So it
 * sets the same levels, records the same movements, and leaves its own row in
 * the history — pointing at the upload it came from, so the record reads
 * forwards rather than having to be untangled backwards.
 *
 * The places and the bottles are looked up fresh. A room renamed since comes
 * back under the name it has now, and anything deleted since is dropped rather
 * than restored into a place nothing can count. See rowsFromPayload.
 */
export async function restoreLevelUpload(opts: {
  venueId: string;
  uploadId: string;
  userId: string;
}): Promise<{ set: number; failed: number; skipped: number }> {
  const upload = await db.getDocument(DB_ID, 'stock_level_uploads', opts.uploadId)
    .catch(() => null) as unknown as LevelUploadDoc | null;
  if (!upload) throw new Error('That upload could not be found.');

  const stored = readLevelPayload(upload.payload);
  const [ingredients, locations] = await Promise.all([
    loadIngredients(opts.venueId),
    loadLocations(opts.venueId),
  ]);
  const rows = rowsFromPayload(stored, { ingredients, locations });

  const problem = restoreProblem(stored, rows);
  if (problem) throw new Error(problem);

  const { set, failed } = await applyLevelImport({
    venueId: opts.venueId,
    rows,
    userId: opts.userId,
    note: `Restored from the upload of ${new Date(upload.uploaded_at).toLocaleDateString()}`,
    restoredFrom: upload.$id,
  });

  return {
    set,
    failed,
    // Said rather than quietly dropped: an upload of forty that puts back
    // thirty-six has had four bottles or rooms removed since, and that is
    // worth knowing at the moment somebody is restoring an opening balance.
    skipped: stored.length - rows.reduce((n, r) => n + r.levels.length, 0),
  };
}


/* ------------------------------ sales that never reached a shelf */

/**
 * Pour a shift's sales that never came off anything.
 *
 * A bar deducts as each drink is paid for, which needs the drink to have a
 * recipe naming a shelf. A drink with no recipe pours nothing — correctly,
 * because there was nothing to pour from — and that is the state every bottled
 * drink was in until its sizes were given shelves of their own.
 *
 * So the sales made BEFORE those shelves existed came off nothing, and no
 * amount of counting will make them agree: the shelf says what was counted,
 * the sales say what went, and nothing has ever connected the two for that
 * part of the night.
 *
 * This walks the shift and pours what was missed, once. Idempotent by the sale
 * line, exactly as the server is: a movement stamped with the line's id is the
 * proof it has already been poured, so running this twice — or running it on a
 * shift the server handled properly — moves nothing.
 *
 * It pours from what the line ACTUALLY SOLD, so a large Club comes off the
 * large Club's shelf and not off the drink it is a size of. See recipeFor: a
 * size's own rows win outright over the drink's rather than adding to them.
 */
export async function pourMissedSales(opts: {
  venueId: string;
  shiftId: string;
  module?: Module;
  userId: string;
}): Promise<{ poured: number; lines: number; failed: number; retired: number }> {
  const [orders, recipes, places, variants] = await Promise.all([
    listAll<{ $id: string; status?: string; module?: string }>('orders', [
      Query.equal('venue_id', opts.venueId),
      Query.equal('shift_id', opts.shiftId),
    ]).catch(() => []),
    loadRecipes(),
    loadLocations(opts.venueId),
    listAll<{ $id: string; active?: boolean }>('product_variants').catch(() => []),
  ]);

  /*
    Sizes that are no longer sold.

    The till will not sell one — see loadMenu, which leaves them off — so this
    only ever meets them on OLD lines, sold before the size was retired. Their
    shelf is not counted any more and nothing is bought onto it, so pouring
    into it now would drive a dead figure negative and leave the shelf the
    bottle actually came from just as overstated as before. Skipped and
    counted, so the screen can say it rather than reporting a clean run.
  */
  const retiredSizeIds = new Set(variants.filter((v) => v.active === false).map((v) => v.$id));

  const counter = saleLocation(places, opts.module ?? 'bar');
  const mine = orders.filter((o) => (o.module ?? 'kitchen') === (opts.module ?? 'bar')
    && !['CANCELLED', 'REJECTED'].includes(o.status ?? ''));
  if (mine.length === 0) return { poured: 0, lines: 0, failed: 0, retired: 0 };

  const lines = await listByIds<{
    $id: string; order_id: string; menu_item_id: string; variant_id?: string;
    qty?: number; status?: string; name_snapshot?: string;
  }>('order_items', 'order_id', mine.map((o) => o.$id)).catch(() => []);

  let poured = 0;
  let touched = 0;
  let failed = 0;

  let retired = 0;
  for (const line of lines) {
    if (line.status === 'void') continue;
    // A sale on a size that has since been retired. See retiredSizeIds.
    if (line.variant_id && retiredSizeIds.has(line.variant_id)) { retired += 1; continue; }

    /*
      Already poured? Then leave it alone.

      The same test the server makes, against the same rows, so this cannot
      double-count a drink the server handled — and cannot be made to by
      pressing the button again.
    */
    const already = await db.listDocuments(DB_ID, 'stock_movements', [
      Query.equal('ref_type', 'order_item'),
      Query.equal('ref_id', line.$id),
      Query.limit(1),
    ]).catch(() => ({ total: 1 }));
    if ((already.total ?? 1) > 0) continue;

    const applies = recipeFor(recipes as unknown as RecipeRow[], line.menu_item_id, line.variant_id);
    if (applies.length === 0) continue;

    touched += 1;
    for (const r of applies) {
      const ing = await db.getDocument(DB_ID, 'ingredients', r.ingredient_id).catch(() => null) as
        { base_unit_cost?: number } | null;
      if (!ing) continue;

      // The kitchen's arithmetic, mirrored: a bar over-pours as a kitchen
      // trims, and a recipe ignoring wastage reports a shortage every night.
      const perUnit = (r.qty_per_unit ?? 0) * (1 + (r.wastage_bp ?? 0) / 10000);
      const used = perUnit * (line.qty ?? 1);
      if (!used) continue;

      const wrote = await tryWrite(db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
        venue_id: opts.venueId,
        ingredient_id: r.ingredient_id,
        type: 'sale_depletion',
        qty_delta: -used,
        unit_cost: ing.base_unit_cost ?? 0,
        location_id: counter?.$id ?? '',
        ref_type: 'order_item',
        ref_id: line.$id,
        shift_id: opts.shiftId,
        created_by: opts.userId,
        note: `${line.name_snapshot ?? 'Sold'}, poured late`,
      }));
      if (!wrote) { failed += 1; continue; }

      if (counter) {
        await adjustLevel({ ingredientId: r.ingredient_id, locationId: counter.$id, delta: -used });
      } else {
        const now = await db.getDocument(DB_ID, 'ingredients', r.ingredient_id).catch(() => null) as
          { current_qty?: number } | null;
        await tryWrite(db.updateDocument(DB_ID, 'ingredients', r.ingredient_id, {
          current_qty: Number(((now?.current_qty ?? 0) - used).toFixed(4)),
        }));
      }
      poured += 1;
    }
  }

  return { poured, lines: touched, failed, retired };
}

/* ----------------------------------------- both ends of a shift's count */

/**
 * What a shift counted in and what it counted out.
 *
 * One call for both trades, because the question is the same one and the
 * screen asking it should not have to know which collection answers it. The
 * bar counts ingredients into `shift_stock_checks`; the shop counts products
 * into `stock_counts` with their lines beside them. Neither knows about the
 * other, and a caller wanting "this shift's counts" wants them merged.
 *
 * Empty rather than throwing where a shift has none. Most shifts are the
 * kitchen's and never counted anything, and an error on those would put a
 * failure on every second Details panel.
 */
export async function shiftCountEntries(
  shiftId: string,
  module: Module = 'kitchen',
): Promise<CountEntry[]> {
  if (!shiftId) return [];

  if (module === 'craft') {
    const heads = await listAll<{
      $id: string; phase?: string; status?: string;
    }>('stock_counts', [Query.equal('shift_id', shiftId)]).catch(() => []);
    if (heads.length === 0) return [];

    const lines = await listByIds<{
      count_id: string; menu_item_id: string; variant_id?: string;
      name_snapshot: string; variant_label?: string;
      expected: number; counted: number; unit_price: number;
    }>('stock_count_lines', 'count_id', heads.map((h) => h.$id)).catch(() => []);

    const phaseOf = new Map<string, 'open' | 'close'>(
      heads.map((h) => [h.$id, h.phase === 'open' ? 'open' : 'close']),
    );
    // A count that was rejected is not evidence of the shelf. It was looked at
    // and disagreed with, and the row stays in its own screen rather than
    // being read here as though it had been accepted.
    const rejected = new Set(heads.filter((h) => h.status === 'rejected').map((h) => h.$id));

    return lines
      .filter((l) => !rejected.has(l.count_id))
      .map((l) => ({
        // The size is its own thing on the shelf, so it is its own row here.
        itemId: l.variant_id || l.menu_item_id,
        name: l.variant_label ? `${l.name_snapshot} · ${l.variant_label}` : l.name_snapshot,
        phase: phaseOf.get(l.count_id) ?? 'close',
        counted: l.counted,
        expected: l.expected,
        varianceQty: l.counted - l.expected,
        varianceValue: (l.counted - l.expected) * (l.unit_price ?? 0),
      }));
  }

  const checks = await listAll<{
    ingredient_id: string; phase?: string; counted_qty?: number; theoretical_qty: number;
    variance_qty: number; variance_value: number; undone_at?: string;
  }>('shift_stock_checks', [Query.equal('shift_id', shiftId)]).catch(() => []);
  if (checks.length === 0) return [];

  const names = await listByIds<{ $id: string; name: string; unit?: string }>(
    'ingredients', '$id', checks.map((c) => c.ingredient_id),
  ).catch(() => []);
  const nameOf = new Map(names.map((n) => [n.$id, n.name]));

  return checks.map((c) => ({
    itemId: c.ingredient_id,
    // An ingredient deleted since still has a row here. Naming it by its id is
    // useless, so it says what it is instead of pretending to know.
    name: nameOf.get(c.ingredient_id) ?? 'Item no longer in the list',
    phase: (c.phase === 'open' ? 'open' : 'close') as 'open' | 'close',
    // Not counted is not nought. See pairCounts.
    counted: typeof c.counted_qty === 'number' ? c.counted_qty : null,
    expected: c.theoretical_qty,
    varianceQty: c.variance_qty,
    varianceValue: c.variance_value,
    undone: !!c.undone_at,
  }));
}
