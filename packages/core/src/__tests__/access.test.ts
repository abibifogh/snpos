import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modulesOf, modulesForStaff, parseAccess, canOpen, inTrade, sectionsFor,
  canEditCatalogue, selfOrderModule, ADMIN_SECTIONS, DEFAULT_ACCESS, areasOf,
} from '../access.ts';
import type { Settings, StaffProfile } from '../types.ts';

const settings = (over: Partial<Settings> = {}) => ({ ...over }) as Settings;
const staff = (over: Partial<StaffProfile> = {}) =>
  ({ $id: 's1', display_name: 'Person', role: 'manager', active: true, ...over }) as StaffProfile;

test('a business with no switches set is read from what it used to say', () => {
  assert.deepEqual(modulesOf(settings()), { kitchen: true, craft: false });
  assert.deepEqual(modulesOf(settings({ business_type: 'craft_shop' })), { kitchen: false, craft: true });
});

test('the switches win once they exist, and both may be on', () => {
  assert.deepEqual(modulesOf(settings({ kitchen_enabled: true, craft_enabled: true })), { kitchen: true, craft: true });
  assert.deepEqual(modulesOf(settings({ kitchen_enabled: false, craft_enabled: true })), { kitchen: false, craft: true });
});

test('a business can never run neither side', () => {
  const none = modulesOf(settings({ kitchen_enabled: false, craft_enabled: false }));
  assert.ok(none.kitchen || none.craft, 'falling back to the kitchen beats a system with no screens');
});

test('a person narrows what the business runs but cannot invent a side', () => {
  const both = settings({ kitchen_enabled: true, craft_enabled: true });
  assert.deepEqual(modulesForStaff(staff({ works_in: 'craft' }), both), { kitchen: false, craft: true });
  assert.deepEqual(modulesForStaff(staff({ works_in: 'both' }), both), { kitchen: true, craft: true });
  assert.deepEqual(modulesForStaff(staff({}), both), { kitchen: true, craft: true }, 'absent means both');

  const kitchenOnly = settings({ kitchen_enabled: true, craft_enabled: false });
  assert.deepEqual(
    modulesForStaff(staff({ works_in: 'craft' }), kitchenOnly),
    { kitchen: true, craft: false },
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
  assert.equal(areasOf('accounting', admin, settings).length, 6);
});
