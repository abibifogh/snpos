import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftCode, shiftPrefix, shiftAge, shiftAgeMessage, SHIFT_MAX_HOURS, SHIFT_WARN_HOURS,
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
  const text = shiftAgeMessage(over);
  assert.match(text, /close it/i);
  assert.match(text, /30 hours/);

  const warn = shiftAge(opened, new Date(Date.parse(opened) + 21 * HOURS));
  assert.match(shiftAgeMessage(warn), /24 hours/);

  assert.equal(shiftAgeMessage(shiftAge(opened, new Date(Date.parse(opened) + HOURS))), '', 'nothing to say yet');
});
