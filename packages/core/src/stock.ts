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

export type StockLevel = 'ok' | 'low' | 'out';

/** Where an ingredient sits against its own thresholds. */
export function levelOf(ing: Ingredient, lowDefaultBp = 3000): StockLevel {
  if (ing.current_qty <= 0) return 'out';
  const threshold = ing.low_threshold ?? (ing.par_level * lowDefaultBp) / 10000;
  return ing.current_qty <= threshold ? 'low' : 'ok';
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
): Promise<{ fresh: StockAlert[]; persistent: StockAlert[] }> {
  const fresh: StockAlert[] = [];
  const persistent: StockAlert[] = [];
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
    if (count >= persistentThreshold) persistent.push(alert);
    else if (count === 1) fresh.push(alert);
  }

  return { fresh, persistent };
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
