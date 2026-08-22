import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftCode, shiftPrefix, shiftAge, shiftAgeMessage, overdueFrom, isPastLimit, mustWaitForNextShift, shouldWarnLateOrder,
  SHIFT_MAX_HOURS, SHIFT_WARN_HOURS,
  shiftAgeOf, openShiftsFor, blockerFor, isLivePayment, sellBlockedReason, carryOverFloats, lastForSide, floatProblem, describeFloatChange, resendProblem, resendPending,
} from '../shift-rules.ts';

const at = (iso: string) => new Date(iso);
const HOURS = 3_600_000;

test('a shift code says which counter it came from', () => {
  assert.equal(shiftPrefix('kitchen'), 'BIST');
  assert.equal(shiftPrefix('craft'), 'CRAF');
  assert.equal(shiftPrefix(undefined), 'BIST', 'shifts from before the split are the bistro');

  const now = at('2026-08-12T09:30:00.000Z');
  assert.match(shiftCode('kitchen', now), /^BIST20260812-[0-9a-z]{4}$/);
  assert.match(shiftCode('craft', now), /^CRAF20260812-[0-9a-z]{4}$/);
});

test('two shifts opened in the same second still get different codes', () => {
  // The tail is the clock in base 36. Two opens a second apart must not
  // collide, or a night's takings end up filed under one code.
  const a = shiftCode('craft', at('2026-08-12T09:30:00.000Z'));
  const b = shiftCode('craft', at('2026-08-12T09:30:01.000Z'));
  assert.notEqual(a, b);
});

test('a shift is fine, then warned about, then stopped', () => {
  const opened = '2026-08-12T06:00:00.000Z';
  const after = (hours: number) => shiftAge(opened, new Date(Date.parse(opened) + hours * HOURS));

  const fresh = after(2);
  assert.equal(fresh.over, false);
  assert.equal(fresh.warning, false);
  assert.equal(fresh.hours, 2);
  assert.equal(fresh.hoursLeft, SHIFT_MAX_HOURS - 2);

  const late = after(SHIFT_WARN_HOURS + 1);
  assert.equal(late.over, false, 'still selling');
  assert.equal(late.warning, true, 'but told about it');

  const stopped = after(SHIFT_MAX_HOURS);
  assert.equal(stopped.over, true, 'exactly a day is already too long');
  assert.equal(stopped.warning, false, 'past the limit is not a warning any more');
  assert.equal(stopped.hoursLeft, 0);

  assert.equal(after(40).over, true);
});

test('a clock that is wrong never stops a till', () => {
  const opened = '2026-08-12T06:00:00.000Z';
  // Opened "in the future", which happens when a device's clock is off.
  const skewed = shiftAge(opened, new Date(Date.parse(opened) - 5 * HOURS));
  assert.equal(skewed.over, false);
  assert.equal(skewed.hours, 0);

  const nonsense = shiftAge('not a date');
  assert.equal(nonsense.over, false, 'an unreadable date must not block sales');
});

test('the message tells somebody what to do, not just what is wrong', () => {
  const opened = '2026-08-12T06:00:00.000Z';
  const over = shiftAge(opened, new Date(Date.parse(opened) + 30 * HOURS));

  // Both sides say how long, and both say to close it. What differs is what
  // has actually stopped, and that is the part staff act on.
  for (const side of ['kitchen', 'craft', 'bar'] as const) {
    const text = shiftAgeMessage(over, SHIFT_MAX_HOURS, side);
    assert.match(text, /close/i, side);
    assert.match(text, /30 hours/, side);
  }

  // The kitchen keeps cooking; only the money waits.
  const kitchen = shiftAgeMessage(over, SHIFT_MAX_HOURS, 'kitchen');
  assert.match(kitchen, /cooked/i);
  assert.match(kitchen, /paid/i);

  // The counter has nothing to keep doing, so it stops at the beginning.
  assert.match(shiftAgeMessage(over, SHIFT_MAX_HOURS, 'craft'), /nothing new can be sold/i);

  // A bar is the counter's shape, not the kitchen's. Nothing is cooked at a
  // bar, so telling one its orders can still be cooked described a room that
  // does not exist.
  assert.match(shiftAgeMessage(over, SHIFT_MAX_HOURS, 'bar'), /nothing new can be sold/i);
  assert.doesNotMatch(shiftAgeMessage(over, SHIFT_MAX_HOURS, 'bar'), /cooked/i);

  const warn = shiftAge(opened, new Date(Date.parse(opened) + 21 * HOURS));
  assert.match(shiftAgeMessage(warn), /24 hours/);
  assert.match(shiftAgeMessage(warn, SHIFT_MAX_HOURS, 'craft'), /24 hours/);
  assert.match(shiftAgeMessage(warn, SHIFT_MAX_HOURS, 'bar'), /24 hours/);

  assert.equal(shiftAgeMessage(shiftAge(opened, new Date(Date.parse(opened) + HOURS))), '', 'nothing to say yet');
});

