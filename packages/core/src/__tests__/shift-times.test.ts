import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeTimeProblem, closeTimeEffects, describeCloseChange, hoursBetween, sameDay,
  type TimedShift,
} from '../shift-times.ts';

const shift = (over: Partial<TimedShift> = {}): TimedShift => ({
  code: 'BAR-04',
  status: 'closed',
  opened_at: '2026-08-18T17:00:00.000Z',
  closed_at: '2026-08-19T01:00:00.000Z',
  ...over,
});

const now = new Date('2026-08-20T09:00:00.000Z');

test('a shift still open has no closing time to correct', () => {
  // Setting one would leave a shift claiming to have ended while it is still
  // taking money.
  const problem = closeTimeProblem(shift({ status: 'open', closed_at: undefined }), now.toISOString(), now);
  assert.match(problem ?? '', /still open/);
  assert.match(problem ?? '', /Close it from the till first/);
});

test('a shift cannot end before it began', () => {
  /**
   * Every length, every report window and every "how long was this" comes off
   * the pair. A negative one is not merely wrong, it is nonsense.
   */
  const problem = closeTimeProblem(shift(), '2026-08-18T09:00:00.000Z', now);
  assert.match(problem ?? '', /cannot end before it began/);
});

test('and cannot have ended in the future', () => {
  assert.match(closeTimeProblem(shift(), '2026-08-21T09:00:00.000Z', now) ?? '', /in the future/);
});

test('a plain correction is allowed with nothing to say about it', () => {
  // 1am moved to 2am the same night: no day change, no narrowing, well within
  // the limit. A warning here is one people learn to click past.
  const closedAt = '2026-08-19T02:00:00.000Z';
  assert.equal(closeTimeProblem(shift(), closedAt, now), null);
  const effects = closeTimeEffects({ shift: shift(), closedAt });
  assert.deepEqual(effects.warnings, []);
  assert.equal(effects.hours, 9);
});

test('a correction onto another day says which day, and that reports do not resend', () => {
  /**
   * The reason somebody is here, usually. A till nobody got back to until the
   * morning is reported under the wrong day until this is fixed.
   */
  const late = shift({ closed_at: '2026-08-19T11:00:00.000Z' });
  const effects = closeTimeEffects({ shift: late, closedAt: '2026-08-19T01:00:00.000Z' });
  // Same calendar day here, so no day warning — but it does narrow.
  assert.equal(effects.movesDay, false);
  assert.equal(effects.narrows, true);
  assert.equal(effects.warnings.length, 1);
  assert.match(effects.warnings[0], /paid for on this shift stays on it/);
});

test('moving the close onto a different day is named, with the day in it', () => {
  const late = shift({ closed_at: '2026-08-20T08:00:00.000Z' });
  const effects = closeTimeEffects({ shift: late, closedAt: '2026-08-19T01:00:00.000Z' });
  assert.equal(effects.movesDay, true);
  assert.equal(effects.warnings.length, 2, 'the day change and the narrowing');
  assert.match(effects.warnings[0], /reported under that day/);
  assert.match(effects.warnings[0], /not sent again/);
});

test('an over-long shift is warned about but never refused', () => {
  /**
   * A shift somebody forgot to close really did sit open that long, and
   * refusing the true figure would force a false one.
   */
  const effects = closeTimeEffects({
    shift: shift({ closed_at: '2026-08-19T01:00:00.000Z' }),
    closedAt: '2026-08-20T08:00:00.000Z',
    maxHours: 24,
  });
  assert.equal(effects.hours, 39);
  assert.equal(closeTimeProblem(shift(), '2026-08-20T08:00:00.000Z', now), null);
  assert.ok(effects.warnings.some((w) => /39 hours long/.test(w)));
  assert.ok(effects.warnings.some((w) => /when the till actually stopped/.test(w)));
});

test('widening the window raises nothing about dropped orders', () => {
  // Only narrowing can drop one. Warning on both would be warning on nothing.
  const effects = closeTimeEffects({
    shift: shift({ closed_at: '2026-08-18T23:00:00.000Z' }),
    closedAt: '2026-08-19T01:00:00.000Z',
  });
  assert.equal(effects.narrows, false);
  assert.ok(!effects.warnings.some((w) => /drop off/.test(w)));
});

test('rubbish in the box is refused before anything else is judged', () => {
  assert.equal(closeTimeProblem(shift(), 'not a date', now), 'That is not a date and time.');
});

test('hours and days are worked out the way a person would read them', () => {
  assert.equal(hoursBetween('2026-08-18T17:00:00.000Z', '2026-08-19T01:30:00.000Z'), 8.5);
  assert.equal(hoursBetween('2026-08-18T17:00:00.000Z', 'rubbish'), 0);
  assert.equal(sameDay('2026-08-19T01:00:00.000Z', '2026-08-19T23:00:00.000Z'), true);
  assert.equal(sameDay('2026-08-19T01:00:00.000Z', '2026-08-20T01:00:00.000Z'), false);
});

test('the change reads the same in a confirmation as in the log a year later', () => {
  const line = describeCloseChange(shift(), '2026-08-19T02:00:00.000Z');
  assert.match(line, /^BAR-04 closed at .*, corrected to .*\.$/);
});
