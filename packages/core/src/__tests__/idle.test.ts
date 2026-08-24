import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSleep, msUntilSleep, clockFace, wakeLabel,
  IDLE_MINUTES_DEFAULT, IDLE_MINUTES_MIN, wakesScreen, latestMovement,
  screenShouldReset, SCREEN_RESET_MS,
} from '../idle.ts';

const MIN = 60_000;
const at = 1_000_000;

test('a shop that has not asked for this does not get it', () => {
  assert.equal(IDLE_MINUTES_DEFAULT, 0);
  assert.equal(shouldSleep({ lastActiveAt: at, afterMinutes: 0 }, at + 99 * MIN), false);
});

test('it sleeps once the quiet has lasted long enough', () => {
  const state = { lastActiveAt: at, afterMinutes: 5 };
  assert.equal(shouldSleep(state, at + 4 * MIN), false);
  assert.equal(shouldSleep(state, at + 5 * MIN), true, 'exactly on the limit counts');
  assert.equal(shouldSleep(state, at + 50 * MIN), true);
});

test('nothing covers a payment that is part-way through', () => {
  // A customer counting out cash is not an absent cashier, and a clock landing
  // over a half-taken payment is how a till gets a reputation.
  assert.equal(shouldSleep({ lastActiveAt: at, afterMinutes: 5, busy: true }, at + 60 * MIN), false);
});

test('a timer can be set once instead of polling every second', () => {
  assert.equal(msUntilSleep({ lastActiveAt: at, afterMinutes: 5 }, at), 5 * MIN);
  assert.equal(msUntilSleep({ lastActiveAt: at, afterMinutes: 5 }, at + 3 * MIN), 2 * MIN);
  // Never negative: a due timer is due now, not overdue by twenty minutes.
  assert.equal(msUntilSleep({ lastActiveAt: at, afterMinutes: 5 }, at + 25 * MIN), 0);
  assert.equal(msUntilSleep({ lastActiveAt: at, afterMinutes: 0 }, at), Number.POSITIVE_INFINITY);
});

test('a setting below the minimum is treated as off, not as instant', () => {
  // Rounding a stray 0.5 down to "sleep immediately" would put the clock up
  // mid-sale, every sale.
  assert.equal(IDLE_MINUTES_MIN, 1);
  assert.equal(shouldSleep({ lastActiveAt: at, afterMinutes: 0.5 }, at + 60 * MIN), false);
  assert.equal(shouldSleep({ lastActiveAt: at, afterMinutes: -3 }, at + 60 * MIN), false);
});

test('the clock reads in the venue timezone, not the device one', () => {
  const noon = new Date('2026-08-17T12:00:00Z');
  assert.match(clockFace(noon, 'Africa/Accra').time, /^12:00:00 PM$/);
  assert.match(clockFace(noon, 'Africa/Lagos').time, /^01:00:00 PM$/, 'an hour ahead');
});

test('the face says the day and the date the way somebody reads them out', () => {
  const face = clockFace(new Date('2026-08-17T16:23:55Z'), 'Africa/Accra');
  assert.equal(face.time, '04:23:55 PM');
  assert.equal(face.day, 'Monday');
  assert.equal(face.date, '17 August 2026');
});

test('seconds are shown, so a stopped clock looks stopped', () => {
  assert.match(clockFace(new Date('2026-08-17T16:23:07Z'), 'Africa/Accra').time, /:07 PM$/);
});

test('the button offers what can actually be done', () => {
  assert.equal(wakeLabel(false), 'Open a shift');
  assert.equal(wakeLabel(true), 'Back to the till');
  assert.equal(wakeLabel(true, 'bar'), 'Back to the bar');
  assert.equal(wakeLabel(true, 'craft'), 'Back to the counter');
  assert.equal(wakeLabel(false, 'bar'), 'Open a shift', 'no shift beats which side it is');
});


