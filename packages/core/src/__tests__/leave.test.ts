import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEAVE_CAP_DEFAULT, LEAVE_CAP_MAX, leaveCap, holdsAPlace, takenOnDay, daysInRange, dayWords,
  checkLeave, nothingBookedWords, partlyBookedWords, requestProblem, dayLoads, loadWords,
  overCapDays, capChangeWords,
} from '../leave.ts';
import type { LeaveDay } from '../leave.ts';

const off = (staff: string, day: string, over: Partial<LeaveDay> = {}): LeaveDay => ({
  staff_id: staff, staff_name: staff, day, kind: 'leave', status: 'requested', ...over,
});

test('three is the number until the house says otherwise', () => {
  assert.equal(LEAVE_CAP_DEFAULT, 3);
  assert.equal(leaveCap(undefined), 3);
  assert.equal(leaveCap(5), 5);
  assert.equal(leaveCap('4'), 4);
});

test('a cap that cannot be read falls back to the default, never to no limit', () => {
  /**
   * The failure that looks like the feature working. A missing or unreadable
   * setting meaning "unlimited" would let everybody book the same Saturday,
   * and nothing on any screen would say the limit had stopped applying.
   */
  assert.equal(leaveCap(null), 3);
  assert.equal(leaveCap('not a number'), 3);
  assert.equal(leaveCap(Number.NaN), 3);
});

test('a cap of nothing is not a policy, it is a stuck screen', () => {
  // Nobody may ever be off is not a rota rule anybody means. An admin who
  // wants that turns the feature off rather than setting it to nought.
  assert.equal(leaveCap(0), 1);
  assert.equal(leaveCap(-4), 1);
  assert.equal(leaveCap(1000), LEAVE_CAP_MAX);
  assert.equal(leaveCap(2.7), 2);
});

test('a request that nobody has answered still holds its place', () => {
  /**
   * The decision this whole file turns on. Counting only APPROVED leave would
   * let four people ask for the same Saturday, all be told yes, and the
   * problem arrive a week later when somebody finally opens the screen. A
   * request is a person who has told you they expect to be away.
   */
  assert.equal(holdsAPlace({ status: 'requested' }), true);
  assert.equal(holdsAPlace({ status: 'approved' }), true);
  assert.equal(holdsAPlace({ status: 'refused' }), false);
  assert.equal(holdsAPlace({ status: 'withdrawn' }), false);
  // A row written before the field existed is a request.
  assert.equal(holdsAPlace({}), true);
});

test('a refusal frees the place up again', () => {
  // A refusal that went on holding a place would shrink the rota by one every
  // time somebody asked for a day they could not have.
  const rows = [
    off('ama', '2026-09-12'),
    off('kofi', '2026-09-12', { status: 'refused' }),
    off('yaw', '2026-09-12', { status: 'approved' }),
  ];
  assert.equal(takenOnDay(rows, '2026-09-12'), 2);
});

test('the fourth person on a full day is refused, and told why', () => {
  /**
   * The reported requirement, and the sentence that matters. "Request
   * refused" sends somebody to find a manager to ask a question the screen
   * already knew the answer to — and on a rota, everybody asks it.
   */
  const existing = [off('ama', '2026-09-12'), off('kofi', '2026-09-12'), off('yaw', '2026-09-12')];
  const check = checkLeave({ days: ['2026-09-12'], staffId: 'regina', existing, cap: 3 });
  assert.deepEqual(check.allowed, []);
  const reason = check.refused[0].reason;
  assert.match(reason, /Saturday 12 September is full/);
  assert.match(reason, /3 people are already off or waiting for an answer/);
  assert.match(reason, /at most 3 can be off on one day/);
  assert.match(reason, /Pick another day/);
});

test('a colleague does not get a list of who else is off; a manager does', () => {
  /*
    A manager needs to know who to judge whether to make room. Another waiter
    does not need a list of their colleagues' business, and handing them one is
    how a useful screen becomes one people are careful around.
  */
  const existing = [off('ama', '2026-09-12'), off('kofi', '2026-09-12'), off('yaw', '2026-09-12')];
  const asStaff = checkLeave({ days: ['2026-09-12'], staffId: 'regina', existing, cap: 3 });
  assert.doesNotMatch(asStaff.refused[0].reason, /ama/i);

  const asManager = checkLeave({
    days: ['2026-09-12'], staffId: 'regina', existing, cap: 3, showNames: true,
  });
  assert.match(asManager.refused[0].reason, /\(ama, kofi, yaw\)/);
});

test('asking twice for your own day is not "the day is full"', () => {
  // Telling somebody a day is full when the person filling it is them is
  // nonsense, and it is the first thing anybody does by accident.
  const existing = [off('regina', '2026-09-12')];
  const again = checkLeave({ days: ['2026-09-12'], staffId: 'regina', existing, cap: 3 });
  assert.match(again.refused[0].reason, /already asked for/);

  const agreed = checkLeave({
    days: ['2026-09-12'], staffId: 'regina', existing: [off('regina', '2026-09-12', { status: 'approved' })], cap: 3,
  });
  assert.match(agreed.refused[0].reason, /already off on Saturday 12 September/);
});

