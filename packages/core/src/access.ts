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
  /**
   * Reached from another page rather than from the sidebar.
   *
   * Named by that page's key. The link is left out of the sidebar while the
   * host page can be opened, and the host page links to it; somebody given
   * this page and not its host still gets it in the sidebar, so nothing is
   * ever out of reach.
   */
  under?: string;
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

/**
 * The sides of the business, in the words the sidebar uses.
 *
 * MODULE_LABELS names the trades; these name the sides as a filter reads
 * them, short enough to sit three abreast at the top of a column.
 */
export const SIDE_NAMES: Record<Module, string> = { kitchen: 'Bistro', bar: 'Bar', craft: 'Shop' };

/**
 * The sidebar, grouped by the job somebody is doing rather than by which
 * trade owns the page.
 *
 * It used to be one group per trade — Kitchen, Craft shop, Bar — and a
 * business running all three had three "Categories" links, three catalogue
 * links and two stock links, each a separate page. Staff learned which
 * group held their copy and never opened the others. The pages are now
 * grouped by what you came to do: sell, count, handle money, keep the books,
 * set things up. The per-side pages that were three links are one link with
 * a side switch on the page; see NAV_MERGES and navFor.
 *
 * Permissions are unchanged: every key here is exactly what it was, and the
 * merged links appear when any of their keys is granted.
 */
/*
 * Seven, one per icon on the admin's rail. Approvals is a group of its own
 * because it is the one place somebody is sent to decide things; Today is
 * the day's figures and whether it is finished.
 */
export const NAV_GROUPS = ['Today', 'Approvals', 'Sell', 'Stock', 'Money', 'Books', 'Setup'] as const;

