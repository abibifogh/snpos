import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, QUERY_VALUES_MAX, dayStartIso, dayEndIso, windowProblem } from '../reading.ts';

test('ids are split into batches a query can carry', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('a list shorter than a batch is one batch', () => {
  assert.deepEqual(chunk([1, 2], 100), [[1, 2]]);
});

test('nothing to fetch is no queries at all', () => {
  // Not one query with an empty list: that matches everything on some
  // databases and nothing on others, and neither is what was asked for.
  assert.deepEqual(chunk([], 100), []);
});

test('an exact multiple does not leave an empty batch on the end', () => {
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test('a nonsense batch size is refused rather than looping for ever', () => {
  assert.throws(() => chunk([1], 0), /at least 1/);
});

test('the batch size matches what the database accepts', () => {
  assert.equal(QUERY_VALUES_MAX, 100);
});

test('a day runs from its own midnight to its own last moment', () => {
  // Local, not UTC. A report ending at midnight elsewhere drops the last
  // hours of trading, which in Accra is the busiest part of the evening.
  const start = new Date(dayStartIso('2026-08-18'));
  const end = new Date(dayEndIso('2026-08-18'));
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(end.getHours(), 23);
  assert.equal(end.getMinutes(), 59);
});

test('the end of a day is after its start', () => {
  assert.ok(dayEndIso('2026-08-18') > dayStartIso('2026-08-18'));
});

test('one day’s end is before the next day’s start', () => {
  assert.ok(dayEndIso('2026-08-18') < dayStartIso('2026-08-19'));
});

test('a window with the dates the wrong way round says so', () => {
  assert.match(windowProblem('2026-08-20', '2026-08-18') ?? '', /after the second/);
  assert.match(windowProblem('', '2026-08-18') ?? '', /both dates/);
  assert.equal(windowProblem('2026-08-18', '2026-08-20'), null);
  assert.equal(windowProblem('2026-08-18', '2026-08-18'), null);
});
