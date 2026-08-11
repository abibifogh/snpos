import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modulesOf, modulesForStaff, parseAccess, canOpen, inTrade, sectionsFor,
  canEditCatalogue, ADMIN_SECTIONS, DEFAULT_ACCESS,
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