test('an order is past the limit only if it came in after the shift should have closed', () => {
  const shift = { opened_at: '2026-08-10T06:00:00.000Z' };
  const at = (hours: number) => ({ $createdAt: new Date(Date.parse(shift.opened_at) + hours * HOURS).toISOString() });

  assert.equal(isPastLimit(at(1), shift), false, 'the first hour of an ordinary shift');
  assert.equal(isPastLimit(at(23.9), shift), false, 'still inside the day');
  assert.equal(isPastLimit(at(SHIFT_MAX_HOURS), shift), true, 'exactly at the limit is already past it');
  assert.equal(isPastLimit(at(53), shift), true);

  // An order from before the shift even opened is not a late order. Pre-orders
  // land there and must keep holding the shift open the ordinary way.
  assert.equal(isPastLimit({ $createdAt: '2026-08-09T20:00:00.000Z' }, shift), false);
});

test('nothing is past the limit when there is nothing to measure against', () => {
  // No shift, no creation date, or an unreadable one. Each has to answer "no",
  // because "yes" would let a shift close over an ordinary unpaid order.
  assert.equal(isPastLimit({ $createdAt: '2026-08-12T06:00:00.000Z' }, null), false);
  assert.equal(isPastLimit({}, { opened_at: '2026-08-10T06:00:00.000Z' }), false);
  assert.equal(isPastLimit({ $createdAt: '2026-08-12T06:00:00.000Z' }, { opened_at: 'nonsense' }), false);
  assert.equal(overdueFrom('nonsense'), '');
});

test('the moment a shift goes past its limit is a day after it opened', () => {
  assert.equal(overdueFrom('2026-08-10T06:00:00.000Z'), '2026-08-11T06:00:00.000Z');
  assert.equal(overdueFrom('2026-08-10T06:00:00.000Z', 12), '2026-08-10T18:00:00.000Z');
});

test('an order that has moved to a new shift is that shift\'s order, and payable', () => {
  const sunday = { $id: 'shift-sun', opened_at: '2026-08-09T06:00:00.000Z' };
  const monday = { $id: 'shift-mon', opened_at: '2026-08-11T12:00:00.000Z' };
  // Taken on Sunday's shift, two days after it should have closed.
  const order = { $createdAt: '2026-08-11T09:00:00.000Z' };

  assert.equal(mustWaitForNextShift(order, sunday), true, 'not payable on the shift that overran');

  // Once shelved and picked up, it is Monday's, and no sum done on Monday may
  // say otherwise. This is the bug: the arithmetic was re-run against whatever
  // shift was loaded, so a stale or duplicate open shift made it unpayable for
  // ever.
  const moved = { ...order, shift_id: monday.$id, shelved_from_shift: sunday.$id };
  assert.equal(mustWaitForNextShift(moved, monday), false);
  assert.equal(
    mustWaitForNextShift(moved, sunday), false,
    'even measured against the old shift again, it has been dealt with',
  );

  // The stamp alone is enough, in case clearing the flag never landed.
  assert.equal(mustWaitForNextShift({ ...order, shift_id: monday.$id }, monday), false);
});

