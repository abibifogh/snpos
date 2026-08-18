import { db, DB_ID, ID, Query, listAll } from './client';
import { isAvailable, parseWindows } from './availability';
import type { Category, MenuItem, Doc } from './types';
import type { ProductVariant } from './consignment';
import type { Module } from './access';
import type { ImportDrink } from './drink-import';

export interface MenuItemCategory extends Doc {
  menu_item_id: string;
  category_id: string;
  sort: number;
  active: boolean;
}

export interface AddonGroup extends Doc {
  name: string;
  description?: string;
  min_select: number;
  max_select: number;
  required: boolean;
  sort: number;
  /** Whose choices these are. Absent means the kitchen's. */
  module?: string;
}

export interface AddonOption extends Doc {
  group_id: string;
  name: string;
  price_delta: number;
  active: boolean;
  sort: number;
  default_selected: boolean;
  max_qty: number;
}

export interface MenuItemAddonGroup extends Doc {
  menu_item_id: string;
  group_id: string;
  sort: number;
}

export interface VenueMenuItem extends Doc {
  venue_id: string;
  menu_item_id: string;
  available: boolean;
  price_override?: number;
  sold_out_until?: string;
}

/** A dish as it appears in one particular category. */
export interface MenuEntry {
  item: MenuItem;
  price: number;
  soldOut: boolean;
  groups: { group: AddonGroup; options: AddonOption[] }[];
  /** Where this is cooked, already worked out, see `resolveStation`. */
  station: string;
  stationKey: string;
  /**
   * Sizes, each with its own price. Absent for anything that has one price.
   *
   * Where these exist the item's own `price` is not what anything sells for, 
   * every till must ask which size before it can total a line.
   */
  variants?: ProductVariant[];
}

/**
 * Work out which station cooks a dish.
 *
 * A dish either names its own station or inherits its main category's. Doing it
 * here means the till, the customer menu and the kitchen can never disagree
 * about where a ticket belongs.
 */
export function resolveStation(
  item: Pick<MenuItem, 'station' | 'station_key'>,
  category?: Pick<Category, 'station' | 'station_key'>,
): { station: string; stationKey: string } {
  const own = item.station_key || (item.station !== 'inherit' ? item.station : '');
  if (own) return { station: item.station === 'inherit' ? 'hot' : item.station, stationKey: own };
  return { station: category?.station ?? 'hot', stationKey: category?.station_key || category?.station || '' };
}

export interface MenuSection {
  category: Category;
  open: boolean;
  entries: MenuEntry[];
}

export interface LoadedMenu {
  sections: MenuSection[];
  /** Every dish by id, for looking one up without walking the sections. */
  byId: Record<string, MenuEntry>;
}

/**
 * Build the menu for one venue at one moment.
 *
 * A dish can belong to several categories, so it may appear more than once, 
 * that is the point. Each appearance is governed by that category's own hours,
 * which is how the same dish shows at lunch under one heading and all day
 * under another.
 */
