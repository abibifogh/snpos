import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftPrefix } from '../shift-rules.ts';
import {
  modulesOf, modulesForStaff, parseAccess, canOpen, inTrade, sectionsFor,
  canEditCatalogue, selfOrderModule, ADMIN_SECTIONS, DEFAULT_ACCESS, areasOf, sidesOf, legacySide,
} from '../access.ts';
import type { Settings, StaffProfile } from '../types.ts';

const settings = (over: Partial<Settings> = {}) => ({ ...over }) as Settings;
const staff = (over: Partial<StaffProfile> = {}) =>
  ({ $id: 's1', display_name: 'Person', role: 'manager', active: true, ...over }) as StaffProfile;

test('a business with no switches set is read from what it used to say', () => {
  assert.deepEqual(modulesOf(settings()), { kitchen: true, craft: false, bar: false });
  assert.deepEqual(modulesOf(settings({ business_type: 'craft_shop' })), { kitchen: false, craft: true, bar: false });
});

test('the switches win once they exist, and both may be on', () => {
  assert.deepEqual(modulesOf(settings({ kitchen_enabled: true, craft_enabled: true })), { kitchen: true, craft: true, bar: false });
  assert.deepEqual(modulesOf(settings({ kitchen_enabled: false, craft_enabled: true })), { kitchen: false, craft: true, bar: false });
});

test('a business can never run neither side', () => {
  const none = modulesOf(settings({ kitchen_enabled: false, craft_enabled: false }));
  assert.ok(none.kitchen || none.craft, 'falling back to the kitchen beats a system with no screens');
});

test('a person narrows what the business runs but cannot invent a side', () => {
  const both = settings({ kitchen_enabled: true, craft_enabled: true });
  assert.deepEqual(modulesForStaff(staff({ works_in: 'craft' }), both), { kitchen: false, craft: true, bar: false });
  assert.deepEqual(modulesForStaff(staff({ works_in: 'both' }), both), { kitchen: true, craft: true, bar: false });
  assert.deepEqual(modulesForStaff(staff({}), both), { kitchen: true, craft: true, bar: false }, 'absent means both');

  const kitchenOnly = settings({ kitchen_enabled: true, craft_enabled: false });
  assert.deepEqual(
    modulesForStaff(staff({ works_in: 'craft' }), kitchenOnly),
    { kitchen: true, craft: false, bar: false },
    'craft-only in a kitchen-only business works the kitchen, because there is nowhere else',
  );
});

/**
 * The regression that hid the craft shop from every manager. Access was saved
 * as a complete list per role, so a section added afterwards was missing from
 * every list and the merge replaced the defaults wholesale.
 */
test('a section added after the permissions were saved is not silently withheld', () => {
  const savedBeforeCraftExisted = JSON.stringify({
    manager: ['dashboard', 'orders', 'reports', 'shifts', 'expenses', 'menu_items'],
    cashier: ['dashboard'],
  });
  const s = settings({ role_access: savedBeforeCraftExisted, kitchen_enabled: true, craft_enabled: true });
  const access = parseAccess(s);

  for (const key of ['consignors', 'intake', 'payouts', 'shop_items', 'shop_categories']) {
    assert.ok(access.manager.includes(key), `${key} should fall back to its default, not vanish`);
  }
  assert.ok(canOpen('consignors', staff({ role: 'manager' }), s));
});

test('a section deliberately taken away stays taken away', () => {
  // "vouchers" is mentioned for the cashier, so somebody has an opinion about
  // it; the manager not having it is a decision, not silence.
  const saved = JSON.stringify({ manager: ['dashboard'], cashier: ['vouchers'] });
  const s = settings({ role_access: saved });
  assert.ok(!parseAccess(s).manager.includes('vouchers'));
});

test('unreadable saved permissions fall back rather than locking everybody out', () => {
  assert.deepEqual(parseAccess(settings({ role_access: 'not json' })), DEFAULT_ACCESS);
  assert.deepEqual(parseAccess(settings()), DEFAULT_ACCESS);
});

test('a section belonging to a side that is switched off is not offered', () => {
  const kitchenOnly = settings({ kitchen_enabled: true, craft_enabled: false });
  const consignors = ADMIN_SECTIONS.find((x) => x.key === 'consignors')!;
  assert.equal(inTrade(consignors, kitchenOnly), false);
  assert.equal(canOpen('consignors', staff({ role: 'admin' }), kitchenOnly), false,
    'not even an owner, because there is nothing behind it');
});

