import type { Settings, StaffProfile } from './types';

/**
 * The parts of the admin app, and who may open them.
 *
 * Kept here rather than in the admin app because two things need to agree: the
 * navigation, which decides what to show, and the router, which decides what
 * to serve. A link that is merely hidden is not a restriction.
 */
export interface AdminSection {
  key: string;
  label: string;
  /** The route it lives at, so nav and router read the same list. */
  path: string;
  group: string;
  /** True for the pages that only ever make sense for an owner. */
  ownerOnly?: boolean;
  /**
   * Which side of the business this section belongs to, if only one.
   *
   * Absent means it serves both; a shift is a shift whether the money came
   * from a plate of jollof or a woven basket. Where it is set, the section
   * appears only when that module is switched on, so a restaurant is never
   * shown consignor payouts and a craft shop is never shown a waste log.
   */
  module?: Module;
}

/** The two trades this system knows how to run. */
export type Module = 'kitchen' | 'craft';

export interface Modules {
  kitchen: boolean;
  craft: boolean;
}

/**
 * What this business actually runs.
 *
 * The first version of this asked what a business WAS, restaurant or craft
 * shop, and that was the wrong question. A place can have a kitchen and a
 * craft corner under one roof, one till, one set of staff and one set of
 * books, and making it choose was making it run two systems.
 *
 * So the question is what it DOES, and any combination is allowed except
 * neither: a system with no trade switched on has no usable screens, and
 * silently showing nothing is a worse answer than quietly falling back to the
 * kitchen.
 *
 * Setups made before the switches existed said what they were, so that is read
 * as what they run.
 */
export function modulesOf(settings: Settings | null): Modules {
  const kitchen = settings?.kitchen_enabled;
  const craft = settings?.craft_enabled;

  if (kitchen === undefined && craft === undefined) {
    const legacy = settings?.business_type ?? 'restaurant';
    return { kitchen: legacy !== 'craft_shop', craft: legacy === 'craft_shop' };
  }

  const on = { kitchen: kitchen !== false, craft: craft === true };
  return on.kitchen || on.craft ? on : { kitchen: true, craft: false };
}

export const ADMIN_SECTIONS: AdminSection[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/', group: 'Overview' },
  { key: 'orders', label: 'Orders', path: '/orders', group: 'Overview' },
  { key: 'reports', label: 'Reports', path: '/reports', group: 'Overview' },
  // Everything one side of the business owns lives under that side, so the two
  // catalogues never share a list. A cook adding a dish and a shop assistant
  // adding a basket are doing unrelated jobs on unrelated stock.
  { key: 'menu_categories', label: 'Categories', path: '/menu/categories', group: 'Kitchen', module: 'kitchen' },
  { key: 'menu_items', label: 'Dishes & drinks', path: '/menu/items', group: 'Kitchen', module: 'kitchen' },
  { key: 'menu_options', label: 'Options', path: '/menu/options', group: 'Kitchen', module: 'kitchen' },
  { key: 'stations', label: 'Stations', path: '/stations', group: 'Kitchen', module: 'kitchen' },
  { key: 'stock', label: 'Ingredients', path: '/stock', group: 'Kitchen', module: 'kitchen' },
  { key: 'waste', label: 'Waste', path: '/waste', group: 'Kitchen', module: 'kitchen' },
  { key: 'shop_categories', label: 'Categories', path: '/shop/categories', group: 'Craft shop', module: 'craft' },
  { key: 'shop_items', label: 'Products', path: '/shop/items', group: 'Craft shop', module: 'craft' },
  { key: 'consignors', label: 'Consignors', path: '/consignors', group: 'Craft shop', module: 'craft' },
  { key: 'intake', label: 'Goods received', path: '/intake', group: 'Craft shop', module: 'craft' },
  { key: 'payouts', label: 'Payouts', path: '/payouts', group: 'Craft shop', module: 'craft' },
  { key: 'shifts', label: 'Shifts', path: '/shifts', group: 'Money' },
  { key: 'expenses', label: 'Expenses', path: '/expenses', group: 'Money' },
  { key: 'vouchers', label: 'Discount vouchers', path: '/vouchers', group: 'Money' },
  { key: 'venues', label: 'Venues', path: '/venues', group: 'Setup' },
  { key: 'tables', label: 'Tables & QR', path: '/tables', group: 'Setup' },
  { key: 'staff', label: 'Staff', path: '/staff', group: 'Setup' },
  { key: 'features', label: 'Features', path: '/features', group: 'Setup' },
  { key: 'settings', label: 'Settings', path: '/settings', group: 'Setup', ownerOnly: true },
  { key: 'erase', label: 'Erase records', path: '/erase', group: 'Setup', ownerOnly: true },
];

