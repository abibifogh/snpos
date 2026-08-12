import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftCode, shiftPrefix, shiftAge, shiftAgeMessage, overdueFrom, isPastLimit,
  SHIFT_MAX_HOURS, SHIFT_WARN_HOURS,
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
  for (const side of ['kitchen', 'craft'] as const) {
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

  const warn = shiftAge(opened, new Date(Date.parse(opened) + 21 * HOURS));
  assert.match(shiftAgeMessage(warn), /24 hours/);
  assert.match(shiftAgeMessage(warn, SHIFT_MAX_HOURS, 'craft'), /24 hours/);

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
