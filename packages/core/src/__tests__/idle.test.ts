import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSleep, msUntilSleep, clockFace, wakeLabel,
  IDLE_MINUTES_DEFAULT, IDLE_MINUTES_MIN,
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