test('an owner can always open what the business does run', () => {
  const both = settings({ kitchen_enabled: true, craft_enabled: true });
  assert.ok(canOpen('settings', staff({ role: 'admin' }), both));
  assert.ok(!canOpen('settings', staff({ role: 'manager' }), both), 'owner-only stays owner-only');
});

test('nobody signed out can open anything', () => {
  assert.equal(canOpen('dashboard', null, settings()), false);
  assert.deepEqual(sectionsFor(null, settings()), []);
});

test('only managers and owners may change what is for sale', () => {
  assert.ok(canEditCatalogue(staff({ role: 'admin' })));
  assert.ok(canEditCatalogue(staff({ role: 'manager' })));
  assert.ok(!canEditCatalogue(staff({ role: 'cashier' })));
  assert.ok(!canEditCatalogue(staff({ role: 'cook' })));
  assert.ok(!canEditCatalogue(null));
});

test('a craft-only person is offered no kitchen pages', () => {
  const both = settings({ kitchen_enabled: true, craft_enabled: true });
  const keys = sectionsFor(staff({ role: 'admin', works_in: 'craft' }), both).map((x) => x.key);
  assert.ok(keys.includes('consignors'));
  assert.ok(!keys.includes('waste'), 'a shop has no waste log');
  assert.ok(!keys.includes('stations'));
});

test('a customer scanning a code is shown one catalogue, and it is the restaurant\'s', () => {
  /**
   * The bug this pins down: the phone menu listed both catalogues, so a guest
   * at a table was offered woven baskets alongside the jollof. Nothing on the
   * order said which side it was for either, so ordering one put a basket on
   * the kitchen pass as something to cook.
   */
  assert.equal(selfOrderModule({ kitchen_enabled: true, craft_enabled: true } as never), 'kitchen');
  assert.equal(selfOrderModule({ kitchen_enabled: true, craft_enabled: false } as never), 'kitchen');

  // A shop with no kitchen still gets a working menu rather than a blank page.
  assert.equal(selfOrderModule({ kitchen_enabled: false, craft_enabled: true } as never), 'craft');

  // Nothing configured, and setups from before the switches existed.
  assert.equal(selfOrderModule(null), 'kitchen');
  assert.equal(selfOrderModule({} as never), 'kitchen');
  assert.equal(selfOrderModule({ business_type: 'craft_shop' } as never), 'craft');
});

test('unticking a box stays unticked', () => {
  /**
   * The bug this exists to stop. Whether a section had been decided was worked
   * out from what was ticked ANYWHERE, so unticking the last box for a page
   * made it look undecided again and the role's default came straight back.
   * Unchecking a manager's access to orders — which no other role has — simply
   * did not take, and nothing on screen said why.
   */
  const saved = {
    _known: ADMIN_SECTIONS.map((s) => s.key),
    manager: ['reports'],
  };
  const access = parseAccess({ role_access: JSON.stringify(saved) } as unknown as Settings);

  assert.deepEqual(access.manager, ['reports'], 'what was saved, and nothing added back');
  assert.equal(canOpen('orders', { role: 'manager' } as StaffProfile,
    { role_access: JSON.stringify(saved) } as unknown as Settings), false);
});

test('a page added after the choices were made keeps its default', () => {
  // Otherwise every new page arrives switched off for everybody and an owner
  // has to go and find it.
  const saved = { _known: ['reports'], manager: ['reports'] };
  const access = parseAccess({ role_access: JSON.stringify(saved) } as unknown as Settings);

  assert.ok(access.manager.includes('reports'));
  assert.ok(access.manager.includes('orders'), 'never asked about, so the default stands');
});

test('the sensitive sections can be granted, and an admin keeps them regardless', () => {
  // They are off unless somebody says otherwise, not never. An owner who wants
  // a bookkeeper to keep the books should not be told no by a checkbox.
  const settings = {
    role_access: JSON.stringify({ _known: ADMIN_SECTIONS.map((s) => s.key), manager: ['settings'] }),
  } as unknown as Settings;

  assert.equal(canOpen('settings', { role: 'manager' } as StaffProfile, settings), true);
  assert.equal(canOpen('erase', { role: 'manager' } as StaffProfile, settings), false, 'and only what was given');
  assert.equal(canOpen('erase', { role: 'admin' } as StaffProfile, settings), true, 'the owner keeps everything');
});

