import test from 'node:test';
import assert from 'node:assert/strict';
import { trustRememberedShift, offlineBootWords, SHIFT_TRUST_MS } from '../offline-shift.ts';

const NOW = Date.UTC(2026, 7, 28, 14, 0, 0);

test('a shift seen open minutes ago is still sold into', () => {
  /**
   * The commonest offline case by far: the network drops mid-service and
   * somebody reloads the tab. Refusing to sell here would stop the shop over
   * a router that will be back in ninety seconds.
   */
  const kept = { seenAt: NOW - 5 * 60_000, wasOpen: true };
  assert.equal(trustRememberedShift(kept, NOW), true);
});

test('a shift seen open last night is not sold into this morning', () => {
  /**
   * The case that costs money. Sales rung into a shift that was closed and
   * counted hours ago land outside those totals, and nobody finds out until
   * the day is reconciled.
   */
  const kept = { seenAt: NOW - 20 * 3600_000, wasOpen: true };
  assert.equal(trustRememberedShift(kept, NOW), false);
});

test('the window cannot reach across a night', () => {
  // Whatever the number is tuned to, it must be shorter than the gap between
  // one day's close and the next day's open, or the rule above is decoration.
  assert.ok(SHIFT_TRUST_MS < 16 * 3600_000, 'trust window could span a closing');
  assert.equal(trustRememberedShift({ seenAt: NOW - SHIFT_TRUST_MS - 1, wasOpen: true }, NOW), false);
  assert.equal(trustRememberedShift({ seenAt: NOW - SHIFT_TRUST_MS, wasOpen: true }, NOW), true);
});

test('remembering that there was no shift is not something to restore', () => {
  // "No shift" is the ordinary state of a till waiting to be opened. The till
  // reaches it by having nothing, so there is nothing here to fall back on.
  assert.equal(trustRememberedShift({ seenAt: NOW, wasOpen: false }, NOW), false);
  assert.equal(trustRememberedShift(null, NOW), false);
});

test('a stamp from the future is not treated as fresh', () => {
  /*
    A tablet whose clock was wrong and then corrected. The stamp says nothing
    reliable about how long ago this was, so it is not trusted — the safe
    reading of an unreadable clock is the cautious one.
  */
  assert.equal(trustRememberedShift({ seenAt: NOW + 3600_000, wasOpen: true }, NOW), false);
});

test('the notice says what is happening and what will happen next', () => {
  const withShift = offlineBootWords(true);
  assert.match(withShift, /No connection/);
  // The promise that stops somebody re-entering everything by hand later.
  assert.match(withShift, /will be sent/);
  // And the caveat that stops them trusting a total that is only this device's.
  assert.match(withShift, /only count what has been rung up here/);

  const without = offlineBootWords(false);
  assert.match(without, /no shift open/);
  assert.doesNotMatch(without, /only count what has been rung up here/);
});
