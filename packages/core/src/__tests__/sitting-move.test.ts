import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sittingMoveProblem, sittingIsMovable, leadMs, fireAtFor, spanOf, moveWords, MOVE_LIMIT_YEARS,
} from '../sitting-move.ts';
import type { Sitting } from '../sitting-move.ts';

/*
  A party's coach is late and Thursday lunch has to become Thursday dinner.
  Until this existed the only way was to cancel the booking and have them order
  the whole thing again — losing every choice, every omission and every note
  they typed, and handing the kitchen new order numbers for the same party.
*/

const NOW = new Date('2026-03-10T12:00:00Z');
const at = (iso: string) => new Date(iso);

/** A sitting on Thursday lunch, where the kitchen starts 45 minutes before. */
const sitting = (over: Partial<Sitting> = {}): Sitting => ({
  $id: 'o1',
  order_no: 'K-104',
  status: 'SCHEDULED',
  scheduled_for: '2026-03-12T12:30:00Z',
  fire_at: '2026-03-12T11:45:00Z',
  ...over,
});

test('a sitting the kitchen has not seen yet can be moved', () => {
  assert.equal(sittingIsMovable(sitting()), true);
  assert.equal(sittingMoveProblem({ sitting: sitting(), to: at('2026-03-12T19:00:00Z'), now: NOW }), null);
});

test('a sitting the pass already has is refused, and told why', () => {
  /*
    The line that matters most here. Once a ticket is on a kitchen screen
    somebody is cooking to that clock, and changing it does not move the meal —
    it makes the screen lie about a pan that is already on.
  */
  for (const status of ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED']) {
    const why = sittingMoveProblem({ sitting: sitting({ status }), to: at('2026-03-12T19:00:00Z'), now: NOW });
    assert.match(String(why), /kitchen already has/i, `${status} should be refused`);
  }
});

test('a sitting that is already off has nothing to move', () => {
  for (const status of ['CANCELLED', 'REJECTED']) {
    const why = sittingMoveProblem({ sitting: sitting({ status }), to: at('2026-03-12T19:00:00Z'), now: NOW });
    assert.match(String(why), /already off/i);
  }
});

test('the past is refused', () => {
  const why = sittingMoveProblem({ sitting: sitting(), to: at('2026-03-09T12:00:00Z'), now: NOW });
  assert.match(String(why), /already passed/i);
});

test('no time picked is asked for rather than refused', () => {
  assert.match(String(sittingMoveProblem({ sitting: sitting(), to: null, now: NOW })), /Pick a date and a time/);
});

test('the hour the kitchen must start is what is actually checked', () => {
  /*
    THE CONSTRAINT NOBODY THINKS OF. Twenty minutes from now looks like the
    future and is not: this food needs forty-five, so the stove had to be lit
    before the move was made.
  */
  const why = sittingMoveProblem({ sitting: sitting(), to: at('2026-03-10T12:20:00Z'), now: NOW });
  assert.match(String(why), /kitchen would have had to start/i);
  // Far enough ahead that the lead fits, and it is allowed.
  assert.equal(sittingMoveProblem({ sitting: sitting(), to: at('2026-03-10T13:00:00Z'), now: NOW }), null);
});

test('the refusal names the hour, so somebody knows what to pick instead', () => {
  const why = String(sittingMoveProblem({ sitting: sitting(), to: at('2026-03-10T12:20:00Z'), now: NOW }));
  assert.match(why, /\d{1,2}:\d{2}/, 'a time is in the sentence');
});

test('moving it to the time it is already booked for is not a move', () => {
  const why = sittingMoveProblem({ sitting: sitting(), to: at('2026-03-12T12:30:00Z'), now: NOW });
  assert.match(String(why), /already booked for/i);
});

test('a booking weeks out can be moved, because that is what group bookings ARE', () => {
  /*
    REPORTED. Every Move on a real booking was refused with "Bookings are only
    taken 7 days ahead", quoting the PRE-ORDER picker's window — the rule that
    stops a walk-in guest booking a collection months out. It has nothing to do
    with re-timing a sitting already accepted and already in the diary, and a
    group books weeks ahead by definition. A party of 195 had four October
    sittings on screen and not one of them could be touched.
  */
  const october = at('2026-10-11T19:00:00Z');   // 25 days out
  assert.equal(sittingMoveProblem({ sitting: sitting(), to: october, now: NOW }), null);

  const months = at('2026-06-01T12:30:00Z');
  assert.equal(sittingMoveProblem({ sitting: sitting(), to: months, now: NOW }), null);

  const nextYear = at('2027-03-01T12:30:00Z');
  assert.equal(sittingMoveProblem({ sitting: sitting(), to: nextYear, now: NOW }), null);
});

