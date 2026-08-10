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
   * Which trades this section belongs to. Absent means both.
   *
   * A consignment shop has no stations, no waste log and no kitchen; a
   * restaurant has no consignors. Showing every section to everybody would
   * bury the eight pages somebody actually uses under eight they never will.
   */
  only?: ('restaurant' | 'craft_shop')[];
}

export const ADMIN_SECTIONS: AdminSection[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/', group: 'Overview' },
  { key: 'orders', label: 'Orders', path: '/orders', group: 'Overview' },
  { key: 'reports', label: 'Reports', path: '/reports', group: 'Overview' },
  { key: 'menu_categories', label: 'Categories', path: '/menu/categories', group: 'Menu' },
  { key: 'menu_items', label: 'Dishes & drinks', path: '/menu/items', group: 'Menu' },
  { key: 'menu_options', label: 'Options', path: '/menu/options', group: 'Menu' },
  { key: 'shifts', label: 'Shifts', path: '/shifts', group: 'Money' },
  { key: 'expenses', label: 'Expenses', path: '/expenses', group: 'Money' },
  { key: 'vouchers', label: 'Discount vouchers', path: '/vouchers', group: 'Money' },
  { key: 'consignors', label: 'Consignors', path: '/consignors', group: 'Consignment', only: ['craft_shop'] },
  { key: 'intake', label: 'Goods received', path: '/intake', group: 'Consignment', only: ['craft_shop'] },
  { key: 'payouts', label: 'Payouts', path: '/payouts', group: 'Consignment', only: ['craft_shop'] },
  { key: 'stations', label: 'Stations', path: '/stations', group: 'Kitchen', only: ['restaurant'] },
  { key: 'stock', label: 'Stock', path: '/stock', group: 'Kitchen', only: ['restaurant'] },
  { key: 'waste', label: 'Waste', path: '/waste', group: 'Kitchen', only: ['restaurant'] },
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
    // Recording a payout stays with them too; approving one is the owner's.
    'consignors', 'intake', 'payouts',
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
 * consignor pages is not a restriction on anybody — there is nothing behind
 * them — so it must not read as one, and an owner must not have to grant
 * themselves access to a page that simply does not apply.
 */
export function inTrade(section: AdminSection, settings: Settings | null): boolean {
  if (!section.only) return true;
  return section.only.includes(settings?.business_type ?? 'restaurant');
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
 * What a screen should call things, given the trade.
 *
 * A shop assistant looking for "Dishes & drinks" to add a woven basket is being
 * asked to translate, every time, for ever. One map, read by the nav and the
 * pages, so the words change in one place.
 */
export function wordsFor(settings: Settings | null): Record<string, string> {
  if ((settings?.business_type ?? 'restaurant') !== 'craft_shop') return {};
  return {
    menu_items: 'Products',
    menu_categories: 'Product categories',
    menu_options: 'Add-ons',
    orders: 'Sales',
    Menu: 'Catalogue',
  };
}
