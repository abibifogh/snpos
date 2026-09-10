import test from 'node:test';
import assert from 'node:assert/strict';
import { dateWords, timeWords, dateTimeWords } from '../dates.ts';
import { bpWords } from '../money.ts';

test('a moment reads the same three ways everywhere, and a bad one reads as a dash', () => {
  const at = new Date(2026, 8, 9, 20, 17);
  assert.match(dateWords(at), /9 Sep 2026/);
  assert.match(timeWords(at), /20:17/);
  assert.equal(dateTimeWords(at), `${dateWords(at)}, ${timeWords(at)}`);
  assert.equal(dateWords(at.toISOString()), dateWords(at));
  assert.equal(dateWords('not a date'), '—');
  assert.equal(timeWords(undefined, ''), '');
  assert.equal(dateTimeWords(null), '—');
});

test('a rate in basis points reads as a percentage', () => {
  assert.equal(bpWords(3000), '30%');
  assert.equal(bpWords(1250), '12.5%');
  assert.equal(bpWords(1250, 1), '12.5%');
  assert.equal(bpWords(1234, 1), '12.3%');
  assert.equal(bpWords(0), '0%');
  assert.equal(bpWords(null), '');
});
