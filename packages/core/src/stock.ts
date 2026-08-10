import { db, DB_ID, ID, Query, listAll } from './client';
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
  /** The rule a cook reads at the shift-end check, in the restaurant's words. */
  check_guide?: string;
  /** Which expense category a delivery of this counts as. */
  expense_category_key?: string;
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
 * point — it is where waste, over-portioning and theft show up.
 */
export function theoreticalUsage(items: OrderItem[], recipes: Recipe[]): Record<string, number> {
  const usage: Record<string, number> = {};

  for (const item of items) {
    if (item.status === 'void') continue;

    const forItem = recipes.filter((r) => r.menu_item_id === item.menu_item_id);
    for (const r of forItem) {
      // Wastage covers trim and spillage — the peel on an onion is consumed
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

  await db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
    venue_id: venueId,
    ingredient_id: ingredient.$id,
    type: 'purchase',
    qty_delta: qty,
    unit_cost: unitCost ?? ingredient.base_unit_cost,
    ref_type: refType,
    ref_id: refId,
    shift_id: shiftId ?? '',
    created_by: createdBy ?? '',
    note: note ?? '',
  });

  await db.updateDocument(DB_ID, 'ingredients', ingredient.$id, {
    current_qty: Number((ingredient.current_qty + qty).toFixed(4)),
    ...(unitCost && unitCost > 0 ? { base_unit_cost: unitCost } : {}),
  });
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
): Promise<{ fresh: StockAlert[]; persistent: StockAlert[]; all: StockAlert[] }> {
  const fresh: StockAlert[] = [];
  const persistent: StockAlert[] = [];
  /**
   * Every flagged item, not just the two ends of the range.
   *
   * `fresh` is exactly one shift and `persistent` is three or more, so an
   * ingredient on its SECOND consecutive shift belonged to neither — and
   * anything reading only those two lists lost it. The shift-close email did
   * exactly that, which is how an item a cook had marked OUT could disappear
   * from the report on the night it mattered most.
   */
  const all: StockAlert[] = [];
  const now = new Date().toISOString();

  for (const ing of ingredients) {
    const level = levelOf(ing, lowDefaultBp);

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

export const loadIngredients = (venueId: string) =>
  listAll<Ingredient>('ingredients', [Query.equal('venue_id', venueId)]);

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
export async function stockCheckRows(venueId: string): Promise<StockCheckRow[]> {
  const [ingredients, categories] = await Promise.all([
    loadIngredients(venueId),
    listAll<{ key: string; name: string; sort?: number; active?: boolean }>('ingredient_categories').catch(() => []),
  ]);

  const order = new Map(categories.map((c, i) => [c.key, c.sort ?? i]));
  const label = new Map(categories.map((c) => [c.key, c.name]));
  // Anything uncategorised goes last under its own heading, rather than
  // silently at the top where it reads as belonging to nothing.
  const rank = (key?: string) => (key && order.has(key) ? (order.get(key) as number) : 9999);

  return ingredients
    .filter((i) => i.active)
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
