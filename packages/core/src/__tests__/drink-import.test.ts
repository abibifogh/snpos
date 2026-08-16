import test from 'node:test';
import assert from 'node:assert/strict';
import { readDrinkImport, DRINK_HEADINGS, DRINK_TEMPLATE_ROWS } from '../drink-import.ts';

const ctx = (over: Partial<Parameters<typeof readDrinkImport>[1]> = {}) => ({
  categories: [{ $id: 'c1', name: 'Beers' }, { $id: 'c2', name: 'Cocktails' }],
  ingredients: [
    { $id: 'g1', name: 'Gin' },
    { $id: 't1', name: 'Tonic water' },
    { $id: 'l1', name: 'Lime' },
  ],
  existing: [] as { $id: string; name: string }[],
  decimals: 2,
  ...over,
});

const file = (...rows: string[][]) => [DRINK_HEADINGS, ...rows];

test('the shipped template is a file this can actually read', () => {
  // A template that does not survive its own importer is worse than none: the
  // first thing anybody does is download it, fill it in, and upload it back.
  const result = readDrinkImport(file(...DRINK_TEMPLATE_ROWS), ctx());
  assert.deepEqual(result.problems, []);
  assert.equal(result.drinks.length, 2, 'a beer and a cocktail');
  assert.equal(result.recipeLines, 3);
});

test('rows sharing a name become one drink with a recipe', () => {
  /**
   * The shape that makes this worth doing at all. A cocktail without its
   * recipe still sells, still takes money, and takes nothing off the shelf —
   * so a bar that imported its list and not its recipes would count perfectly
   * and find a variance every night, with the gin apparently pouring itself.
   */
  const result = readDrinkImport(file(
    ['Gin and tonic', 'Cocktails', '35.00', '', '2', 'Gin', '0.05', '5', ''],
    ['Gin and tonic', 'Cocktails', '', '', '', 'Tonic water', '1', '', ''],
  ), ctx());

  assert.deepEqual(result.problems, []);
  assert.equal(result.drinks.length, 1);
  const drink = result.drinks[0];
  assert.equal(drink.price, 3500);
  assert.equal(drink.recipe.length, 2);
  assert.equal(drink.recipe[0].qtyPerUnit, 0.05);
  assert.equal(drink.recipe[0].wastageBp, 500, '5% spillage');
  assert.equal(drink.recipe[1].wastageBp, 0, 'blank means none');
});

test('a category that does not exist yet is created, and said so first', () => {
  const result = readDrinkImport(file(
    ['Old Fashioned', 'Classics', '45.00', '', '', 'Gin', '0.05', '', ''],
  ), ctx());
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.newCategories, ['Classics']);
  assert.equal(result.drinks[0].categoryId, '', 'nothing to point at until it is made');

  // One that exists is matched loosely: case and spacing are not what somebody
  // meant to get wrong.
  const known = readDrinkImport(file(
    ['Club Beer', '  beers ', '15.00', '', '', '', '', '', ''],
  ), ctx());
  assert.deepEqual(known.newCategories, []);
  assert.equal(known.drinks[0].categoryId, 'c1');
});

test('an ingredient nobody has set up stops the row, by name', () => {
  const result = readDrinkImport(file(
    ['Negroni', 'Cocktails', '40.00', '', '', 'Campari', '0.05', '', ''],
  ), ctx());
  assert.equal(result.drinks[0].recipe.length, 0);
  assert.match(result.problems[0].message, /"Campari" is not one of your bottles or mixers/);
  assert.equal(result.problems[0].line, 2);
});

test('a recipe line with no quantity is refused rather than silently ignored', () => {
  /**
   * It takes nothing off the shelf, which is the same as not having a recipe
   * at all — and the whole point of importing one is that the pour is
   * accounted for. Failing quietly here is how a bar ends up counting against
   * a cocktail that never deducted anything.
   */
  const result = readDrinkImport(file(
    ['Gin and tonic', 'Cocktails', '35.00', '', '', 'Gin', '', '', ''],
  ), ctx());
  assert.equal(result.drinks[0].recipe.length, 0);
  assert.match(result.problems[0].message, /not how much of it/);
});

test('the same ingredient twice in one drink is a mistake, not a double measure', () => {
  const result = readDrinkImport(file(
    ['Gin and tonic', 'Cocktails', '35.00', '', '', 'Gin', '0.05', '', ''],
    ['Gin and tonic', 'Cocktails', '', '', '', 'Gin', '0.05', '', ''],
  ), ctx());
  assert.equal(result.drinks[0].recipe.length, 1, 'the second is refused, not added');
  assert.match(result.problems[0].message, /lists Gin twice/);
});

test('a drink already on the board is an update, not a duplicate', () => {
  // The second use of this screen is always "we changed the prices".
  const result = readDrinkImport(
    file(['Club Beer', 'Beers', '18.00', '', '', '', '', '', '']),
    ctx({ existing: [{ $id: 'm1', name: 'club beer' }] }),
  );
  assert.equal(result.drinks[0].updates, true, 'matched regardless of case');
  assert.equal(result.drinks[0].price, 1800);
});

test('a drink with no price is refused, because a till cannot sell one', () => {
  const result = readDrinkImport(file(
    ['Mystery', 'Cocktails', '', '', '', 'Gin', '0.05', '', ''],
  ), ctx());
  assert.equal(result.drinks.length, 0);
  assert.match(result.problems[0].message, /has no price/);
});

test('nonsense is named with its line number', () => {
  const result = readDrinkImport(file(
    ['', 'Beers', '15.00', '', '', '', '', '', ''],
    ['Nameless category', '', '15.00', '', '', '', '', '', ''],
    ['Bad price', 'Beers', 'lots', '', '', '', '', '', ''],
    ['Bad wastage', 'Beers', '15.00', '', '', 'Gin', '1', '500', ''],
  ), ctx());
  assert.deepEqual(result.problems.map((p) => p.line), [2, 3, 4, 5]);
  assert.match(result.problems[0].message, /No name/);
  assert.match(result.problems[1].message, /has no category/);
  assert.match(result.problems[2].message, /is not a price/);
  assert.match(result.problems[3].message, /not a percentage/);
});

test('a missing heading stops the whole file rather than half-reading it', () => {
  const result = readDrinkImport([['name', 'price'], ['Gin', '30']], ctx());
  assert.equal(result.drinks.length, 0);
  assert.match(result.problems[0].message, /no "category" column/);
});

test('a blank line in the middle of a spreadsheet is spacing, not a drink', () => {
  const result = readDrinkImport(file(
    ['Club Beer', 'Beers', '15.00', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', ''],
    ['Star', 'Beers', '14.00', '', '', '', '', '', ''],
  ), ctx());
  assert.deepEqual(result.problems, []);
  assert.equal(result.drinks.length, 2);
});