test('being stamped with a DIFFERENT shift is not a free pass', () => {
  const sunday = { $id: 'shift-sun', opened_at: '2026-08-09T06:00:00.000Z' };
  const order = { $createdAt: '2026-08-11T09:00:00.000Z', shift_id: 'some-other-shift' };
  assert.equal(mustWaitForNextShift(order, sunday), true);
});

test('an ordinary unpaid order is never waved through', () => {
  const shift = { $id: 'shift-a', opened_at: '2026-08-11T06:00:00.000Z' };
  // Two hours in. Nothing about it is late, so the ordinary rules apply and it
  // still has to be settled before the shift can close.
  assert.equal(mustWaitForNextShift({ $createdAt: '2026-08-11T08:00:00.000Z' }, shift), false);
  assert.equal(isPastLimit({ $createdAt: '2026-08-11T08:00:00.000Z' }, shift), false);
});

test('a shift that is not itself overdue never calls anything late', () => {
  // The single check that would have caught the whole failure. A shift opened
  // minutes ago has no business judging an order late for a limit it is
  // nowhere near, whatever the other fields say.
  const fresh = { $id: 'fresh', opened_at: new Date().toISOString(), $createdAt: new Date().toISOString() };
  const old = { $createdAt: '2020-01-01T00:00:00.000Z' };
  assert.equal(mustWaitForNextShift(old, fresh), false);
});

test('a tablet with the wrong clock cannot decide whether somebody may pay', () => {
  /**
   * `$createdAt` is written by the server. `opened_at` is written by whatever
   * the tablet thinks the time is. Comparing one against the other meant a
   * device running a day behind made every order look late on any shift opened
   * from it, and the customer could not pay on any shift at all.
   */
  const skewed = {
    $id: 'shift-now',
    // The server knows this shift was made a minute ago.
    $createdAt: '2026-08-12T12:00:00.000Z',
    // The tablet thinks it is three days earlier.
    opened_at: '2026-08-09T12:00:00.000Z',
  };
  const order = { $createdAt: '2026-08-12T12:30:00.000Z' };

  assert.equal(
    isPastLimit(order, skewed), false,
    'server against server: half an hour old is not past a day',
  );

  // And with only the tablet's figure to go on, the old comparison is what
  // produced the false answer. Kept as the fallback, so this documents what
  // the $createdAt anchor is protecting against.
  assert.equal(isPastLimit(order, { opened_at: skewed.opened_at }), true);
});

test('paying late is a warning, and warnings are the same question', () => {
  // One rule, two names, so the till and the close can never disagree about
  // which orders are late. What differs is only what each does about it.
  const overdue = { $id: 'a', $createdAt: '2026-08-09T06:00:00.000Z', opened_at: '2026-08-09T06:00:00.000Z' };
  const late = { $createdAt: '2026-08-11T09:00:00.000Z' };
  assert.equal(shouldWarnLateOrder(late, overdue), mustWaitForNextShift(late, overdue));
  assert.equal(shouldWarnLateOrder(late, overdue), true);
});

test('a closed shift is never overdue, however long it was open', () => {
  /**
   * The banner that would not go away. This measured from `closed_at`, treating
   * the moment a shift ENDED as the moment it started, so a shift closed two
   * days ago reported two days and asked to be closed again.
   */
  const closed = {
    opened_at: '2026-08-09T06:00:00.000Z',
    closed_at: '2026-08-11T09:00:00.000Z',
  };
  const age = shiftAgeOf(closed);
  assert.equal(age.over, false);
  assert.equal(age.warning, false);

  // Nothing at all is not overdue either, which is what a till holds the
  // moment after a shift is closed.
  assert.equal(shiftAgeOf(null).over, false);
  assert.equal(shiftAgeOf(undefined).over, false);

  // An OPEN shift still reports honestly.
  const open = { opened_at: new Date(Date.now() - 30 * HOURS).toISOString() };
  assert.equal(shiftAgeOf(open).over, true);
});

