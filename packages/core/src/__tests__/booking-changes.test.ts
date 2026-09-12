import test from 'node:test';
import assert from 'node:assert/strict';
import {
  daysUntil, changeProblem, changeWindowWords, requestProblem, CHANGE_CUTOFF_DAYS, CHANGE_KIND_WORDS,
} from '../booking-changes.ts';

const first = '2026-11-20T12:00:00';

test('the cutoff is counted from the first sitting, and it is five days', () => {
  /*
    From the FIRST, not from each one. A stay is shopped for, prepped and
    staffed as a whole: by the time the first meal is five days out the order
    has gone to suppliers, and moving the fourth night moves the same shopping.
  */
  assert.equal(CHANGE_CUTOFF_DAYS, 5);
  assert.equal(daysUntil(first, new Date('2026-11-14T12:00:00')), 6);
  assert.equal(changeProblem(first, new Date('2026-11-14T12:00:00')), null);
  // Exactly five days is still in.
  assert.equal(changeProblem(first, new Date('2026-11-15T12:00:00')), null);
});

test('inside five days it is a telephone call, and says so', () => {
  const said = String(changeProblem(first, new Date('2026-11-16T12:00:00')));
  assert.match(said, /Changes close 5 days before the first meal/);
  assert.match(said, /ring the restaurant/);
  // A few hours inside the boundary is inside it.
  assert.match(String(changeProblem(first, new Date('2026-11-15T18:00:00'))), /has passed/);
});

test('a booking that has started, and one with no date, are told apart', () => {
  assert.match(String(changeProblem(first, new Date('2026-11-21T12:00:00'))), /already started/);
  assert.match(String(changeProblem('not a date')), /no date on it/);
});

test('the window is said as a date, not as a rule', () => {
  // "Changes had to be in by 15 November" is something somebody checks against
  // their own calendar. "The cutoff is five days" makes them do the sum.
  const words = changeWindowWords(first, (d) => `${d.getDate()}/${d.getMonth() + 1}`);
  assert.match(words, /until 15\/11/);
  assert.match(words, /5 days before the first meal/);
  assert.equal(changeWindowWords('nonsense', () => 'x'), '');
});

test('a request has to say what it actually wants', () => {
  /*
    The heading is not enough. "A day or a time" tells the kitchen something
    moved and nothing about what it moved to, and a request somebody has to
    ring back about has cost two telephone calls instead of one.
  */
  assert.match(String(requestProblem('', 'we need eight more lunches please')), /what kind of change/);
  assert.match(String(requestProblem('numbers', 'more')), /in your own words/);
  assert.match(String(requestProblem('numbers', '   ')), /in your own words/);
  assert.equal(requestProblem('numbers', 'Eight more for Tuesday lunch please'), null);
  assert.match(String(requestProblem('other', 'x'.repeat(2001))), /longer than this box holds/);
  assert.equal(CHANGE_KIND_WORDS.cancel, 'Cancel all or part of it');
});
