import test from 'node:test';
import assert from 'node:assert/strict';
import { nameBook, nameFrom, namesByBothIds, GONE_STAFF } from '../staff-words.ts';

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

test('a person is known by either of their two ids', () => {
  /*
    Every record here carries one of two ids for the same person: what they
    wrote carries their login's, what points at them as a colleague carries
    their staff profile's. A detail panel that looked profiles up by document
    id alone found nothing for anything staff had recorded, and said so as
    "Somebody no longer on the staff list" — about people who were at work.
  */
  const book = namesByBothIds([
    { $id: 'prof1', user_id: 'user1', display_name: 'Stephanie' },
    { $id: 'prof2', display_name: 'Betty' },
    { $id: 'prof3', user_id: 'user3', display_name: '' },
  ]);

  assert.equal(book.prof1, 'Stephanie');
  assert.equal(book.user1, 'Stephanie');
  // A profile never linked to a login is still found by its own id.
  assert.equal(book.prof2, 'Betty');
  // A blank name is a profile nobody filled in, which is not the same as a
  // profile that is gone, and must not read as one.
  assert.equal(book.prof3, 'Somebody with no name set');
  assert.equal(book.user3, 'Somebody with no name set');

  assert.equal(book.somebodyelse, undefined);
  assert.deepEqual(namesByBothIds([]), {});
});
