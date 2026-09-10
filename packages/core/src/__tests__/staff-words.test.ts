import test from 'node:test';
import assert from 'node:assert/strict';
import { nameBook, nameFrom, GONE_STAFF } from '../staff-words.ts';

test('a name by profile id or user id; gone when neither; waiting while the book is empty', () => {
  const book = nameBook([{ $id: 'p1', user_id: 'u1', display_name: 'Regina' }, { $id: 'p2', display_name: 'Kofi' }]);
  assert.equal(nameFrom(book, 'p1'), 'Regina');
  assert.equal(nameFrom(book, 'u1'), 'Regina');
  assert.equal(nameFrom(book, 'p2'), 'Kofi');
  assert.equal(nameFrom(book, 'left'), GONE_STAFF);
  assert.equal(nameFrom(book, ''), '—');
  assert.equal(nameFrom(book, undefined, ''), '');
  assert.equal(nameFrom(new Map(), 'p1'), '…');
  assert.equal(nameFrom(null, 'p1'), '…');
});
