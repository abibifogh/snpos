import { listAll } from './client';
import { isAvailable, parseWindows } from './availability';
import type { Category, MenuItem, Doc } from './types';

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
 * A dish can belong to several categories, so it may appear more than once —
 * that is the point. Each appearance is governed by that category's own hours,
 * which is how the same dish shows at lunch under one heading and all day
 * under another.
 */
export async function loadMenu(venueId: string, at: Date = new Date()): Promise<LoadedMenu> {
  const [categories, items, memberships, groups, options, itemGroups, overrides] = await Promise.all([
    listAll<Category>('categories'),
    listAll<MenuItem>('menu_items'),
    listAll<MenuItemCategory>('menu_item_categories'),
    listAll<AddonGroup>('addon_groups'),
    listAll<AddonOption>('addon_options'),
    listAll<MenuItemAddonGroup>('menu_item_addon_groups'),
    listAll<VenueMenuItem>('venue_menu_items'),
  ]);

  const overrideFor = new Map(overrides.filter((o) => o.venue_id === venueId).map((o) => [o.menu_item_id, o]));
  const optionsByGroup = new Map<string, AddonOption[]>();
  for (const o of options.filter((x) => x.active).sort((a, b) => a.sort - b.sort)) {
    const list = optionsByGroup.get(o.group_id) ?? [];
    list.push(o);
    optionsByGroup.set(o.group_id, list);
  }
  const groupById = new Map(groups.map((g) => [g.$id, g]));

  const buildEntry = (item: MenuItem): MenuEntry => {
    const ov = overrideFor.get(item.$id);
    const soldOutUntil = ov?.sold_out_until || item.sold_out_until;
    return {
      item,
      price: ov?.price_override ?? item.price,
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