export const ADMIN_SECTIONS: AdminSection[] = [
  { key: 'dashboard', label: 'Today', path: '/', group: 'Today' },
  { key: 'close_day', label: 'Close the day', path: '/close-day', group: 'Today' },
  // Everything waiting for a decision, from every side, beside the day itself.
  { key: 'waiting', label: 'Approvals', path: '/waiting', group: 'Approvals' },
  { key: 'orders', label: 'Orders', path: '/orders', group: 'Sell' },
  /*
    The people who have bought something.

    Off for every role until an owner grants it by name — it is not in
    DEFAULT_ACCESS, so only an admin sees it to begin with. Names, phone
    numbers and email addresses are the one kind of data on this system that
    belongs to somebody outside the business, and "who can read the customer
    list" is a decision worth making on purpose rather than inheriting from a
    job title.
  */
  { key: 'customers', label: 'Customers', path: '/customers', group: 'Sell' },
  // One catalogue page per side, each its own grant, reached through one
  // link with a side switch. A cook adding a dish and a shop assistant
  // adding a basket are doing unrelated jobs on unrelated stock, and each
  // can be given one side without the other.
  { key: 'menu_categories', label: 'Categories · bistro', path: '/catalogue/categories', group: 'Sell', module: 'kitchen' },
  { key: 'shop_categories', label: 'Categories · shop', path: '/catalogue/categories', group: 'Sell', module: 'craft' },
  { key: 'bar_categories', label: 'Categories · bar', path: '/catalogue/categories', group: 'Sell', module: 'bar' },
  { key: 'menu_items', label: 'Products · bistro', path: '/catalogue/items', group: 'Sell', module: 'kitchen' },
  { key: 'shop_items', label: 'Products · shop', path: '/catalogue/items', group: 'Sell', module: 'craft' },
  { key: 'bar_items', label: 'Products · bar', path: '/catalogue/items', group: 'Sell', module: 'bar' },
  { key: 'menu_options', label: 'Options', path: '/menu/options', group: 'Sell', module: 'kitchen', under: 'menu_categories' },
  /*
    Group bookings, which had no page at all.

    A booking was reachable only while it was WAITING: once agreed, refused or
    called off it existed in the database and on nobody's screen. That was
    fine until the notice to the team failed — and when it did there was
    nothing to open, nothing to check and nothing to press.
  */
  { key: 'group_bookings', label: 'Bookings', path: '/group-bookings', group: 'Sell', module: 'kitchen' },
  { key: 'vouchers', label: 'Discounts', path: '/vouchers', group: 'Sell' },
  { key: 'stock', label: 'Stock · kitchen', path: '/stock', group: 'Stock', module: 'kitchen' },
  { key: 'bar_stock', label: 'Stock · bar', path: '/stock', group: 'Stock', module: 'bar' },
  { key: 'waste', label: 'Waste', path: '/waste', group: 'Stock', module: 'kitchen' },
  { key: 'purchase_orders', label: 'Purchase orders', path: '/purchase-orders', group: 'Stock' },
  { key: 'bar_counts', label: 'Count · bar', path: '/count', group: 'Stock', module: 'bar' },
  { key: 'stocktake', label: 'Count · shop', path: '/count', group: 'Stock', module: 'craft' },
  // Every side's places, on the Stock page's Places tab rather than a page
  // of its own. No side of its own: the kitchen keeps a store room too.
  { key: 'locations', label: 'Places & moves', path: '/stock?tab=places', group: 'Stock', parent: 'stock' },
  { key: 'consignors', label: 'Makers', path: '/consignors', group: 'Stock', module: 'craft' },
  { key: 'intake', label: 'Goods received', path: '/intake', group: 'Stock', module: 'craft', under: 'consignors' },
  /*
    Everything held for somebody senior, on one page: bar and store counts,
    shop stocktakes, shelf changes, spends nobody has looked at, and shifts
    that cannot close for the tabs on them. Each used to wait on its own page.
    See waiting.ts.
  */
  { key: 'shifts', label: 'Shifts', path: '/shifts', group: 'Money' },
  // Every payment that left: drawers, petty cash, the bank, makers. See money-out.ts.
  { key: 'expenses', label: 'Money out', path: '/expenses', group: 'Money' },
  /*
    Petty cash, on the imprest system.

    Under Money rather than beside Spends, because it is not a list of
    spending — it is a thing that holds money and has to be counted, which is
    closer to a shift than to a receipt.
  */
  { key: 'imprest', label: 'Petty cash', path: '/imprest', group: 'Money' },
  /*
    Under Money, not under a side of the business. A tab spans all three — a
    guest who has a drink at the bar, lunch from the kitchen and a basket from
    the shop has one account — so filing it under any one of them would hide it
    from the other two.
  */
  { key: 'tabs', label: 'Tabs', path: '/tabs', group: 'Money', under: 'customers' },
  /*
    Count differences charged to a person, until each is paid, taken from pay,
    found or written off. See staff-charges.ts.
  */
  { key: 'staff_owing', label: 'Staff owing', path: '/staff-owing', group: 'Money' },
  { key: 'payouts', label: 'Payouts', path: '/payouts', group: 'Money', module: 'craft', under: 'consignors' },
  { key: 'reports', label: 'Reports', path: '/reports', group: 'Books' },
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
  { key: 'accounting', label: 'Accounting', path: '/accounting', group: 'Books' },
  { key: 'accounting_statements', label: 'Profit & loss and balance sheet', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_journal', label: 'Journal: read and post entries', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_trial', label: 'Trial balance', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_cashflow', label: 'Cash flow statement', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_ledger', label: 'General ledger, any account', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_tax', label: 'Tax return, and recording tax paid', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_recurring', label: 'Recurring entries', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_opening', label: 'Opening balances', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_banks', label: 'Bank and cash accounts, and transfers between them', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_yearend', label: 'Year end: close a year into retained earnings', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_assets', label: 'Fixed assets and depreciation', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_bank', label: 'Reconcile against a statement', path: '/accounting', group: 'Books', parent: 'accounting' },
  // The entries a shift close leaves hanging: card and mobile money reaching
  // the bank, tips handed over, tax remitted. See settle.ts.
  { key: 'accounting_settle', label: 'Settle card, mobile money, tips and tax', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_payables', label: 'Bills to pay: add, and pay in full or in parts', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_receivables', label: 'Owed to us: what customers owe on tabs', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'accounting_chart', label: 'Chart of accounts', path: '/accounting', group: 'Books', parent: 'accounting' },
  // Its own grant, and the most consequential of them: it decides what
  // everybody else is allowed to change, including the person who closed it.
  { key: 'accounting_locks', label: 'Close and reopen periods', path: '/accounting', group: 'Books', parent: 'accounting' },
  { key: 'staff', label: 'Staff', path: '/staff', group: 'Setup' },
  { key: 'stations', label: 'Stations', path: '/stations', group: 'Setup', module: 'kitchen', under: 'venues' },
  { key: 'venues', label: 'Venues', path: '/venues', group: 'Setup' },
  { key: 'tables', label: 'Tables & QR', path: '/tables', group: 'Setup' },
  { key: 'features', label: 'Features', path: '/features', group: 'Setup' },
  // The kitchen's and the bar's cleaning routines, and the log they leave. See cleaning.ts.
  { key: 'cleaning', label: 'Cleaning', path: '/cleaning', group: 'Setup' },
  // Records that do not add up and jobs that have gone quiet, checked
  // nightly and on opening. Owner-only: every button on it changes the books.
  { key: 'health', label: 'Health', path: '/health', group: 'Setup', ownerOnly: true },
  { key: 'settings', label: 'Settings', path: '/settings', group: 'Setup', ownerOnly: true },
  { key: 'erase', label: 'Erase records', path: '/erase', group: 'Setup', ownerOnly: true, under: 'settings' },
];

/**
 * Pages that are one link for several sides.
 *
 * Each side keeps its own grant; the link appears when any of them is held,
 * and the page's side switch offers only the sides that are. See navFor and
 * catalogueSides.
 */
export interface NavMerge {
  to: string;
  label: string;
  keys: Partial<Record<Module, string>>;
  /** A second link to the same page, opened on one job: Receive stock. */
  also?: { label: string; query: string };
}

export const NAV_MERGES: NavMerge[] = [
  { to: '/catalogue/categories', label: 'Categories', keys: { kitchen: 'menu_categories', craft: 'shop_categories', bar: 'bar_categories' } },
  { to: '/catalogue/items', label: 'Products', keys: { kitchen: 'menu_items', craft: 'shop_items', bar: 'bar_items' } },
  /*
    The shop's own supplies (bags, wrapping, labels) are reached with its
    products grant: it has no separate stock grant, and its pieces are the
    makers', counted on Count.
  */
  { to: '/stock', label: 'Stock', keys: { kitchen: 'stock', bar: 'bar_stock', craft: 'shop_items' } },
  /*
    Count, every place. The kitchen counts on the bar's sheet now, so it is
    reached with the kitchen's stock grant; the shop's shelf count is its
    stocktake.
  */
  { to: '/count', label: 'Count', keys: { bar: 'bar_counts', kitchen: 'stock', craft: 'stocktake' } },
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
    // A manager opens tabs. It is the job: deciding who is good for credit is
    // a floor decision made while somebody is standing there, and an owner who
    // has to be rung at eleven at night to open one is an owner who gets rung.
    'dashboard', 'orders', 'close_day', 'reports', 'shifts', 'expenses', 'vouchers', 'tabs', 'waiting', 'staff_owing',
    'menu_items', 'stock', 'waste', 'stations', 'group_bookings', 'purchase_orders',
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
 * Whether the shop counts its shelves at all.
 *
 * A stocktake is a question worth asking of a shelf of identical mugs, where
 * the number is the only record of what is there. It is a different
 * proposition in a shop of one-off consigned pieces that are looked at rather
 * than counted, and where the shelf already moves on intake and on sale — for
 * those, the count is a form somebody fills in to say what everybody can see.
 *
 * ABSENT MEANS ON, and that is the whole care in this function. A settings row
 * that failed to load, or one written before this setting existed, must not
 * take a working page away from a shop that was using it — so only somebody
 * deliberately answering false switches it off.
 *
 * This stops NEW counts being taken. It cannot un-submit the ones already
 * waiting: a pending count freezes the pieces it names (see frozenPieces), so
 * stranding the queue would freeze those pieces for ever. They stay decidable
 * under Approvals until somebody has agreed or refused them.
 */
export const shopCountsOn = (settings: Settings | null): boolean =>
  settings?.craft_counts_enabled !== false;

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
  /*
    Switched off outright, even where the side it belongs to runs. The same
    kind of statement as the one below — there is nothing behind the page —
    rather than a permission, which is why it is answered here and not in
    parseAccess. An admin who turns the shop's stocktake off should not then
    find it in their own sidebar.
  */
  if (section.key === 'stocktake' && !shopCountsOn(settings)) return false;

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
  // Whoever may order stock, by their role or as a person, can open the page
  // they order from. See canOrderStock.
  if (section === 'purchase_orders' && canOrderStock(profile, settings)) return true;
  return (parseAccess(settings)[profile.role] ?? []).includes(section);
}

/**
 * Why a page will not open, in the words to put on it.
 *
 * Two different facts, and they were being said as one. "Ask an admin if you
 * think it should" is right for a permission and wrong for a page that is
 * switched off, where there is nothing behind it to be granted — an owner who
 * turned the stocktake off and then read that sentence on their own account
 * would go looking for a checkbox that does not exist.
 */
export function unavailableWords(
  section: string,
  profile: StaffProfile | null,
  settings: Settings | null,
): string {
  const meta = ADMIN_SECTIONS.find((s) => s.key === section);
  if (section === 'stocktake' && !shopCountsOn(settings)) {
    return 'The shop\'s stocktake is switched off, so there is nothing here. An admin can turn it back on '
      + 'under Settings, in Stock. Any count already submitted is still under Approvals.';
  }
  if (meta && !inTrade(meta, settings, profile)) {
    return 'This page belongs to a side of the business that is not switched on. Nothing is being kept from '
      + 'you — there is nothing behind it.';
  }
  return 'Your account does not have access to this page. Ask an admin if you think it should.';
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

export interface NavLinkSpec {
  to: string;
  label: string;
  end?: boolean;
  /** The section keys this link stands for: one, or several for a merged page. */
  keys: string[];
}

export interface NavGroup {
  group: string;
  links: NavLinkSpec[];
}

/** The sides of a merged page this person may open, in the order the switch shows them. */
export function catalogueSides(to: string, profile: StaffProfile | null, settings: Settings | null): Module[] {
  const merge = NAV_MERGES.find((m) => m.to === to);
  if (!merge) return [];
  return (['kitchen', 'bar', 'craft'] as Module[]).filter((side) => {
    const key = merge.keys[side];
    return !!key && canOpen(key, profile, settings);
  });
}

/** The sides this person can filter the sidebar by: what runs, narrowed to what they work on. */
export function sidebarSides(profile: StaffProfile | null, settings: Settings | null): Module[] {
  const mods = modulesForStaff(profile, settings);
  return (['kitchen', 'bar', 'craft'] as Module[]).filter((m) => mods[m]);
}

/**
 * The sidebar for this person: the pages they may open, grouped by job,
 * with the per-side pages folded into one link each, narrowed to one side
 * when a side is chosen.
 *
 * Narrowing hides the links that belong to another side and points the
 * merged links at the chosen side, so a bartender who picks Bar sees the
 * bar's counts and bottles and nothing about the kitchen. Anything with no
 * side — shifts, spends, the books — is always there.
 */
/** The parts of Accounting only an accountant opens. */
const ACCOUNTANT_AREAS = ['accounting_journal', 'accounting_trial', 'accounting_recurring', 'accounting_assets', 'accounting_chart', 'accounting_banks', 'accounting_opening', 'accounting_yearend'];

/** Whether a page that hosts others is itself in this person's sidebar. */
function hostOpen(key: string, profile: StaffProfile | null, settings: Settings | null, side: Module | 'all'): boolean {
  const host = ADMIN_SECTIONS.find((x) => x.key === key);
  if (!host || !canOpen(key, profile, settings)) return false;
  return side === 'all' || !host.module || host.module === side;
}

export function navFor(profile: StaffProfile | null, settings: Settings | null, side: Module | 'all' = 'all'): NavGroup[] {
  const groups = new Map<string, NavLinkSpec[]>();
  const merged = new Set<string>();
  const add = (group: string, link: NavLinkSpec) => groups.set(group, [...(groups.get(group) ?? []), link]);

  for (const s of ADMIN_SECTIONS) {
    if (s.parent) continue;
    const merge = NAV_MERGES.find((m) => Object.values(m.keys).includes(s.key));
    if (merge) {
      if (merged.has(merge.to)) continue;
      const sides = catalogueSides(merge.to, profile, settings).filter((m) => side === 'all' || m === side);
      if (sides.length === 0) continue;
      merged.add(merge.to);
      const keys = sides.map((m) => merge.keys[m] as string);
      add(s.group, { to: side === 'all' ? merge.to : `${merge.to}?side=${side}`, label: merge.label, keys });
      if (merge.also) {
        const q = side === 'all' ? merge.also.query : `side=${side}&${merge.also.query}`;
        add(s.group, { to: `${merge.to}?${q}`, label: merge.also.label, keys: [`${keys[0]}:${merge.also.query}`] });
      }
      continue;
    }
    if (!canOpen(s.key, profile, settings)) continue;
    if (side !== 'all' && s.module && s.module !== side) continue;
    // Reached from its host page, when the host is there to be reached.
    if (s.under && hostOpen(s.under, profile, settings, side)) continue;
    add(s.group, { to: s.path, label: s.label, end: s.path === '/', keys: [s.key] });
    /*
      The books in two links: the jobs done every week (Settle up first),
      and the tools only an accountant opens. One page underneath.
    */
    if (s.key === 'accounting') {
      const areas = areasOf('accounting', profile, settings);
      if (areas.some((a) => ACCOUNTANT_AREAS.includes(a))) {
        add(s.group, { to: '/accounting?tab=journal', label: 'Accountant tools', keys: ['accounting:accountant'] });
      }
    }
  }

  const order = [...NAV_GROUPS] as string[];
  return [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([group, links]) => ({ group, links }));
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

/* --------------------------------------- releasing a booked sitting early */

/** Whether this order is one sitting of a group booking. */
export const isGroupSitting = (
  order: { is_group?: boolean; group_booking_id?: string },
): boolean => !!order.group_booking_id || !!order.is_group;

/**
 * Why this person cannot send that booked order to the pass now, or null.
 *
 * "Cook now" is on the pass so a kitchen can start something early when it
 * suits them — the party rang ahead, the room is empty, the oven is free. On
 * an ordinary pre-order that is a cook's own call about their own night and it
 * stays theirs.
 *
 * A GROUP SITTING IS NOT THAT. It is forty covers, and releasing it early does
 * not move one ticket up the board — it puts the whole party's food on the
 * pass hours before the party is in the building, cooked, plated and then
 * sitting. It cannot be taken back: SCHEDULED is a one-way door, and the only
 * way out is to reject the order, which loses the booking. It is also exactly
 * the shape of a mis-tap, because the strip it lives on is a row of small
 * buttons the whole shift walks past.
 *
 * So a group sitting needs somebody who carries that decision. An owner or a
 * manager, the same pair who may reprice the board — not because a cook cannot
 * be trusted with the food, but because this one is a commitment to a customer
 * rather than a choice about the kitchen.
 */
export function cookNowProblem(
  order: { is_group?: boolean; group_booking_id?: string },
  profile: StaffProfile | null,
): string | null {
  if (!isGroupSitting(order)) return null;
  if (profile?.role === 'admin' || profile?.role === 'manager') return null;
  if (!profile) return 'Sign in to send a group booking to the pass early.';
  return 'Only an owner or a manager can start a group booking early. Ask one of them.';
}

/** The plain form of the above, for hiding a control rather than explaining it. */
export const canCookNow = (
  order: { is_group?: boolean; group_booking_id?: string },
  profile: StaffProfile | null,
): boolean => cookNowProblem(order, profile) === null;

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
 * May this person change the price of THIS line, at the till?
 *
 * Two grants, and they answer different questions.
 *
 * The one on the PERSON — `can_change_line_price` — says they may change any
 * price on the till. That is a manager's grant: somebody trusted with the
 * whole board, on any item, on any sale.
 *
 * The one on the PRODUCT names people, and it exists because the blanket grant
 * is the wrong shape for what a shop actually wants. The real request is
 * narrow and specific: the display baskets get haggled over, so the two people
 * who work that counter should be able to drop the price of a basket — and
 * nothing else. Handing them the whole board to allow that grants far more
 * than was asked for, and refusing grants nothing, so shops do the first and
 * then stop looking at repriced lines because there are too many of them.
 *
 * Either is enough. They are not a hierarchy: a named person on one product
 * does not need the blanket grant, and somebody with the blanket grant does
 * not need naming.
 *
 * An admin always may, which is the rule everything else here follows.
 *
 * Matched on both ids. A staff record is referred to by its own id in some
 * places and by the account behind it in others, and a permission that worked
 * only for whichever one the picker happened to store would fail silently for
 * half the shop.
 */
export function canRepriceLine(
  profile: (StaffProfile & { $id?: string; user_id?: string }) | null,
  item: { price_editors?: string[] } | null | undefined,
): boolean {
  if (!profile) return false;
  if (profile.role === 'admin') return true;
  if (profile.can_change_line_price === true) return true;
  const named = item?.price_editors ?? [];
  if (named.length === 0) return false;
  return named.includes(profile.$id ?? '') || named.includes(profile.user_id ?? '');
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

/* ------------------------------------------------ who may make purchase orders */

/** The roles that may be given ordering, an admin aside (who always may). */
export const ORDER_ROLES = ['manager', 'cashier', 'waiter', 'cook'] as const;
export type OrderRole = (typeof ORDER_ROLES)[number];

/** Managers, until an admin says otherwise: what ordering was before it could be set. */
export const ORDER_ROLES_DEFAULT: OrderRole[] = ['manager'];

/**
 * Which roles may make orders, as an admin set it on Purchase orders.
 *
 * Kept on the settings row as a JSON list. Nothing stored is the default,
 * managers; an empty list is a real answer, admins only.
 */
export function orderRoles(settings: { po_order_roles?: string | null } | null | undefined): OrderRole[] {
  const raw = settings?.po_order_roles;
  if (raw === undefined || raw === null || raw === '') return [...ORDER_ROLES_DEFAULT];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? ORDER_ROLES.filter((r) => v.includes(r)) : [...ORDER_ROLES_DEFAULT];
  } catch {
    return [...ORDER_ROLES_DEFAULT];
  }
}

export const orderRolesValue = (roles: string[]): string =>
  JSON.stringify(ORDER_ROLES.filter((r) => roles.includes(r)));

/** One person's exception to their role: always, never, or as the role says. */
export type OrderChoice = 'group' | 'yes' | 'no';

/**
 * A person's own answer.
 *
 * `order_stock` when set. Before it existed the Staff form stamped
 * `can_order_stock` with the role's default on every save, so those values
 * say little: only the ones that went against the default were somebody's
 * decision — a non-manager switched on, a manager switched off.
 */
export function orderChoice(p: { role?: string; order_stock?: string | null; can_order_stock?: boolean | null }): OrderChoice {
  if (p.order_stock === 'yes' || p.order_stock === 'no' || p.order_stock === 'group') return p.order_stock;
  if (p.role !== 'manager' && p.can_order_stock === true) return 'yes';
  if (p.role === 'manager' && p.can_order_stock === false) return 'no';
  return 'group';
}

/**
 * May make, change and send orders. Admins always. Anybody else by their
 * role, as set on Purchase orders, unless their own entry on Staff says
 * always or never.
 */
export function canOrderStock(
  p: { role?: string; order_stock?: string | null; can_order_stock?: boolean | null } | null | undefined,
  settings?: { po_order_roles?: string | null } | null,
): boolean {
  if (!p) return false;
  if (p.role === 'admin') return true;
  const own = orderChoice(p);
  if (own !== 'group') return own === 'yes';
  return (orderRoles(settings) as string[]).includes(p.role ?? '');
}

/* ------------------------------------------------------------------ view as */

/**
 * Why this person cannot view the app as that one, or null when they can.
 *
 * Only an owner, and never as themselves. Viewing as another admin is
 * allowed and shows everything, which is the answer to "what does she see".
 */
export function viewAsProblem(
  real: Pick<StaffProfile, '$id' | 'role'> | null,
  target: Pick<StaffProfile, '$id' | 'role'> | null,
): string | null {
  if (!real || real.role !== 'admin') return 'Only an owner can view the app as someone else.';
  if (!target) return 'Choose who to view as.';
  if (target.$id === real.$id) return 'That is you.';
  return null;
}

/** What the banner and every refused save say while viewing as someone. */
export const viewAsWords = (p: Pick<StaffProfile, 'display_name' | 'role'>): string =>
  `Viewing as ${p.display_name || 'this person'} (${p.role}). Nothing can be saved until you switch back.`;
