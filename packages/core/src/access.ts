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
  /**
   * Off unless somebody says otherwise, rather than never.
   *
   * These are the sections nobody should hold by accident: the settings of the
   * business, erasing its records, its books. They are not granted to anyone
   * by default and they are not part of any role's starting set — but they can
   * be granted, because an owner who wants a bookkeeper to keep the books, or
   * a manager to change the opening hours, should not be told no by a
   * checkbox. An admin always keeps every one of them regardless, so no
   * combination of these can lock the owner out.
   */
  ownerOnly?: boolean;
  /**
   * A part of another section rather than a page of its own.
   *
   * Accounting is one page with tabs, and the tabs are not equally
   * consequential: reading a profit and loss is what a manager is for, and
   * posting a journal entry to any account is not. So each tab is grantable in
   * its own right, and none of them appears in the sidebar — they are reached
   * through their parent, and a sidebar listing six accounting links would say
   * this is six pages when it is one.
   */
  parent?: string;
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

/** The three trades this system knows how to run. */
export type Module = 'kitchen' | 'craft' | 'bar';

export interface Modules {
  kitchen: boolean;
  craft: boolean;
  bar: boolean;
}

/**
 * A bar is its own trade, not a corner of the kitchen.
 *
 * It could have been a category of drinks on the restaurant's menu, and that
 * is what most systems do. It is wrong for three reasons that all cost money.
 * A bar's stock is bottles, counted at the start of a shift and again at the
 * end, by the person who is answerable for them — a kitchen counts once, at
 * close, and nobody signs for the rice. A cocktail is a recipe whose
 * ingredients have to come off the shelf as it is poured, not when the night
 * ends, because a bottle running out mid-service is the event the count exists
 * to predict. And a bar's takings are counted against its own drawer by its
 * own person; folded into the kitchen's, a short till has two possible owners
 * and therefore none.
 */
export const MODULE_LABELS: Record<Module, string> = {
  kitchen: 'Kitchen',
  craft: 'Craft shop',
  bar: 'Bar',
};

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
  const bar = settings?.bar_enabled;

  if (kitchen === undefined && craft === undefined) {
    const legacy = settings?.business_type ?? 'restaurant';
    // The bar switch is read even here: it arrived after the other two, so a
    // business that has turned it on has answered the question directly, and
    // guessing from `business_type` would switch it back off.
    return {
      kitchen: legacy !== 'craft_shop',
      craft: legacy === 'craft_shop',
      bar: bar === true,
    };
  }

  const on = { kitchen: kitchen !== false, craft: craft === true, bar: bar === true };
  return on.kitchen || on.craft || on.bar ? on : { kitchen: true, craft: false, bar: false };
}

/**
 * Which catalogue a customer scanning a code should be shown.
 *
 * The restaurant's, wherever there is one. A phone menu is reached through a
 * table code or a walk-in code, and both of those are dining-room things; a
 * business running both sides has a shop counter for the shop, which is where
 * baskets are bought.
 *
 * A shop with no kitchen still gets its own goods, rather than an empty page.
 * That is the whole reason this reads the settings instead of saying 'kitchen'.
 */
