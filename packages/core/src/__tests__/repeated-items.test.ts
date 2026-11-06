import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatsOf, repeatedItemsProblem } from '../repeated-items.ts';

test('a line whose item is already on an earlier line points at that line', () => {
  assert.deepEqual(repeatsOf(['tom', 'onion', 'pepper', 'tom', '', '', 'onion']), [null, null, null, 0, null, null, 1]);
});

test('blank lines are never repeats of each other', () => {
  assert.deepEqual(repeatsOf(['', '', ' ']), [null, null, null]);
});

test('a purchase with an item twice is refused, naming it once', () => {
  const lines = [
    { id: 'tom', name: 'Tomatoes' }, { id: 'onion', name: 'Onion' }, { id: 'tom', name: 'Tomatoes' }, { id: 'tom', name: 'Tomatoes' },
  ];
  assert.match(repeatedItemsProblem(lines) ?? '', /^Tomatoes is listed more than once\. Put each item on one line/);
});

test('two items repeated are both named', () => {
  const lines = [
    { id: 'tom', name: 'Tomatoes' }, { id: 'onion', name: 'Onion' }, { id: 'tom', name: 'Tomatoes' }, { id: 'onion', name: 'Onion' },
  ];
  assert.match(repeatedItemsProblem(lines) ?? '', /^Tomatoes and Onion are listed more than once/);
});

test('every item once is fine', () => {
  assert.equal(repeatedItemsProblem([{ id: 'tom', name: 'Tomatoes' }, { id: 'onion', name: 'Onion' }]), null);
});
