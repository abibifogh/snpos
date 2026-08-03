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
  { key: 'stations', label: 'Stations', path: '/stations', group: 'Kitchen' },
  { key: 'stock', label: 'Stock', path: '/stock', group: 'Kitchen' },
  { key: 'waste', label: 'Waste', path: '/waste', group: 'Kitchen' },
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
 * Can this person open this section?
 *
 * An admin always can. That is deliberate and not configurable: the alternative
 * is a checkbox that removes the owner's own way back in.
 */
export function canOpen(section: string, profile: StaffProfile | null, settings: Settings | null): boolean {
  if (!profile) return false;
  if (profile.role === 'admin') return true;
  const meta = ADMIN_SECTIONS.find((s) => s.key === section);
  if (meta?.ownerOnly) return false;
  return (parseAccess(settings)[profile.role] ?? []).includes(section);
}

/** The sections this person may open, in the order they are listed above. */
export function sectionsFor(profile: StaffProfile | null, settings: Settings | null): AdminSection[] {
  return ADMIN_SECTIONS.filter((s) => canOpen(s.key, profile, settings));
}