test('every shift open on a side comes back, newest first', () => {
  /**
   * The one that made every close look broken. Only the newest was ever
   * returned, so a second open shift was invisible: you closed the one on
   * screen, the email arrived, and the next one appeared in its place looking
   * exactly like the close had failed.
   */
  const shifts = [
    { $id: 'a', opened_at: '2026-08-11T06:00:00.000Z', module: 'kitchen' as const },
    { $id: 'c', opened_at: '2026-08-13T06:00:00.000Z', module: 'kitchen' as const },
    { $id: 'b', opened_at: '2026-08-12T06:00:00.000Z', module: 'kitchen' as const },
    { $id: 'craft', opened_at: '2026-08-13T07:00:00.000Z', module: 'craft' as const },
  ];

  assert.deepEqual(openShiftsFor(shifts, 'kitchen').map((s) => s.$id), ['c', 'b', 'a']);
  assert.deepEqual(openShiftsFor(shifts, 'craft').map((s) => s.$id), ['craft']);
});

test('a shift from before the two sides existed is the restaurant', () => {
  // No module at all. A database filter would step straight over it and the
  // shift somebody opened this morning would look like it had vanished.
  const shifts = [{ $id: 'old', opened_at: '2026-08-11T06:00:00.000Z' }];
  assert.deepEqual(openShiftsFor(shifts, 'kitchen').map((s) => s.$id), ['old']);
  assert.deepEqual(openShiftsFor(shifts, 'craft'), []);
});

test('nothing open is an empty list, not a crash', () => {
  assert.deepEqual(openShiftsFor([], 'kitchen'), []);
});

test('a bill that comes to nothing does not hold a shift open', () => {
  /**
   * A staff meal, a comp, a mistake put right with a full discount. Nothing is
   * owed and nothing ever will be, so nobody is coming to pay it. Held as a
   * blocker, the only way to close is to close over the warning — and a
   * warning people are taught to ignore is worse than no warning at all.
   */
  assert.equal(blockerFor({ status: 'SERVED', payment_status: 'unpaid', total: 0 }), null);
  assert.equal(blockerFor({ status: 'SERVED', payment_status: 'paid', total: 0 }), null);

  // Still on the pass is still a reason, whatever it costs.
  assert.equal(blockerFor({ status: 'READY', payment_status: 'unpaid', total: 0 }), 'uncollected');

  // And a real bill nobody has paid is exactly what this is for.
  assert.equal(blockerFor({ status: 'SERVED', payment_status: 'unpaid', total: 5000 }), 'unpaid');
  assert.equal(blockerFor({ status: 'READY', payment_status: 'paid', total: 5000 }), 'uncollected');
  assert.equal(blockerFor({ status: 'SERVED', payment_status: 'paid', total: 5000 }), null);
});

test('a part paid bill still holds the shift', () => {
  // Part of the money is not the money.
  assert.equal(blockerFor({ status: 'SERVED', payment_status: 'partial', total: 5000 }), 'unpaid');
});

/* --------------------------------------------- a payment recorded in error */

test('a voided payment is not money the business holds', () => {
  /**
   * One predicate, used everywhere money is added up, because the sites
   * disagreeing is the failure that matters. A voided payment still counted in
   * a drawer's expected takings makes the shift read as OVER by that amount,
   * and somebody gets asked where the extra money went.
   */
  assert.equal(isLivePayment({ status: 'captured' }), true);
  assert.equal(isLivePayment({ status: 'pending' }), true);
  assert.equal(isLivePayment({ status: 'voided' }), false);
  assert.equal(isLivePayment({ status: 'refunded' }), false);
  // Rows written before the field meant anything are real payments.
  assert.equal(isLivePayment({}), true);
});