export const selfOrderModule = (settings: Settings | null): Module => {
  const { kitchen, bar } = modulesOf(settings);
  if (kitchen) return 'kitchen';
  // A bar without a kitchen still has a menu somebody can scan for; a shop is
  // the last resort because baskets are bought at a counter, not ordered.
  return bar ? 'bar' : 'craft';
};

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
  { key: 'stocktake', label: 'Count the shelf', path: '/stocktake', group: 'Craft shop', module: 'craft' },
  { key: 'bar_categories', label: 'Categories', path: '/bar/categories', group: 'Bar', module: 'bar' },
  { key: 'bar_items', label: 'Drinks & cocktails', path: '/bar/items', group: 'Bar', module: 'bar' },
  { key: 'bar_stock', label: 'Bottles & mixers', path: '/bar/stock', group: 'Bar', module: 'bar' },
  { key: 'bar_counts', label: 'Counts & variances', path: '/bar/counts', group: 'Bar', module: 'bar' },
  { key: 'locations', label: 'Where stock sits', path: '/locations', group: 'Bar', module: 'bar' },
  { key: 'payouts', label: 'Payouts', path: '/payouts', group: 'Craft shop', module: 'craft' },
  { key: 'shifts', label: 'Shifts', path: '/shifts', group: 'Money' },
  { key: 'expenses', label: 'Expenses', path: '/expenses', group: 'Money' },
  /*
    Petty cash, on the imprest system.

    Under Money rather than beside Expenses, because it is not a list of
    spending — it is a thing that holds money and has to be counted, which is
    closer to a shift than to a receipt.
  */
  { key: 'imprest', label: 'Petty cash', path: '/imprest', group: 'Money' },
  { key: 'vouchers', label: 'Discount vouchers', path: '/vouchers', group: 'Money' },
  /**
   * The books, and the parts of them, each granted separately.
   *
   * The page itself is the way in and grants nothing by itself: somebody with
   * it and no area sees the page and no tabs, which is deliberate — the areas
   * are the permission, and the page is only where they live.
   *
   * Nothing here is on by default for anybody. It was owner-only outright,
   * which was safe and meant a bookkeeper could not be given the books; the
   * answer to that is to say which parts, not to hand over all of them.
   */
  { key: 'accounting', label: 'Accounting', path: '/accounting', group: 'Money' },
  { key: 'accounting_statements', label: 'Profit & loss and balance sheet', path: '/accounting', group: 'Money', parent: 'accounting' },
  { key: 'accounting_journal', label: 'Journal: read and post entries', path: '/accounting', group: 'Money', parent: 'accounting' },
  { key: 'accounting_trial', label: 'Trial balance', path: '/accounting', group: 'Money', parent: 'accounting' },
  { key: 'accounting_assets', label: 'Fixed assets and depreciation', path: '/accounting', group: 'Money', parent: 'accounting' },
  { key: 'accounting_bank', label: 'Reconcile against a statement', path: '/accounting', group: 'Money', parent: 'accounting' },
  { key: 'accounting_chart', label: 'Chart of accounts', path: '/accounting', group: 'Money', parent: 'accounting' },
  // Its own grant, and the most consequential of them: it decides what
  // everybody else is allowed to change, including the person who closed it.
  { key: 'accounting_locks', label: 'Close and reopen periods', path: '/accounting', group: 'Money', parent: 'accounting' },
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
    'shop_categories', 'shop_items', 'consignors', 'intake', 'stocktake', 'payouts',
    'bar_categories', 'bar_items', 'bar_stock', 'bar_counts', 'locations',
  ],
  cashier: ['dashboard', 'orders'],
  waiter: [],
  cook: [],
};

/**
 * Who may open what, from what was saved plus what has been added since.
 *
 * The saved value is a complete list per role, so the moment a new section
 * exists it is missing from every list that was written before it, and the
 * spread that merged them replaced the defaults wholesale. That is how the
 * craft shop pages arrived invisible to every manager in a business that had
 * ever opened this page and pressed Save: nothing was wrong with the
 * permission, the permission had simply never been asked about.
 *
 * So a section nobody has an opinion about, one that appears in no role's
 * saved list at all, falls back to its default. A section mentioned anywhere
 * has been positioned deliberately and is left exactly as it was, including
 * where it was deliberately taken away.
 *
 * The failure this trades against is a manager seeing one page they did not
 * need. The one it replaces is a whole side of the business unreachable, with
 * nothing on any screen to say why.
 */
