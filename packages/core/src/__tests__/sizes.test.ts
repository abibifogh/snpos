import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLiveSize, liveSizes, retiredSizes, duplicateSizeLabels, sizeProblem, retiredWords,
} from '../sizes.ts';

test('a retired size is not a size the form may edit', () => {
  /**
   * The reported fault. A size that has already sold something is switched off
   * rather than deleted — its id is on order lines and stock movements — and
   * the edit form asked for every size the drink had ever had and drew them
   * all the same way. A retired Large beside the Large that replaced it reads
   * as a duplicate, because from the screen it is one.
   */
  const sizes = [
    { $id: 'old', label: 'Large', active: false },
    { $id: 'new', label: 'Large', active: true },
  ];
  assert.deepEqual(liveSizes(sizes).map((s) => s.$id), ['new']);
  assert.deepEqual(retiredSizes(sizes).map((s) => s.$id), ['old']);
});

test('a size with no flag on it is live, as it always has been', () => {
  // Every row written before the flag existed was being sold. Reading a
  // missing value as retired would empty the sizes off every older drink.
  assert.equal(isLiveSize({ label: 'Large' }), true);
  assert.equal(isLiveSize({ label: 'Large', active: true }), true);
  assert.equal(isLiveSize({ label: 'Large', active: false }), false);
});

test('a retired size beside its replacement is not a duplicate', () => {
  /*
    This is the ordinary way replacing a size works, and calling it a fault
    would refuse a save that is perfectly correct.
  */
  assert.deepEqual(duplicateSizeLabels([
    { $id: 'old', label: 'Large', active: false },
    { $id: 'new', label: 'Large', active: true },
  ]), []);
});

test('two LIVE sizes with one name are refused, and the reason is the till', () => {
  /**
   * The customer sees two identical buttons and whichever they press decides
   * whether anything comes off a shelf, because only one of the two is bound
   * to a recipe. That is not a naming preference; it is the drink that pours
   * nothing.
   */
  const sizes = [{ $id: 'a', label: 'Large' }, { $id: 'b', label: 'Large' }];
  assert.deepEqual(duplicateSizeLabels(sizes), ['Large']);
  const problem = String(sizeProblem(sizes));
  assert.match(problem, /two sizes called "Large"/);
  assert.match(problem, /two identical buttons at the till/);
});

test('a name is the same name whatever the case or spacing', () => {
  // "Large" and "large " are the same size to everybody except a database.
  assert.deepEqual(duplicateSizeLabels([{ label: 'Large' }, { label: '  large ' }]), ['Large']);
});

test('sizes with different names are fine, and a blank one is not a clash', () => {
  assert.equal(sizeProblem([{ label: 'Large' }, { label: 'Small' }]), null);
  // A row somebody has not filled in yet is not two rows sharing a name.
  assert.equal(sizeProblem([{ label: '' }, { label: '' }]), null);
});

test('retired sizes are explained rather than silently missing', () => {
  /*
    Somebody who retired a size last month and finds no trace of it assumes
    the system lost it, and the next thing they do is add it again — which is
    how a drink ends up with two of everything.
  */
  const words = String(retiredWords(2));
  assert.match(words, /2 older sizes have been retired/);
  assert.match(words, /sales already went through them/);
  assert.match(String(retiredWords(1)), /1 older size has been retired/);
  assert.equal(retiredWords(0), null);
});
