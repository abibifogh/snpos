import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseDue, bookedStage, bookedList, nextBooked, inWords, RELEASE_GRACE_MS } from '../preorders.ts';
import { isOverdue, minutesOver, clockStart } from '../orders-time.ts';

const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const NOW = local(17, 12, 0);
const iso = (d: Date) => d.toISOString();
const order = (over: Record<string, unknown> = {}) => ({
  $id: 'o1', status: 'SCHEDULED', is_preorder: true,
  scheduled_for: iso(local(17, 13, 0)), fire_at: iso(local(17, 12, 35)), ...over,
});

test('a booked order turns amber half an hour before the kitchen starts it, red two minutes after', () => {
  assert.equal(bookedStage(order(), local(17, 11, 0).getTime()), 'booked');
  assert.equal(bookedStage(order(), local(17, 12, 10).getTime()), 'soon');
  assert.equal(bookedStage(order(), local(17, 12, 36).getTime()), 'due');
  assert.equal(bookedStage(order(), local(17, 12, 38).getTime()), 'late');
  assert.equal(bookedStage(order({ status: 'PENDING' }), local(17, 12, 38).getTime()), 'sent');
});

test('a screen releases a pre-order only once the server has had two minutes', () => {
  const at = local(17, 12, 35).getTime();
  assert.equal(releaseDue(order(), at + RELEASE_GRACE_MS - 1), false);
  assert.equal(releaseDue(order(), at + RELEASE_GRACE_MS), true);
  assert.equal(releaseDue(order({ status: 'PENDING' }), at + 10 * RELEASE_GRACE_MS), false, 'already in the kitchen');
  assert.equal(releaseDue(order({ fire_at: null }), at), false);
});

test('the till lists today and tomorrow, soonest first, and keeps a released one for a few hours', () => {
  const rows = [
    order({ $id: 'late-lunch', scheduled_for: iso(local(17, 14, 0)), fire_at: iso(local(17, 13, 15)) }),
    order({ $id: 'lunch' }),
    order({ $id: 'sent', status: 'PENDING', fired_at: iso(local(17, 11, 0)), scheduled_for: iso(local(17, 11, 30)) }),
    order({ $id: 'old', status: 'PENDING', fired_at: iso(local(17, 7, 0)), scheduled_for: iso(local(17, 7, 30)) }),
    order({ $id: 'tomorrow', scheduled_for: iso(local(18, 9, 30)), fire_at: iso(local(18, 9, 0)) }),
    order({ $id: 'next-week', scheduled_for: iso(local(24, 9, 30)) }),
    order({ $id: 'gone', status: 'CANCELLED' }),
    { $id: 'walk-in', status: 'PENDING', is_preorder: false },
  ];
  const { today, tomorrow } = bookedList(rows, NOW);
  assert.deepEqual(today.map((o) => o.$id), ['sent', 'lunch', 'late-lunch']);
  assert.deepEqual(tomorrow.map((o) => o.$id), ['tomorrow']);
  assert.equal(nextBooked(rows, NOW)?.$id, 'lunch');
});

test('the kitchen clock starts when a pre-order reached the kitchen, not when it was placed', () => {
  const placedLastNight = iso(local(16, 21, 12));
  const released = iso(local(17, 12, 35));
  const o = { status: 'ACCEPTED', $createdAt: placedLastNight, fired_at: released };
  assert.equal(clockStart(o), released);
  assert.equal(isOverdue(o, 25, local(17, 12, 50).getTime()), false, '15 minutes in, of 25');
  assert.equal(minutesOver(o, 25, local(17, 12, 50).getTime()), -10);
  assert.equal(isOverdue(o, 25, local(17, 13, 5).getTime()), true);
  // An ordinary order still counts from when it was placed.
  assert.equal(clockStart({ $createdAt: placedLastNight }), placedLastNight);
});

test('time left reads plainly', () => {
  assert.equal(inWords(70 * 60_000), '1 h 10 min');
  assert.equal(inWords(25 * 60_000), '25 min');
  assert.equal(inWords(120 * 60_000), '2 h');
  assert.equal(inWords(-1), 'now');
});