export function parseAccess(settings: Settings | null): Record<string, string[]> {
  if (!settings?.role_access) return DEFAULT_ACCESS;
  try {
    const parsed = JSON.parse(settings.role_access) as Record<string, string[]> & { _known?: string[] };

    /**
     * Which sections had been decided when this was saved.
     *
     * A section added to the app later has never been put in front of anybody,
     * so a role keeps whatever default it was given for it — otherwise every
     * new page would arrive switched off for everyone and an owner would have
     * to go and find it.
     *
     * This used to be worked out from what was ticked ANYWHERE, and that was a
     * bug with teeth: unticking the last box for a section made it look
     * undecided again, so the default came straight back and the box appeared
     * to do nothing. Unchecking a manager's access to orders, which no other
     * role has, simply did not take — and there was nothing on screen to
     * suggest why.
     *
     * Written down explicitly now. The old shape is still read the old way, so
     * a config saved before this keeps working until the next save settles it.
     */
    /**
     * Only sections with a default carry one worth restoring, so only those
     * are listed. Anything else is never added back by anything, and this is
     * all one string with a length limit — a value too long to store is a save
     * that silently does not happen, which is the very fault this fixes.
     */
    const known = new Set(
      Array.isArray(parsed._known)
        ? parsed._known
        : Object.values(parsed).flat().filter((k) => typeof k === 'string'),
    );

    const merged: Record<string, string[]> = {};
    for (const role of Object.keys({ ...DEFAULT_ACCESS, ...parsed })) {
      if (role === '_known') continue;
      const saved = parsed[role] ?? DEFAULT_ACCESS[role] ?? [];
      const undecided = (DEFAULT_ACCESS[role] ?? []).filter((key) => !known.has(key));
      merged[role] = [...new Set([...saved, ...undecided])];
    }
    return merged;
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
export function inTrade(
  section: AdminSection,
  settings: Settings | null,
  profile: StaffProfile | null = null,
): boolean {
  if (!section.module) return true;
  // What the business runs, narrowed by what this person works on. Somebody
  // marked kitchen-only has no use for a consignor statement, and somebody
  // marked as working both, which is the default, sees both.
  return modulesForStaff(profile, settings)[section.module];
}

/**
 * Can this person open this section?
 *
 * An admin always can. That is deliberate and not configurable, and it is what
 * makes everything else here safe to hand out: no combination of checkboxes
 * can remove the owner's own way back in.
 *
 * Which is why `ownerOnly` no longer refuses outright. It used to, and that
 * meant settings, erasing records and the books could not be given to anybody
 * however much the owner wanted to — a bookkeeper could not be given the
 * books, and a manager could not be trusted with the settings of a business
 * they run. It now means "off unless somebody says otherwise", and the saying
 * is the owner's to do.
 */
export function canOpen(section: string, profile: StaffProfile | null, settings: Settings | null): boolean {
  if (!profile) return false;
  const meta = ADMIN_SECTIONS.find((s) => s.key === section);
  if (meta && !inTrade(meta, settings, profile)) return false;
  if (profile.role === 'admin') return true;
  return (parseAccess(settings)[profile.role] ?? []).includes(section);
}

/**
 * The sections this person may open, in the order they are listed above.
 *
 * Pages only. A tab is reached through the page it lives on, and a sidebar
 * listing six accounting links would say this is six pages when it is one.
 */
export function sectionsFor(profile: StaffProfile | null, settings: Settings | null): AdminSection[] {
  return ADMIN_SECTIONS.filter((s) => !s.parent && canOpen(s.key, profile, settings));
}

/** The areas of one page this person may open. Empty when they may open none. */
export function areasOf(
  parent: string,
  profile: StaffProfile | null,
  settings: Settings | null,
): string[] {
  return ADMIN_SECTIONS
    .filter((s) => s.parent === parent && canOpen(s.key, profile, settings))
    .map((s) => s.key);
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
 * May permanently remove something from the catalogue.
 *
 * A narrower question than being allowed to edit it, and separate on purpose.
 * A manager fixing a price and a manager deleting a dish are not the same act:
 * the first is undone by typing the old number back, the second takes the
 * item, its recipe, its options and its place on every menu with it, and
 * nothing on the screen afterwards says what used to be there.
 *
 * So it is off for everybody but an admin until an admin grants it by name.
 * Archiving is the day-to-day answer — it clears the board and keeps all of
 * it — and is left to anybody who may edit.
 */
export function canDeleteCatalogue(profile: StaffProfile | null): boolean {
  if (profile?.role === 'admin') return true;
  return canEditCatalogue(profile) && profile?.can_delete_items === true;
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

  /*
    The list wins over the old single answer, when there is one.

    `works_in` could only ever say one side or "both", which is a two-trade
    word in a business running three: a bartender who should see the bar and
    nothing else was fine, but somebody covering the bar AND the bistro had to
    be given "both" — and "both" quietly handed them the craft shop as well.

    An EMPTY list is not an answer and falls through to the old field, which
    itself defaults to every side. That matters for every row written before
    this existed: reading empty as "works nowhere" would lock the whole staff
    out of every till the moment this shipped.
  */
  const listed = (profile?.works_in_modules ?? []).filter((m): m is Module => !!m);
  if (listed.length > 0) {
    const narrowed = {
      kitchen: running.kitchen && listed.includes('kitchen'),
      craft: running.craft && listed.includes('craft'),
      bar: running.bar && listed.includes('bar'),
    };
    // Somebody assigned only to sides the business has since switched off has
    // nowhere to work, and a screen with nothing on it explains nothing. What
    // the business runs is the honest fallback.
    return narrowed.kitchen || narrowed.craft || narrowed.bar ? narrowed : running;
  }

  const theirs = profile?.works_in ?? 'both';
  if (theirs === 'both') return running;

  const narrowed = {
    kitchen: running.kitchen && theirs === 'kitchen',
    craft: running.craft && theirs === 'craft',
    bar: running.bar && theirs === 'bar',
  };
  return narrowed.kitchen || narrowed.craft || narrowed.bar ? narrowed : running;
}

/**
 * The sides a person is set to, as a list, whichever field they were saved in.
 *
 * For the form that edits them and for anything that wants to SHOW the setting
 * rather than act on it. Distinct from `modulesForStaff`, which answers what
 * they may open today — that one narrows by what the business currently runs,
 * and a form must not silently drop a side an owner switched off last month
 * and may switch back on tomorrow.
 */
export function sidesOf(profile: StaffProfile | null): Module[] {
  const listed = (profile?.works_in_modules ?? []).filter((m): m is Module => !!m);
  if (listed.length > 0) return listed;
  const theirs = profile?.works_in;
  return theirs && theirs !== 'both' ? [theirs] : [];
}

/**
 * The single-value form of a set of sides, for the column that only holds one.
 *
 * Written alongside the list so a database that has not been provisioned yet
 * still records something true. One side maps exactly. Any combination cannot
 * be said at all, and 'both' is the only value that does not LOSE a side —
 * which is the right way to be wrong here, because the list is what will be
 * read the moment the column exists.
 */
export function legacySide(sides: Module[]): 'both' | Module {
  return sides.length === 1 ? sides[0] : 'both';
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