test('a mistyped year is caught, and the message says so', () => {
  // One keystroke — 2126 for 2026 — silently puts a booking a century out.
  const century = at('2126-03-12T12:30:00Z');
  const why = String(sittingMoveProblem({ sitting: sitting(), to: century, now: NOW }));
  assert.match(why, /Check the year/i);
  assert.match(why, new RegExp(`${MOVE_LIMIT_YEARS} years`));
  // And it says nothing about a booking policy, because it is not one.
  assert.doesNotMatch(why, /Bookings are only taken/i);
});

/* ------------------------------------------------------- the lead it keeps */

test('the gap the order was given is the gap it keeps', () => {
  /*
    Taken from the order rather than worked out again from today's dishes. A
    dish whose prep time was edited since must not silently re-time a booking
    quoted under the old one.
  */
  assert.equal(leadMs(sitting()), 45 * 60_000);
  const moved = fireAtFor(sitting(), at('2026-03-12T19:00:00Z'));
  assert.equal(moved.toISOString(), '2026-03-12T18:15:00.000Z');
});

test('an order with no fire time of its own fires when it is served', () => {
  // Nothing to preserve, so nothing is invented: the alternative is guessing a
  // lead and quietly moving the kitchen's start by it.
  const bare = sitting({ fire_at: undefined });
  assert.equal(leadMs(bare), 0);
  assert.equal(fireAtFor(bare, at('2026-03-12T19:00:00Z')).toISOString(), '2026-03-12T19:00:00.000Z');
});

test('a fire time after the sitting is ignored rather than trusted', () => {
  // Bad data must not push the kitchen's start LATER than service.
  assert.equal(leadMs(sitting({ fire_at: '2026-03-12T13:30:00Z' })), 0);
});

/* --------------------------------------------------- what the booking says */

test('the booking span is worked out from the sittings, not nudged', () => {
  const span = spanOf([
    sitting({ $id: 'a', scheduled_for: '2026-03-12T12:30:00Z' }),
    sitting({ $id: 'b', scheduled_for: '2026-03-10T19:00:00Z' }),
    sitting({ $id: 'c', scheduled_for: '2026-03-14T12:30:00Z' }),
  ]);
  assert.equal(span?.firstAt, '2026-03-10T19:00:00Z');
  assert.equal(span?.lastAt, '2026-03-14T12:30:00Z');
});

test('moving the only early sitting moves when the party arrives', () => {
  const before = spanOf([
    sitting({ $id: 'a', scheduled_for: '2026-03-10T19:00:00Z' }),
    sitting({ $id: 'b', scheduled_for: '2026-03-14T12:30:00Z' }),
  ]);
  const after = spanOf([
    sitting({ $id: 'a', scheduled_for: '2026-03-16T19:00:00Z' }),
    sitting({ $id: 'b', scheduled_for: '2026-03-14T12:30:00Z' }),
  ]);
  assert.equal(before?.firstAt, '2026-03-10T19:00:00Z');
  assert.equal(after?.firstAt, '2026-03-14T12:30:00Z', 'the booking now starts on the other day');
  assert.equal(after?.lastAt, '2026-03-16T19:00:00Z');
});

test('a cancelled sitting is not when the party arrives', () => {
  const span = spanOf([
    sitting({ $id: 'a', scheduled_for: '2026-03-10T19:00:00Z', status: 'CANCELLED' }),
    sitting({ $id: 'b', scheduled_for: '2026-03-14T12:30:00Z' }),
  ]);
  assert.equal(span?.firstAt, '2026-03-14T12:30:00Z');
});

test('a booking with nothing left standing has no span at all', () => {
  assert.equal(spanOf([]), null);
  assert.equal(spanOf([sitting({ status: 'CANCELLED' })]), null);
});

test('the move is described in both times, for the log and the screen', () => {
  const words = moveWords('2026-03-12T12:30:00Z', at('2026-03-12T19:00:00Z'));
  assert.match(words, /^Moved from .+ to .+$/);
  assert.equal(moveWords(undefined, at('2026-03-12T19:00:00Z')), 'Moved');
});