/** Roles that can be granted admin sections at all. */
export const GRANTABLE_ROLES = ['manager', 'cashier', 'waiter', 'cook'] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

/**
 * What a manager can see until somebody says otherwise.
 *
 * A manager who can open nothing is a manager who rings the owner at eleven at
 * night, so the default is the day-to-day pages and none of the ones that
 * change how the business is set up.
 */
export const DEFAULT_ACCESS: Record<string, string[]> = {
  manager: [
    'dashboard', 'orders', 'reports', 'shifts', 'expenses', 'vouchers',
    'menu_items', 'stock', 'waste', 'stations',
    // A shop manager runs the intake desk and needs to see who is owed what.
    'shop_categories', 'shop_items', 'consignors', 'intake', 'payouts',
  ],
  cashier: ['dashboard', 'orders'],
  waiter: [],
  cook: [],
};

export function parseAccess(settings: Settings | null): Record<string, string[]> {
  if (!settings?.role_access) return DEFAULT_ACCESS;
  try {
    const parsed = JSON.parse(settings.role_access) as Record<string, string[]>;
    return { ...DEFAULT_ACCESS, ...parsed };
  } catch {
    return DEFAULT_ACCESS;
  }
}

/**
 * Does this section belong to the trade this business is in?
 *
 * Asked separately from permission, and before it. A restaurant hiding the
 * consignor pages is not a restriction on anybody; there is nothing behind
 * them, so it must not read as one, and an owner must not have to grant
 * themselves access to a page that simply does not apply.
 */
export function inTrade(section: AdminSection, settings: Settings | null): boolean {
  if (!section.module) return true;
  return modulesOf(settings)[section.module];
}

/**
 * Can this person open this section?
 *
 * An admin always can. That is deliberate and not configurable: the alternative
 * is a checkbox that removes the owner's own way back in. The trade check comes
 * first because it is not a permission at all.
 */
export function canOpen(section: string, profile: StaffProfile | null, settings: Settings | null): boolean {
  if (!profile) return false;
  const meta = ADMIN_SECTIONS.find((s) => s.key === section);
  if (meta && !inTrade(meta, settings)) return false;
  if (profile.role === 'admin') return true;
  if (meta?.ownerOnly) return false;
  return (parseAccess(settings)[profile.role] ?? []).includes(section);
}

/** The sections this person may open, in the order they are listed above. */
export function sectionsFor(profile: StaffProfile | null, settings: Settings | null): AdminSection[] {
  return ADMIN_SECTIONS.filter((s) => canOpen(s.key, profile, settings));
}

/**
 * May this person add or change what is in the catalogue?
 *
 * Opening the products page and adding to it are different things. A shop
 * assistant needs to look a price up twenty times a day and needs to create a
 * product roughly never, and every person who can create one is a person whose
 * mistake reaches the shop floor at a price customers are charged.
 *
 * Owners and managers, then. Anybody else with the page granted to them can
 * read it, which is what they actually opened it for.
 */
export function canEditCatalogue(profile: StaffProfile | null): boolean {
  return profile?.role === 'admin' || profile?.role === 'manager';
}

/**
 * Which sides of the business a person actually works on.
 *
 * The business's own switches come first: somebody marked as craft-only in a
 * kitchen-only business works in the kitchen, because there is nowhere else to
 * work. A person's setting narrows what the business runs; it cannot invent a
 * side that is switched off.
 */
export function modulesForStaff(profile: StaffProfile | null, settings: Settings | null): Modules {
  const running = modulesOf(settings);
  const theirs = profile?.works_in ?? 'both';
  if (theirs === 'both') return running;

  const narrowed = { kitchen: running.kitchen && theirs === 'kitchen', craft: running.craft && theirs === 'craft' };
  return narrowed.kitchen || narrowed.craft ? narrowed : running;
}

/**
 * What a screen should call things, given the trade.
 *
 * A shop assistant looking for "Dishes & drinks" to add a woven basket is being
 * asked to translate, every time, for ever. One map, read by the nav and the
 * pages, so the words change in one place.
 */
export function wordsFor(settings: Settings | null): Record<string, string> {
  const { kitchen, craft } = modulesOf(settings);
  // A shop with no kitchen calls a sale a sale. A place running both keeps the
  // restaurant's words, because the two sides already have their own headings
  // and renaming the shared pages would leave neither side's language right.
  if (kitchen || !craft) return {};
  return { orders: 'Sales' };
}