test('a till that will not sell says which of the two reasons it is', () => {
  /**
   * A warning with no words in it is worse than no warning: a box appears in
   * the corner, the person knows something went wrong, and they are handed
   * nothing to act on. That is exactly what happened — shiftAgeMessage
   * describes a shift that has been open too long, and with NO shift there is
   * no age to describe, so it returned an empty string and the till showed an
   * empty red box.
   */
  assert.match(sellBlockedReason(null, 'craft') ?? '', /No till session is open/);
  assert.match(sellBlockedReason(undefined, 'kitchen') ?? '', /No shift is open/);
  assert.match(sellBlockedReason({ opened_at: '' }, 'craft') ?? '', /No till session is open/);
  // A shift that has been closed is not one you can sell on either.
  assert.match(
    sellBlockedReason({ opened_at: '2026-08-12T08:00:00Z', closed_at: '2026-08-12T20:00:00Z' }, 'craft') ?? '',
    /No till session is open/,
  );

  // Open and fresh: nothing is wrong, so nothing is said.
  const now = new Date('2026-08-12T12:00:00Z');
  assert.equal(sellBlockedReason({ opened_at: '2026-08-12T08:00:00Z' }, 'craft', now), null);

  // Open too long: the old message, which was always the right one for this.
  const stale = sellBlockedReason({ opened_at: '2026-08-10T08:00:00Z' }, 'craft', now);
  assert.match(stale ?? '', /Nothing new can be sold on it/);
  assert.notEqual(stale, '');
});

test('a bar with no shift open is told it cannot sell, not that it can keep cooking', () => {
  // The bar used to fall through to the kitchen's wording everywhere, which is
  // the same mistake that put the kitchen's whole till on screen when somebody
  // switched the counter to the bar.
  const none = sellBlockedReason(null, 'bar');
  assert.match(none ?? '', /nowhere to be recorded/i);
  assert.match(none ?? '', /ring it up/i);
  assert.doesNotMatch(none ?? '', /order/i);
});

test('a card terminal is not carried over as a float', () => {
  /**
   * A float is money left in a drawer overnight. Nothing is left in a card
   * terminal — the takings are swept to the bank and the machine starts
   * tomorrow at nothing.
   *
   * Carrying the card's count forward added yesterday's card takings to
   * today's expectation, and the day after added both: an expected figure that
   * grew every shift and could only be matched by typing a running total
   * instead of counting. That is a drawer which can never balance, and a
   * screen people stop reading.
   */
  const floats = carryOverFloats(
    { 'm-cash': 166_500, 'm-card': 69_000, 'm-momo': 4_000 },
    [{ $id: 'm-cash', kind: 'cash' }, { $id: 'm-card', kind: 'card' }, { $id: 'm-momo', kind: 'mobile_money' }],
  );
  assert.equal(floats['m-cash'], 166_500);
  assert.equal(floats['m-card'], 0);
  assert.equal(floats['m-momo'], 0);
});

test('a method with nothing counted against it starts at nothing, not undefined', () => {
  // Every method gets a key. A missing one reads as undefined downstream and
  // turns an expected figure into NaN, which is worse than a wrong number
  // because nothing on screen looks like an error.
  const floats = carryOverFloats({}, [{ $id: 'm-cash', kind: 'cash' }]);
  assert.equal(floats['m-cash'], 0);
});

test('a float carries over from this side\'s own last shift, not the building\'s', () => {
  /**
   * The bug this was written for. A kitchen, a bar and a craft shop each have
   * their own drawer. "The last closed shift" asked at eight in the morning
   * answers with whichever trade finished latest, which on most nights is the
   * bar — so the kitchen opened claiming an opening balance that was
   * physically in a different drawer in a different room.
   *
   * It then came up short by exactly that amount at close, and somebody was
   * asked where the money went.
   */
  const shifts = [
    { $id: 'bar', module: 'bar', status: 'closed', $createdAt: '2026-08-19T23:40:00.000Z' },
    { $id: 'kit', module: 'kitchen', status: 'closed', $createdAt: '2026-08-19T21:00:00.000Z' },
    { $id: 'old', module: 'kitchen', status: 'closed', $createdAt: '2026-08-18T21:00:00.000Z' },
  ];
  assert.equal(lastForSide(shifts, 'kitchen')?.$id, 'kit');
  assert.equal(lastForSide(shifts, 'bar')?.$id, 'bar');
  assert.equal(lastForSide(shifts, 'craft'), undefined, 'no craft shift to carry from');
});