test('the books are granted a part at a time', () => {
  /**
   * The tabs are not equally consequential. Reading a profit and loss is what
   * a manager is for; posting a journal entry to any account is not, and it is
   * how a shortage gets moved somewhere nobody looks.
   */
  const settings = {
    role_access: JSON.stringify({
      manager: ['accounting', 'accounting_statements', 'accounting_trial'],
    }),
  } as unknown as Settings;
  const manager = { role: 'manager' } as StaffProfile;

  assert.equal(canOpen('accounting', manager, settings), true, 'the way in');
  assert.deepEqual(
    areasOf('accounting', manager, settings),
    ['accounting_statements', 'accounting_trial'],
    'and only the parts given',
  );
  assert.equal(canOpen('accounting_journal', manager, settings), false);
  assert.equal(canOpen('accounting_chart', manager, settings), false);
});

test('a part of a page is never a page in the sidebar', () => {
  // Six accounting links would say this is six pages when it is one.
  const settings = {
    role_access: JSON.stringify({ manager: ['accounting', 'accounting_journal'] }),
  } as unknown as Settings;
  const nav = sectionsFor({ role: 'manager' } as StaffProfile, settings);

  assert.ok(nav.some((s) => s.key === 'accounting'));
  assert.ok(!nav.some((s) => s.key.startsWith('accounting_')), 'the tabs are reached through the page');
});

test('the page without any part of it grants nothing', () => {
  // The areas are the permission; the page is only where they live.
  const settings = { role_access: JSON.stringify({ manager: ['accounting'] }) } as unknown as Settings;
  const manager = { role: 'manager' } as StaffProfile;

  assert.equal(canOpen('accounting', manager, settings), true);
  assert.deepEqual(areasOf('accounting', manager, settings), []);
});

test('an admin has every part of the books without being granted any', () => {
  const admin = { role: 'admin' } as StaffProfile;
  const settings = { role_access: '{}' } as unknown as Settings;
  // Counted from the sections themselves rather than written down here, so
  // adding a seventh area does not fail a test about admins.
  const areas = ADMIN_SECTIONS.filter((x) => x.parent === 'accounting');
  assert.equal(areasOf('accounting', admin, settings).length, areas.length);
  assert.ok(areas.length >= 6, 'and there are several of them');
});

test('the saved marker only needs to cover what has a default', () => {
  /**
   * Everything else is never added back by anything, so listing it says
   * nothing and costs room — and this is all one string with a length limit
   * on it. A value too long to store is a save that silently does not happen,
   * which is the fault this whole mechanism exists to fix.
   */
  const known = [...new Set(Object.values(DEFAULT_ACCESS).flat())];
  const saved = { _known: known, manager: [] as string[] };
  const access = parseAccess({ role_access: JSON.stringify(saved) } as unknown as Settings);

  assert.deepEqual(access.manager, [], 'everything unticked stays unticked');
  assert.ok(JSON.stringify(saved).length < 2000, 'and it fits in the column it is stored in');
});

test('a bar is its own side, and turning it on does not turn the others off', () => {
  /**
   * The bar switch arrived after the other two, so a business that had already
   * answered "restaurant" has no bar setting to read — and guessing from
   * `business_type` would switch off a bar somebody had deliberately turned on.
   */
  assert.deepEqual(
    modulesOf({ business_type: 'restaurant', bar_enabled: true } as Settings),
    { kitchen: true, craft: false, bar: true },
  );
  // Untouched settings stay exactly as they were.
  assert.deepEqual(
    modulesOf({ business_type: 'restaurant' } as Settings),
    { kitchen: true, craft: false, bar: false },
  );
  // All three together is a business, not a mistake.
  assert.deepEqual(
    modulesOf({ kitchen_enabled: true, craft_enabled: true, bar_enabled: true } as Settings),
    { kitchen: true, craft: true, bar: true },
  );
  // A bar on its own still leaves somewhere to work, rather than an app with
  // no usable screens.
  assert.deepEqual(
    modulesOf({ kitchen_enabled: false, craft_enabled: false, bar_enabled: true } as Settings),
    { kitchen: false, craft: false, bar: true },
  );
  assert.deepEqual(
    modulesOf({ kitchen_enabled: false, craft_enabled: false, bar_enabled: false } as Settings),
    { kitchen: true, craft: false, bar: false },
    'switching everything off falls back rather than showing nothing',
  );
});

