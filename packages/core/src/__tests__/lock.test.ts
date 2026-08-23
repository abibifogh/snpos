import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lockKey, unlockers, lockProblem, pushDigit, dropDigit, worthChecking,
  waitAfter, lockMessage, PIN_MAX, PIN_MIN,
  type Unlocker,
} from '../lock.ts';

const who = (over: Partial<Unlocker> = {}): Unlocker => ({
  $id: 'u1', display_name: 'Ama', pin_hash: 'x', ...over,
});

test('a till nobody can open is not locked, it is broken', () => {
  /**
   * Refused rather than warned about. A warning is dismissed by the person who
   * then cannot get back in, and the cost lands on whoever is holding the
   * queue with a shift open and a drawer under it.
   */
  assert.match(lockProblem([]) ?? '', /Nobody has a PIN set/);
  assert.match(lockProblem([who({ pin_hash: '' })]) ?? '', /could not be opened again/);
  assert.equal(lockProblem([who()]), null);
});

test('somebody who has left cannot be the reason a till may be locked', () => {
  // Their PIN is still on the record and it must not count towards "there is
  // a way back in", or the till locks against everybody actually present.
  assert.match(lockProblem([who({ active: false })]) ?? '', /Nobody has a PIN set/);
  assert.deepEqual(unlockers([who({ active: false }), who({ $id: 'u2' })]).map((u) => u.$id), ['u2']);
});

test('anybody with a PIN can open it, not only whoever locked it', () => {
  /**
   * A till is a place rather than a person's laptop. The whole reason it gets
   * locked is that somebody is walking away, and the person who comes back is
   * often the next one on — a lock only its owner could open would be worked
   * around within a day by not locking it.
   */
  const staff = [who({ $id: 'a' }), who({ $id: 'b' }), who({ $id: 'c', pin_hash: undefined })];
  assert.deepEqual(unlockers(staff).map((u) => u.$id), ['a', 'b']);
});

test('the pad takes digits and nothing else', () => {
  assert.equal(pushDigit('', '4'), '4');
  assert.equal(pushDigit('12', '3'), '123');
  // A stray letter or symbol is a mis-tap, not an entry.
  assert.equal(pushDigit('12', 'a'), '12');
  assert.equal(pushDigit('12', '#'), '12');
  assert.equal(pushDigit('12', ''), '12');
  assert.equal(dropDigit('123'), '12');
  assert.equal(dropDigit(''), '', 'backspacing an empty pad is not an error');
});

test('the pad stops at the longest PIN the staff form allows', () => {
  // Otherwise somebody leaning on a key fills memory with digits that can
  // never match anything.
  assert.equal(PIN_MAX, 6);
  const full = '123456';
  assert.equal(pushDigit(full, '7'), full);
});

test('a half-typed PIN is not a wrong PIN', () => {
  /**
   * Four is the shortest the staff form accepts, so anything below cannot
   * match — checking it would only be a slower way of saying no, and it would
   * flash "not recognised" at somebody still typing.
   */
  assert.equal(PIN_MIN, 4);
  assert.equal(worthChecking('12'), false);
  assert.equal(worthChecking('1234'), true);
  assert.equal(worthChecking('123456'), true);
});

test('the first few wrong tries cost nothing; guessing gets slower', () => {
  /**
   * An honest mistyped PIN must not be punished. A four-digit PIN is ten
   * thousand combinations, which a person cannot work through but a bored
   * teenager with a tablet can make a dent in.
   */
  assert.equal(waitAfter(0), 0);
  assert.equal(waitAfter(2), 0, 'three free attempts');
  assert.equal(waitAfter(3), 2_000);
  assert.equal(waitAfter(4), 4_000);
  assert.equal(waitAfter(5), 8_000);
});

test('the wait is capped, because a till that cannot take money is worse', () => {
  // Not a lockout. Refusing everybody for ten minutes defends against less
  // than it costs.
  assert.equal(waitAfter(20), 30_000);
  assert.equal(waitAfter(99), 30_000);
});

test('the pad says what is happening, and says nothing when nothing is', () => {
  assert.equal(lockMessage({ wrongTries: 0, waitingMs: 0 }), null);
  assert.match(lockMessage({ wrongTries: 1, waitingMs: 0 }) ?? '', /was not recognised/);
  assert.match(lockMessage({ wrongTries: 4, waitingMs: 4_000 }) ?? '', /Wait 4 seconds/);
  assert.match(lockMessage({ wrongTries: 4, waitingMs: 900 }) ?? '', /Wait 1 second and/);
});

test('the bar and the shop lock separately', () => {
  // Two tills in one building are two doors. Locking the bar must not shut
  // the shop counter.
  assert.notEqual(lockKey('main', 'bar'), lockKey('main', 'craft'));
});