test('a week where only some days are full books the days that are free', () => {
  /**
   * Refusing the whole week because Friday is busy would make somebody ask
   * again, one day at a time, until they found the gaps — which is the screen
   * doing nothing and the person doing the search.
   */
  const existing = [
    off('ama', '2026-09-11'), off('kofi', '2026-09-11'), off('yaw', '2026-09-11'),
    off('ama', '2026-09-13'), off('kofi', '2026-09-13'), off('yaw', '2026-09-13'),
  ];
  const check = checkLeave({
    days: daysInRange('2026-09-10', '2026-09-14'), staffId: 'regina', existing, cap: 3,
  });
  assert.deepEqual(check.allowed, ['2026-09-10', '2026-09-12', '2026-09-14']);
  assert.deepEqual(check.refused.map((r) => r.day), ['2026-09-11', '2026-09-13']);
  assert.match(String(partlyBookedWords(check)), /3 of 5 days went through/);
  assert.equal(nothingBookedWords(check), null);
});

test('when nothing at all went through, that is said as its own sentence', () => {
  const existing = [off('ama', '2026-09-12'), off('kofi', '2026-09-12'), off('yaw', '2026-09-12')];
  const check = checkLeave({ days: ['2026-09-12'], staffId: 'regina', existing, cap: 3 });
  assert.equal(String(nothingBookedWords(check)), 'That day could not be booked.');
  assert.equal(partlyBookedWords(check), null);
});

test('a range is every day in it, and a backwards one is none', () => {
  assert.deepEqual(daysInRange('2026-09-10', '2026-09-12'), ['2026-09-10', '2026-09-11', '2026-09-12']);
  assert.deepEqual(daysInRange('2026-09-10', '2026-09-10'), ['2026-09-10']);
  assert.deepEqual(daysInRange('2026-09-12', '2026-09-10'), []);
  assert.deepEqual(daysInRange('nonsense', '2026-09-10'), []);
});

test('a day reads as somebody would say it', () => {
  assert.equal(dayWords('2026-09-12'), 'Saturday 12 September');
});

test('a request with no days, or one in the past, is a different mistake', () => {
  /*
    Reporting either as a full rota would send somebody hunting for a free day
    when the day was never the problem.
  */
  assert.match(String(requestProblem({ days: [], todayDay: '2026-09-03' })), /Pick the day/);
  assert.match(
    String(requestProblem({ days: ['2026-09-01'], todayDay: '2026-09-03' })),
    /in the past/,
  );
  assert.equal(requestProblem({ days: ['2026-09-03'], todayDay: '2026-09-03' }), null);
  // Exactly at the limit is inside it; a day past is not.
  assert.equal(requestProblem({ days: ['2027-09-03'], todayDay: '2026-09-03', maxAheadDays: 365 }), null);
  assert.match(
    String(requestProblem({ days: ['2027-09-04'], todayDay: '2026-09-03', maxAheadDays: 365 })),
    /more than 365 days ahead/,
  );
});

test('the admin sees empty days too, because that is the question they came with', () => {
  /*
    A list of only the busy days answers "who is off" and not "can I let
    somebody off on the fourteenth", and the second is what an admin opens
    this screen to decide.
  */
  const loads = dayLoads([off('ama', '2026-09-11')], daysInRange('2026-09-10', '2026-09-12'), 3);
  assert.deepEqual(loads.map((l) => [l.day, l.taken, l.full]), [
    ['2026-09-10', 0, false],
    ['2026-09-11', 1, false],
    ['2026-09-12', 0, false],
  ]);
  assert.equal(loadWords(loads[0]), 'Nobody off. Room for 3.');
  assert.equal(loadWords(loads[1]), '1 of 3 off. Room for 2 more.');
  assert.match(loadWords(dayLoads(
    [off('a', '2026-09-11'), off('b', '2026-09-11'), off('c', '2026-09-11')],
    ['2026-09-11'],
    3,
  )[0]), /Full: 3 of 3/);
});

test('lowering the cap names the days now over it and unbooks nobody', () => {
  /**
   * Leave already agreed is somebody's plan — a bus booked, a family thing.
   * Software that quietly cancelled it to satisfy a number an admin typed
   * would be worse than the overbooking it was fixing.
   */
  const rows = [off('a', '2026-09-11'), off('b', '2026-09-11'), off('c', '2026-09-11', { status: 'approved' })];
  const over = overCapDays(rows, daysInRange('2026-09-10', '2026-09-12'), 2);
  assert.deepEqual(over.map((d) => d.day), ['2026-09-11']);
  const words = String(capChangeWords(over));
  assert.match(words, /1 day is already over the new limit/);
  assert.match(words, /Friday 11 September \(3\)/);
  assert.match(words, /Nobody has been unbooked/);
  assert.equal(capChangeWords([]), null);
});