test('a bar shift is told apart from the other two at a glance', () => {
  // The code is what people read out to each other and write on an envelope of
  // cash, so it says which counter it came from before anything else does.
  assert.equal(shiftPrefix('bar'), 'BAR');
  assert.equal(shiftPrefix('kitchen'), 'BIST');
  assert.equal(shiftPrefix('craft'), 'CRAF');
});

/* ------------------------------------------- which sides somebody works on */

const threeTrades = settings({ kitchen_enabled: true, craft_enabled: true, bar_enabled: true });

test('a bartender gets the bar and not the bistro', () => {
  /**
   * The whole point. The old field could say one side or "both", and the form
   * that set it was only shown to businesses running the kitchen AND the craft
   * shop — so a place with a kitchen and a bar never saw the question, and
   * every bartender could open the bistro.
   */
  const mods = modulesForStaff(staff({ works_in_modules: ['bar'] }), threeTrades);
  assert.deepEqual(mods, { kitchen: false, craft: false, bar: true });
});

test('and a combination the old field could not say at all', () => {
  // Somebody covering the bar and the bistro. Under "both" they were handed
  // the craft shop as well, which is the opposite of what was being asked.
  const mods = modulesForStaff(staff({ works_in_modules: ['kitchen', 'bar'] }), threeTrades);
  assert.deepEqual(mods, { kitchen: true, craft: false, bar: true });
});

test('an empty list means everywhere, not nowhere', () => {
  /**
   * Every row written before this existed has no list on it. Reading empty as
   * "works nowhere" would have locked the entire staff out of every till the
   * moment this shipped.
   */
  assert.deepEqual(modulesForStaff(staff({ works_in_modules: [] }), threeTrades), {
    kitchen: true, craft: true, bar: true,
  });
  assert.deepEqual(modulesForStaff(staff(), threeTrades), { kitchen: true, craft: true, bar: true });
});

test('the old single answer is still honoured where no list was saved', () => {
  assert.deepEqual(modulesForStaff(staff({ works_in: 'craft' }), threeTrades), {
    kitchen: false, craft: true, bar: false,
  });
  assert.deepEqual(modulesForStaff(staff({ works_in: 'both' }), threeTrades), {
    kitchen: true, craft: true, bar: true,
  });
});

test('the list wins over the old answer when both are present', () => {
  // A row saved by the new form carries both: the list, and the nearest single
  // value for a database that has not been provisioned yet. They disagree by
  // design, and the list is the one that means anything.
  const mods = modulesForStaff(
    staff({ works_in: 'both', works_in_modules: ['bar'] }),
    threeTrades,
  );
  assert.deepEqual(mods, { kitchen: false, craft: false, bar: true });
});

test('a side the business has switched off cannot be worked on', () => {
  const noBar = settings({ kitchen_enabled: true, craft_enabled: true, bar_enabled: false });
  assert.deepEqual(modulesForStaff(staff({ works_in_modules: ['kitchen', 'bar'] }), noBar), {
    kitchen: true, craft: false, bar: false,
  });
});

test('somebody assigned only to a closed side is not left with nothing', () => {
  // A screen with no trades on it explains nothing and looks broken. What the
  // business runs is the honest fallback.
  const kitchenOnly = settings({ kitchen_enabled: true, craft_enabled: false, bar_enabled: false });
  assert.deepEqual(modulesForStaff(staff({ works_in_modules: ['bar'] }), kitchenOnly), {
    kitchen: true, craft: false, bar: false,
  });
});

test('the form reads a person’s sides from whichever field holds them', () => {
  assert.deepEqual(sidesOf(staff({ works_in_modules: ['bar', 'kitchen'] })), ['bar', 'kitchen']);
  assert.deepEqual(sidesOf(staff({ works_in: 'craft' })), ['craft']);
  // "Both" and "unanswered" are the same thing, and neither names a side.
  assert.deepEqual(sidesOf(staff({ works_in: 'both' })), []);
  assert.deepEqual(sidesOf(staff()), []);
});

test('the single-value column is written as the nearest thing that is true', () => {
  /**
   * Only ever read when the list column does not exist yet. One side maps
   * exactly; a combination cannot be said at all, and 'both' is the only value
   * that does not LOSE a side — the right way to be wrong, because the list is
   * what gets read the moment the column is provisioned.
   */
  assert.equal(legacySide(['bar']), 'bar');
  assert.equal(legacySide(['kitchen', 'bar']), 'both');
  assert.equal(legacySide([]), 'both');
});