export async function loadMenu(venueId: string, at: Date = new Date()): Promise<LoadedMenu> {
  const [categories, items, memberships, groups, options, itemGroups, overrides, variants] = await Promise.all([
    listAll<Category>('categories'),
    listAll<MenuItem>('menu_items'),
    listAll<MenuItemCategory>('menu_item_categories'),
    listAll<AddonGroup>('addon_groups'),
    listAll<AddonOption>('addon_options'),
    listAll<MenuItemAddonGroup>('menu_item_addon_groups'),
    listAll<VenueMenuItem>('venue_menu_items'),
    listAll<ProductVariant>('product_variants').catch(() => [] as ProductVariant[]),
  ]);

  const overrideFor = new Map(overrides.filter((o) => o.venue_id === venueId).map((o) => [o.menu_item_id, o]));
  const optionsByGroup = new Map<string, AddonOption[]>();
  for (const o of options.filter((x) => x.active).sort((a, b) => a.sort - b.sort)) {
    const list = optionsByGroup.get(o.group_id) ?? [];
    list.push(o);
    optionsByGroup.set(o.group_id, list);
  }
  const groupById = new Map(groups.map((g) => [g.$id, g]));
  const categoryById = new Map(categories.map((c) => [c.$id, c]));

  const buildEntry = (item: MenuItem): MenuEntry => {
    const ov = overrideFor.get(item.$id);
    const soldOutUntil = ov?.sold_out_until || item.sold_out_until;
    // The dish's main category decides the station when the dish itself does
    // not name one, so it is settled once here rather than at each till.
    const where = resolveStation(item, categoryById.get(item.category_id));
    return {
      item,
      price: ov?.price_override ?? item.price,
      station: where.station,
      stationKey: where.stationKey,
      soldOut: (ov ? ov.available === false : false) || (!!soldOutUntil && new Date(soldOutUntil) > at),
      groups: itemGroups
        .filter((ig) => ig.menu_item_id === item.$id)
        .sort((a, b) => a.sort - b.sort)
        .map((ig) => ({ group: groupById.get(ig.group_id)!, options: optionsByGroup.get(ig.group_id) ?? [] }))
        .filter((g) => g.group && g.options.length > 0),
    };
  };

  const activeItems = items.filter((i) => i.active);
  const byId: Record<string, MenuEntry> = {};
  for (const item of activeItems) byId[item.$id] = buildEntry(item);

  // Sizes, attached where they belong.
  //
  // Loaded here rather than by each screen so the till, the customer menu and
  // the receipt all get the same prices from the same read. A shop with no
  // variants pays one empty query for this; a shop with them would otherwise
  // pay one query per product on every screen that shows a price.
  for (const v of variants) {
    if (!v.active) continue;
    const entry = byId[v.menu_item_id];
    if (entry) (entry.variants ??= []).push(v);
  }
  for (const entry of Object.values(byId)) {
    entry.variants?.sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
  }

  const sections: MenuSection[] = categories
    .filter((c) => c.active)
    .sort((a, b) => a.sort - b.sort)
    .map((category) => {
      const memberIds = new Set(
        memberships.filter((m) => m.category_id === category.$id && m.active !== false).map((m) => m.menu_item_id),
      );
      const entries = activeItems
        .filter((i) => i.category_id === category.$id || memberIds.has(i.$id))
        .sort((a, b) => a.sort - b.sort)
        .map((i) => byId[i.$id]);

      return { category, open: isAvailable(parseWindows(category.availability), at), entries };
    })
    .filter((s) => s.entries.length > 0);

  return { sections, byId };
}

/** Sections a customer should actually see right now. */
export const visibleSections = (menu: LoadedMenu): MenuSection[] =>
  menu.sections.filter((s) => s.open || s.category.unavailable_display !== 'hide');

/**
 * Dishes that are actually on today, in menu order, each listed once.
 *
 * What the "we've run out" screen should offer. It used to list the entire
 * menu, so a cook looking for the thing in front of them scrolled past every
 * Sunday roast and every breakfast item on a Tuesday evening, and could take
 * one off, which does nothing useful because the dish was not orderable today
 * anyway. The list is long enough with only the dishes that are on.
 *
 * A dish in two categories appears once. It is the same dish and the same
 * empty container.
 *
 * `module` narrows it to one side of the business. Without it, the craft
 * counter's "Sold out" list offered every dish in the restaurant, so a cashier
 * who has never seen the kitchen could take jollof off the menu by tapping the
 * wrong row.
 */
export function itemsAvailableNow(menu: LoadedMenu, module?: Module): MenuItem[] {
  const seen = new Set<string>();
  const out: MenuItem[] = [];
  for (const section of menu.sections) {
    if (!section.open) continue;
    if (module && (section.category.module ?? 'kitchen') !== module) continue;
    for (const entry of section.entries) {
      if (seen.has(entry.item.$id)) continue;
      seen.add(entry.item.$id);
      out.push(entry.item);
    }
  }
  return out;
}

/**
 * What to print where a price goes.
 *
 * A product with sizes has no single price, and showing the row's own figure
 * would show a number nothing actually sells for. So: one price when there is
 * one, a range when the sizes differ, and the plain figure when they happen to
 * agree. `formatMoney` is passed in rather than imported to keep this file free
 * of the money module, which imports from here.
 */
