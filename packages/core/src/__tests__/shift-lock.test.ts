import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSealed, sealProblem, lockedProblem, orderIsSettled, lockWords, describeSeal,
  type LockableShift,
} from '../shift-lock.ts';

const shift = (over: Partial<LockableShift> = {}): LockableShift =>
  ({ code: 'BIST-07', status: 'closed', ...over });

test('closed is not settled, and that difference is the whole point', () => {
  /**
   * Closing a shift ends it. It does not finish it: the close time can still
   * be corrected, an order moved onto or off it, a payment voided. All of
   * those are deliberate and needed. Settling is the separate statement that
   * this night has been reported on.
   */
  assert.equal(isSealed(shift()), false);
  assert.equal(isSealed(shift({ locked_at: '2026-08-20T09:00:00.000Z' })), true);
  assert.equal(isSealed(null), false);
  assert.equal(isSealed(undefined), false);
});

test('a shift still trading cannot be settled', () => {
  // Not a house rule: sealing an open shift would stop the till taking money
  // against a night that has not stopped happening, and the first person to
  // find out would be a cashier at eleven with a customer waiting.
  assert.match(sealProblem(shift({ status: 'open' })) ?? '', /still open/);
  assert.match(sealProblem(shift({ status: 'open' })) ?? '', /Close it from the till first/);
  assert.equal(sealProblem(shift()), null);
});

test('settling twice is refused rather than silently repeated', () => {
  const sealed = shift({ locked_at: '2026-08-20T09:00:00.000Z' });
  assert.match(sealProblem(sealed) ?? '', /already settled/);
});

test('the refusal names the shift and offers the way out', () => {
  /**
   * One sentence, written once, so every screen refuses in the same words.
   * Six screens each phrasing it themselves is six chances to imply the
   * change went through when it did not.
   */
  const msg = lockedProblem(shift({ locked_at: '2026-08-20T09:00:00.000Z' }), 'the close time');
  assert.match(msg ?? '', /BIST-07 was settled/);
  assert.match(msg ?? '', /the close time cannot be changed/);
  assert.match(msg ?? '', /An admin can reopen it/);
});

test('an unsettled shift refuses nothing', () => {
  assert.equal(lockedProblem(shift(), 'the close time'), null);
  assert.equal(lockedProblem(null), null);
  assert.equal(orderIsSettled(shift()), false);
  assert.equal(orderIsSettled(shift({ locked_at: '2026-08-20T09:00:00.000Z' })), true);
});

test('the badge says settled, and carries the reason where there is one', () => {
  assert.equal(lockWords(shift()).label, 'Open to corrections');
  const words = lockWords(shift({ locked_at: '2026-08-20T09:00:00.000Z', lock_reason: 'Given to the accountant' }));
  assert.equal(words.label, 'Settled');
  assert.equal(words.detail, 'Given to the accountant');
  // No reason is not an empty reason: an empty string on screen reads as a
  // missing value rather than as nothing to say.
  assert.equal(lockWords(shift({ locked_at: 'x', lock_reason: '' })).detail, undefined);
});

test('both directions read the same way in the log a year later', () => {
  assert.match(describeSeal(shift(), true), /BIST-07 is settled/);
  assert.match(describeSeal(shift(), true), /Nothing in it can be changed until it is reopened/);
  assert.match(describeSeal(shift(), false), /open to corrections again/);
});
