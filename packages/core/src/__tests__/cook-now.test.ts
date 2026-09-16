import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookNowProblem, canCookNow, isGroupSitting } from '../access.ts';
import type { StaffProfile } from '../types.ts';

/*
  "Cook now" sits on the booked-for-later strip so a kitchen can start
  something early when it suits them. On an ordinary pre-order that is a cook's
  own call about their own night.

  A GROUP SITTING IS NOT THAT. It is forty covers, and releasing it early puts
  the whole party's food on the pass hours before the party is in the building.
  It cannot be taken back — SCHEDULED is a one-way door, and the only way out
  is to reject the order, which loses the booking — and the strip it lives on
  is a row of small buttons the whole shift walks past.
*/

const who = (over: Partial<StaffProfile>): StaffProfile => ({ role: 'cook', ...over } as StaffProfile);

const walkIn = { $id: 'o1', is_group: false };
const booking = { $id: 'o2', group_booking_id: 'b1' };

test('an ordinary pre-order stays the cook\'s own call', () => {
  // The whole point of not writing this as "seniors may use Cook now".
  assert.equal(cookNowProblem(walkIn, who({ role: 'cook' })), null);
  assert.equal(cookNowProblem(walkIn, who({ role: 'waiter' })), null);
  assert.equal(canCookNow(walkIn, who({ role: 'cook' })), true);
});

test('a group sitting needs an owner or a manager', () => {
  assert.equal(cookNowProblem(booking, who({ role: 'admin' })), null);
  assert.equal(cookNowProblem(booking, who({ role: 'manager' })), null);
  assert.equal(canCookNow(booking, who({ role: 'admin' })), true);
  assert.equal(canCookNow(booking, who({ role: 'manager' })), true);
});

test('everybody else is refused, and told who to ask', () => {
  for (const role of ['cook', 'waiter', 'cashier']) {
    const why = cookNowProblem(booking, who({ role: role as StaffProfile['role'] }));
    assert.match(String(why), /owner or a manager/i, `${role} should be refused`);
    // The refusal names the way forward rather than only the rule.
    assert.match(String(why), /ask/i);
    assert.equal(canCookNow(booking, who({ role: role as StaffProfile['role'] })), false);
  }
});

test('a screen nobody has signed in to cannot start a booking', () => {
  /*
    The pass is a shared screen left on all night. "Nobody" must not be a way
    past a rule that exists to put a name behind the decision.
  */
  const why = cookNowProblem(booking, null);
  assert.match(String(why), /Sign in/i);
  assert.equal(canCookNow(booking, null), false);
});

test('a group order is known by either mark it carries', () => {
  /*
    Sittings of a multi-day booking carry group_booking_id; a single group
    order marked as one at the till carries is_group. Reading only one of them
    would leave a whole shape of group order open to anybody.
  */
  assert.equal(isGroupSitting({ group_booking_id: 'b1' }), true);
  assert.equal(isGroupSitting({ is_group: true }), true);
  assert.equal(isGroupSitting({}), false);
  assert.equal(cookNowProblem({ is_group: true }, who({ role: 'cook' })) !== null, true);
});

test('an empty booking id is not a group booking', () => {
  // Appwrite hands back '' for an unset string, and a walk-in must not become
  // manager-only because of it.
  assert.equal(isGroupSitting({ group_booking_id: '' }), false);
  assert.equal(cookNowProblem({ group_booking_id: '' }, who({ role: 'cook' })), null);
});
