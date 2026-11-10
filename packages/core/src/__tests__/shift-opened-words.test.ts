import test from 'node:test';
import assert from 'node:assert/strict';
import { openedSinceWords, openedBeforeToday } from '../shift-rules.ts';

// Local times, so the test reads the same in any timezone it runs in.
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);
const NOW = local(2026, 11, 10, 14, 30);

test('a shift opened today says only the time', () => {
  assert.match(openedSinceWords(local(2026, 11, 10, 9, 5).toISOString(), NOW), /^since \d{1,2}:05/);
  assert.equal(openedBeforeToday(local(2026, 11, 10, 9, 5).toISOString(), NOW), false);
});

test('a shift left open from yesterday says yesterday', () => {
  assert.match(openedSinceWords(local(2026, 11, 9, 18, 5).toISOString(), NOW), /^since yesterday \S*\d{1,2}:05/);
  assert.equal(openedBeforeToday(local(2026, 11, 9, 18, 5).toISOString(), NOW), true);
});

test('older than yesterday names the day', () => {
  const words = openedSinceWords(local(2026, 11, 7, 18, 5).toISOString(), NOW);
  assert.match(words, /^since .*7.*, .*05/);
  assert.doesNotMatch(words, /yesterday/);
});

test('a date that cannot be read says nothing rather than something wrong', () => {
  assert.equal(openedSinceWords('not a date', NOW), '');
  assert.equal(openedBeforeToday('not a date', NOW), false);
});
