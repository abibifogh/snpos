import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newestStamp, catalogueMoved, worthLooking, CATALOGUE_COLLECTIONS, SETTLE_MS, LOOK_EVERY_MS,
} from '../till-refresh.ts';

test('the newest stamp is the newest one there is', () => {
  assert.equal(
    newestStamp([
      { $updatedAt: '2026-08-01T00:00:00.000Z' },
      { $updatedAt: '2026-08-25T09:00:00.000Z' },
      { $updatedAt: '2026-08-10T00:00:00.000Z' },
    ]),
    '2026-08-25T09:00:00.000Z',
  );

  // A row with no stamp contributes nothing rather than an empty string that
  // would sort below everything and hide a real change.
  assert.equal(newestStamp([{}, { $updatedAt: '2026-08-01T00:00:00.000Z' }]), '2026-08-01T00:00:00.000Z');
  assert.equal(newestStamp([]), '');
});

test('a till never reloads on its first look', () => {
  /**
   * Everything is new to a screen that has just loaded its menu. A till that
   * treated the first stamp it ever saw as a change would fetch the whole
   * catalogue a second time at boot — on every till, every sign-in, for
   * nothing.
   */
  assert.equal(catalogueMoved('', '2026-08-25T09:00:00.000Z'), false);
});

test('nothing readable is no news, not a change', () => {
  /*
    A till that reloaded its menu every time the network hiccupped would be
    worse than one that waited for the next look: it would do its most
    expensive read precisely when reads are failing.
  */
  assert.equal(catalogueMoved('2026-08-25T09:00:00.000Z', ''), false);
});

test('a stamp going backwards is still a change', () => {
  /**
   * Deleting the newest product takes the newest stamp with it. The shop floor
   * should stop offering something that no longer exists just as promptly as
   * it starts offering something new, so this asks whether the stamp DIFFERS
   * rather than whether it is later.
   */
  assert.equal(catalogueMoved('2026-08-25T09:00:00.000Z', '2026-08-01T00:00:00.000Z'), true);
  assert.equal(catalogueMoved('2026-08-01T00:00:00.000Z', '2026-08-25T09:00:00.000Z'), true);
  assert.equal(catalogueMoved('2026-08-25T09:00:00.000Z', '2026-08-25T09:00:00.000Z'), false);
});

test('a till nobody is looking at does not go and read the catalogue', () => {
  assert.equal(worthLooking(false, true), true);
  assert.equal(worthLooking(true, true), false, 'a background tab');
  assert.equal(worthLooking(false, false), false, 'no network to ask over');
});

test('the watched collections are the ones a till screen is drawn from', () => {
  /*
    Watching only the products would leave a basket moved to a new shelf, or a
    size repriced, invisible until somebody reloaded the page by hand — which
    is the whole failure this exists to fix.
  */
  assert.deepEqual(
    [...CATALOGUE_COLLECTIONS],
    ['menu_items', 'product_variants', 'categories', 'menu_item_categories'],
  );
});

test('the timer is a safety net, not the way changes normally arrive', () => {
  /**
   * The live connection is the fast path; this look exists for the case where
   * it has quietly died. It costs a read every time it fires, so it is minutes
   * rather than seconds — and the settle is seconds rather than minutes,
   * because a price correction should reach the counter while the person who
   * made it is still looking at the screen.
   */
  assert.ok(SETTLE_MS < 10_000, 'a real change reaches the counter promptly');
  assert.ok(LOOK_EVERY_MS >= 60_000, 'and the net under it does not cost a read a second');
});