test('a shift with no side on it is the kitchen, so old history still carries', () => {
  /**
   * Shifts opened before the module column existed carry none at all. Reading
   * them as anything but the kitchen — or filtering them out in the query —
   * would tell a business with a year of history that it had no previous
   * shift, and hand it a float of nothing every morning.
   */
  const shifts = [{ $id: 'legacy', status: 'closed', $createdAt: '2026-01-04T21:00:00.000Z' }];
  assert.equal(lastForSide(shifts, 'kitchen')?.$id, 'legacy');
  assert.equal(lastForSide(shifts, 'bar'), undefined);
});

test('a shift still open is never carried over from', () => {
  // Its drawer has not been counted, so there is no figure to carry.
  const shifts = [
    { $id: 'open', module: 'kitchen', status: 'open', $createdAt: '2026-08-20T09:00:00.000Z' },
    { $id: 'done', module: 'kitchen', status: 'closed', $createdAt: '2026-08-19T21:00:00.000Z' },
  ];
  assert.equal(lastForSide(shifts, 'kitchen')?.$id, 'done');
});

test('a float box left blank is refused, not read as nothing', () => {
  /**
   * A blank does not mean the drawer was empty; it means nobody answered.
   * Saving it would silently write the drawer down and turn an unanswered
   * question into a shortage somebody has to explain.
   */
  const names = { cash: 'Cash', card: 'Card' };
  assert.match(floatProblem({ cash: '', card: '0' }, names) ?? '', /Cash actually started with/);
  assert.match(floatProblem({ cash: '   ' }, names) ?? '', /blank is not nought/);
  // A counted nought is a real answer and goes through.
  assert.equal(floatProblem({ cash: '0', card: '0' }, names), null);
});

test('a drawer cannot have started with less than nothing', () => {
  // Not a small float — a missing record. Refused rather than warned about,
  // because it is not a judgement call.
  assert.match(floatProblem({ cash: '-50' }, { cash: 'Cash' }) ?? '', /less than nothing/);
});

test('the float change is described by what it does to the shortage', () => {
  /**
   * The figure people care about is not the float but what it does to the
   * expectation: a drawer told to start with money it never held comes up
   * short by exactly that, and that shortage has somebody's name against it.
   */
  const money = (n: number) => `GH¢${(n / 100).toFixed(2)}`;
  const down = describeFloatChange({ floats: { cash: 0 }, was: { cash: 145_000 } }, money);
  assert.equal(down.delta, -145_000);
  assert.match(down.text, /GH¢1450\.00 less/);
  assert.match(down.text, /shortage of that size disappears/);

  const up = describeFloatChange({ floats: { cash: 145_000 }, was: { cash: 0 } }, money);
  assert.match(up.text, /short by that much unless the money is really there/);

  // Saying nothing changed is more useful than a sentence about nought.
  assert.match(describeFloatChange({ floats: { cash: 100 }, was: { cash: 100 } }, money).text, /already says/);
});

test('a report can only be asked for again once a shift has closed', () => {
  /**
   * There is no closing report until there is a close. Resending from an open
   * shift would either send nothing or send a summary of a night still in
   * progress, and both are worse than the button not being there.
   */
  assert.equal(resendProblem({ code: 'BIST-07', status: 'closed' }), null);
  assert.match(resendProblem({ code: 'BIST-08', status: 'open' }) ?? '', /BIST-08 has not closed yet/);
  assert.match(resendProblem({}) ?? '', /That shift has not closed yet/);
});

test('a sealed shift may still have its report sent again', () => {
  /**
   * Everything else that can be done to a sealed shift changes a figure.
   * Sending an email a second time changes none — and refusing it would mean
   * the one night somebody most wants a copy of is the night they cannot have
   * one.
   */
  assert.equal(resendProblem({ code: 'BIST-07', status: 'closed', locked_at: '2026-08-20T09:00:00.000Z' } as never), null);
});

test('a resend is outstanding until the server clears it', () => {
  // Read from the shift, not from the report: the report for a resend does not
  // exist until the job has run, so "still waiting" is a fact only the request
  // carries.
  assert.equal(resendPending({ summary_resend_at: '2026-08-21T10:00:00.000Z' }), true);
  assert.equal(resendPending({}), false);
  assert.equal(resendPending({ summary_resend_at: null }), false);
});