export function variantPriceRange(entry: {
  price: number;
  variants?: { price: number; active: boolean }[];
}): { from: number; to: number } {
  const live = (entry.variants ?? []).filter((v) => v.active);
  if (live.length === 0) return { from: entry.price, to: entry.price };
  const prices = live.map((v) => v.price);
  return { from: Math.min(...prices), to: Math.max(...prices) };
}

/* ------------------------------------------------------ a drinks list in bulk */

/**
 * Write a read-back drinks list, with the categories and recipes behind it.
 *
 * Categories first, because a drink needs one to point at, and a drink written
 * against a category that does not exist yet is a drink nobody can find.
 *
 * Recipes are replaced rather than added to when a drink already exists. A
 * file correcting a cocktail is somebody saying what is in it NOW, and merging
 * the old lines in would leave the previous recipe pouring alongside the new
 * one — a double measure of gin that nobody typed and nobody can see.
 */
export async function importDrinks(opts: {
  drinks: ImportDrink[];
  existing: { $id: string; name: string }[];
  module?: Module;
}): Promise<{ drinks: number; updated: number; categories: number; recipeLines: number }> {
  const made = new Map<string, string>();
  let categories = 0;

  const byName = new Map(opts.existing.map((e) => [e.name.trim().toLowerCase(), e.$id]));
  let drinks = 0;
  let updated = 0;
  let recipeLines = 0;

  for (const d of opts.drinks) {
    let categoryId = d.categoryId || made.get(d.categoryName.toLowerCase()) || '';
    if (!categoryId) {
      const created = await db.createDocument(DB_ID, 'categories', ID.unique(), {
        name: d.categoryName,
        sort: 0,
        active: true,
        station: 'bar',
        // Required, and easy to miss when creating a row the forms usually
        // create. Appwrite rejects the whole document without it, so every
        // category — and therefore every drink — would have failed to save.
        unavailable_display: 'grey',
        module: opts.module ?? 'bar',
      });
      categoryId = created.$id;
      made.set(d.categoryName.toLowerCase(), categoryId);
      categories += 1;
    }

    const payload = {
      category_id: categoryId,
      name: d.name,
      description: d.description,
      price: d.price,
      prep_minutes: d.prepMinutes,
      // A drink is made at the bar, whatever else is on the ticket.
      station: 'bar' as const,
      active: true,
      // Required by the database, and easy to miss because a drink has no
      // picture to focus and no shelf to track. Appwrite rejects the whole
      // document without them, so every drink failed to save.
      image_focal_x: 0.5,
      image_focal_y: 0.5,
      sort: 0,
      track_stock: false,
      module: opts.module ?? 'bar',
      ...(d.barcode ? { sku: d.barcode } : {}),
    };

    const existingId = byName.get(d.name.trim().toLowerCase());
    let itemId: string;
    if (existingId) {
      await db.updateDocument(DB_ID, 'menu_items', existingId, payload);
      itemId = existingId;
      updated += 1;
      // Out with the old recipe before the new one goes in. See above: merging
      // would leave two measures pouring where somebody typed one.
      const old = await listAll<Doc>('recipes', [Query.equal('menu_item_id', itemId)]).catch(() => []);
      for (const r of old) await db.deleteDocument(DB_ID, 'recipes', r.$id).catch(() => undefined);
    } else {
      const created = await db.createDocument(DB_ID, 'menu_items', ID.unique(), payload);
      itemId = created.$id;
      drinks += 1;
    }

    // The join row the menu reads from. Without it the drink exists and
    // appears nowhere, which looks exactly like the import having failed.
    const links = await listAll<Doc>('menu_item_categories', [Query.equal('menu_item_id', itemId)]).catch(() => []);
    if (!links.some((l) => (l as unknown as { category_id: string }).category_id === categoryId)) {
      await db.createDocument(DB_ID, 'menu_item_categories', ID.unique(), {
        menu_item_id: itemId,
        category_id: categoryId,
        sort: 0,
        active: true,
      }).catch(() => undefined);
    }

    for (const r of d.recipe) {
      await db.createDocument(DB_ID, 'recipes', ID.unique(), {
        menu_item_id: itemId,
        ingredient_id: r.ingredientId,
        qty_per_unit: r.qtyPerUnit,
        wastage_bp: r.wastageBp,
      }).catch(() => undefined);
      recipeLines += 1;
    }
  }

  return { drinks, updated, categories, recipeLines };
}