test('a live order for this side lifts the clock', () => {
  /*
    The whole point of the screen: it is not idle because nobody touched it,
    it is idle because nothing is happening. A ticket landing is something
    happening, whoever caused it.
  */
  for (const status of ['SCHEDULED', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY']) {
    assert.equal(wakesScreen({ status, module: 'kitchen' }, { module: 'kitchen' }), true, status);
  }
});

test('an order being tidied away is not news', () => {
  // A clock that lifts for a closing order lifts all evening, which is the
  // same as not having one.
  for (const status of ['CLOSED', 'CANCELLED', 'REJECTED']) {
    assert.equal(wakesScreen({ status, module: 'kitchen' }, { module: 'kitchen' }), false, status);
  }
});

test('a screen does not wake for another side of the business', () => {
  /*
    A bar till cannot cook a plate of jollof, cannot serve it and cannot do
    anything about it. A screen that wakes for other people's work stops
    meaning anything by the third time.
  */
  assert.equal(wakesScreen({ status: 'PENDING', module: 'kitchen' }, { module: 'bar' }), false);
  assert.equal(wakesScreen({ status: 'PENDING', module: 'bar' }, { module: 'bar' }), true);
});

test('an order with no side on it belongs to the kitchen', () => {
  // Every order written before the shop existed carries none, and reading
  // those as "no side" would leave the kitchen screen asleep through them.
  assert.equal(wakesScreen({ status: 'PENDING' }, { module: 'kitchen' }), true);
  assert.equal(wakesScreen({ status: 'PENDING' }, {}), true);
  assert.equal(wakesScreen({ status: 'PENDING' }, { module: 'craft' }), false);
});

test('another venue is not this screen\'s business', () => {
  assert.equal(wakesScreen({ status: 'PENDING', venue_id: 'a' }, { venueId: 'b' }), false);
  assert.equal(wakesScreen({ status: 'PENDING', venue_id: 'a' }, { venueId: 'a' }), true);
  // Nothing asked, nothing refused: a caller that has already narrowed by
  // venue should not have to say so twice.
  assert.equal(wakesScreen({ status: 'PENDING', venue_id: 'a' }, {}), true);
});

test('the high-water mark is the latest thing that moved', () => {
  /*
    What the polling screens compare against. The list comes back in whatever
    order the database felt like, so the answer cannot depend on position.
  */
  assert.equal(latestMovement([
    { $updatedAt: '2026-08-24T10:00:00.000Z' },
    { $updatedAt: '2026-08-24T12:00:00.000Z' },
    { $updatedAt: '2026-08-24T11:00:00.000Z' },
  ]), '2026-08-24T12:00:00.000Z');
  assert.equal(latestMovement([]), '');
});

test('an order that has never been touched still counts as having moved', () => {
  // A new order has no $updatedAt in some shapes, and reading that as "never"
  // would leave the newest ticket unable to wake anything.
  assert.equal(latestMovement([{ $createdAt: '2026-08-24T09:00:00.000Z' }]), '2026-08-24T09:00:00.000Z');
  assert.equal(
    latestMovement([{ $createdAt: '2026-08-24T09:00:00.000Z', $updatedAt: '2026-08-24T09:30:00.000Z' }]),
    '2026-08-24T09:30:00.000Z',
  );
});

test('a counter screen clears itself between customers', () => {
  /*
    Everything on a shared screen belongs to the last person who stood at it.
    The next one should find an invitation, not a stranger's basket.
  */
  const now = 1_000_000;
  assert.equal(screenShouldReset({ lastTouchedAt: now - SCREEN_RESET_MS }, now), true);
  assert.equal(screenShouldReset({ lastTouchedAt: now - 1_000 }, now), false);
});

test('a screen never clears itself mid-send', () => {
  // The order has already been told to the kitchen. Throwing the basket away
  // underneath it would lose the thing that has just been promised.
  const now = 1_000_000;
  assert.equal(screenShouldReset({ lastTouchedAt: now - SCREEN_RESET_MS, sending: true }, now), false);
});

test('the wait is long enough to read a label by', () => {
  // Not a screensaver: this throws away work. A customer looking up from an
  // allergen list to find their order gone is the failure worth avoiding.
  assert.ok(SCREEN_RESET_MS >= 90_000);
});
