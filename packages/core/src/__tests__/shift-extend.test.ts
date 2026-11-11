import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftLimit, extendProblem, shiftAgeOf, mustWaitForNextShift, sellBlockedReason, EXTEND_MAX_HOURS, SHIFT_MAX_HOURS,
} from '../shift-rules.ts';

const HOURS = 3_600_000;
const NOW = new Date('2026-11-10T20:00:00.000Z');
const openedAgo = (h: number) => new Date(NOW.getTime() - h * HOURS).toISOString();

test('a shift stops at a day, plus whatever more time it was given', () => {
  assert.equal(shiftLimit({}), SHIFT_MAX_HOURS);
  assert.equal(shiftLimit({ extended_hours: 6 }), 30);
  assert.equal(shiftLimit({ extended_hours: 999 }), SHIFT_MAX_HOURS + EXTEND_MAX_HOURS, 'never more than two days');
  assert.equal(shiftLimit({ extended_hours: -5 }), SHIFT_MAX_HOURS);
});

test('given more time, a shift past a day still sells, and warns four hours before its new limit', () => {
  const plain = { opened_at: openedAgo(25) };
  const given = { opened_at: openedAgo(25), extended_hours: 6 };
  assert.equal(shiftAgeOf(plain, NOW).over, true);
  assert.equal(shiftAgeOf(given, NOW).over, false);
  assert.equal(shiftAgeOf(given, NOW).warning, false, '25 h of 30: not yet');
  assert.equal(shiftAgeOf({ ...given, opened_at: openedAgo(27) }, NOW).warning, true);
  assert.match(sellBlockedReason(plain, 'bar', NOW) ?? '', /Nothing new can be sold on it/);
  assert.equal(sellBlockedReason(given, 'bar', NOW), null);
  assert.equal(shiftAgeOf({ opened_at: openedAgo(21) }, NOW).warning, true, 'an ordinary shift still warns at 20 h');
});

test('an order on a shift that was given more time is not shelved for the next one', () => {
  const shift = { $id: 's1', opened_at: openedAgo(25), $createdAt: openedAgo(25), extended_hours: 6 };
  const order = { $createdAt: new Date(NOW.getTime() - 0.5 * HOURS).toISOString() };
  assert.equal(mustWaitForNextShift(order, shift), false);
});

test('only an admin or manager, on an open shift, with a reason, within two days', () => {
  const shift = { status: 'open', extended_hours: 0 };
  assert.match(extendProblem({ shift, hours: 6, reason: 'Event running late', role: 'cashier' }) ?? '', /admin or a manager/);
  assert.equal(extendProblem({ shift, hours: 6, reason: 'Event running late', role: 'manager' }), null);
  assert.match(extendProblem({ shift, hours: 6, reason: '', role: 'admin' }) ?? '', /Say why/);
  assert.match(extendProblem({ shift, hours: 5, reason: 'Event', role: 'admin' }) ?? '', /how much more time/);
  assert.match(extendProblem({ shift: { status: 'closed' }, hours: 6, reason: 'Event', role: 'admin' }) ?? '', /open shift/);
  assert.match(extendProblem({ shift: { status: 'open', extended_hours: 18 }, hours: 12, reason: 'Event', role: 'admin' }) ?? '', /6 more is the most left/);
  assert.match(extendProblem({ shift: { status: 'open', extended_hours: 24 }, hours: 2, reason: 'Event', role: 'admin' }) ?? '', /Close it and open a new one/);
});
