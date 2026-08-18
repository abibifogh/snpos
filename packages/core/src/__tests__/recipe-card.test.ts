import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMeasure, pourList, hasRecipe, isMadeToOrder, showsRecipe,
} from '../recipe-card.ts';

const ingredients = [
  { $id: 'rum', name: 'Havana Club 3', unit: 'cl' },
  { $id: 'lime', name: 'Lime juice', unit: 'cl' },
  { $id: 'mint', name: 'Mint', unit: 'leaf' },
  { $id: 'syrup', name: 'Sugar syrup', unit: 'cl' },
];

test('a measure reads the way a bartender would say it', () => {
  assert.equal(formatMeasure(5, 'cl'), '5cl');
  assert.equal(formatMeasure(2.5, 'cl'), '2.5cl');
  assert.equal(formatMeasure(8, 'leaf'), '8 leaves');
  assert.equal(formatMeasure(1, 'leaf'), '1 leaf');
  assert.equal(formatMeasure(2, 'shot'), '2 shots');
  assert.equal(formatMeasure(1, 'shot'), '1 shot');
});

test('arithmetic dust does not reach the bar', () => {
  // Stored quantities come out of sums, so a 5cl pour can arrive as
  // 5.0000001. A measure printed to seven decimal places is one nobody reads.
  assert.equal(formatMeasure(5.0000001, 'cl'), '5cl');
  assert.equal(formatMeasure(2.4999999, 'cl'), '2.5cl');
});

test('an abbreviation is never pluralised', () => {
  // "5cls" reads as a typo and slows somebody down mid-service.
  assert.equal(formatMeasure(5, 'cl'), '5cl');
  assert.equal(formatMeasure(50, 'ml'), '50ml');
});

test('a measure with no unit is just the number', () => {
  assert.equal(formatMeasure(3, undefined), '3');
  assert.equal(formatMeasure(3, '  '), '3');
});

test('a missing quantity reads as zero, not as nothing', () => {
  assert.equal(formatMeasure(NaN, 'cl'), '0cl');
});

test('a cocktail lists what goes in it', () => {
  const recipes = [
    { menu_item_id: 'mojito', ingredient_id: 'rum', qty_per_unit: 5 },
    { menu_item_id: 'mojito', ingredient_id: 'lime', qty_per_unit: 2.5 },
    { menu_item_id: 'mojito', ingredient_id: 'mint', qty_per_unit: 8 },
  ];
  assert.deepEqual(pourList('mojito', recipes, ingredients), [
    { name: 'Havana Club 3', measure: '5cl' },
    { name: 'Lime juice', measure: '2.5cl' },
    { name: 'Mint', measure: '8 leaves' },
  ]);
});

test('the order the recipe was written in is kept', () => {
  // Spirits, then mixers, then garnish is how somebody enters a drink, and
  // that sequence carries meaning for free. Sorting alphabetically scrambles
  // it: "Lime juice, Mint, Havana Club" is not how anybody builds a mojito.
  const recipes = [
    { menu_item_id: 'm', ingredient_id: 'rum', qty_per_unit: 5 },
    { menu_item_id: 'm', ingredient_id: 'syrup', qty_per_unit: 1.5 },
    { menu_item_id: 'm', ingredient_id: 'mint', qty_per_unit: 8 },
  ];
  assert.deepEqual(pourList('m', recipes, ingredients).map((l) => l.name), [
    'Havana Club 3', 'Sugar syrup', 'Mint',
  ]);
});

test('another drink’s recipe stays on the other drink', () => {
  const recipes = [
    { menu_item_id: 'mojito', ingredient_id: 'rum', qty_per_unit: 5 },
    { menu_item_id: 'daiquiri', ingredient_id: 'lime', qty_per_unit: 3 },
  ];
  assert.deepEqual(pourList('mojito', recipes, ingredients).map((l) => l.name), ['Havana Club 3']);
});

test('an extra somebody chose is not part of the drink as it stands', () => {
  // Rows carrying an addon_option_id belong to a chosen extra, not to the
  // recipe on the board.
  const recipes = [
    { menu_item_id: 'mojito', ingredient_id: 'rum', qty_per_unit: 5 },
    { menu_item_id: 'mojito', addon_option_id: 'double', ingredient_id: 'rum', qty_per_unit: 5 },
  ];
  assert.equal(pourList('mojito', recipes, ingredients).length, 1);
});

test('a deleted ingredient says so rather than disappearing', () => {
  // A recipe quietly one item short is worse than one that admits a gap: the
  // bartender pours what they see and the drink is wrong with no warning.
  const recipes = [{ menu_item_id: 'x', ingredient_id: 'gone', qty_per_unit: 2 }];
  const [line] = pourList('x', recipes, ingredients);
  assert.match(line.name, /no longer exists/);
  assert.equal(line.measure, '2');
});

test('the button only appears when there is something to show', () => {
  const recipes = [{ menu_item_id: 'mojito', ingredient_id: 'rum', qty_per_unit: 5 }];
  assert.equal(hasRecipe('mojito', recipes), true);
  assert.equal(hasRecipe('beer', recipes), false);
  assert.equal(hasRecipe('mojito', []), false);
});

test('a drink whose only rows are add-ons has no recipe of its own', () => {
  const recipes = [{ menu_item_id: 'x', addon_option_id: 'shot', ingredient_id: 'rum', qty_per_unit: 5 }];
  assert.equal(hasRecipe('x', recipes), false);
});

/* ------------------------------------------- which drinks are worth a look */

test('cocktails and spirits are made, beers are handed over', () => {
  // Nearly everything behind a bar has a recipe, because that is how stock
  // comes off: a bottled beer's is one bottle of itself. A question mark on
  // every tile is one nobody reads.
  assert.equal(isMadeToOrder('Cocktails'), true);
  assert.equal(isMadeToOrder('Spirits'), true);
  assert.equal(isMadeToOrder('Beers'), false);
  assert.equal(isMadeToOrder('Soft drinks'), false);
  assert.equal(isMadeToOrder('Bottles & mixers'), false);
});

test('the shop’s own spelling still works', () => {
  assert.equal(isMadeToOrder('cocktail'), true);
  assert.equal(isMadeToOrder('House Cocktails'), true);
  assert.equal(isMadeToOrder('SPIRITS & LIQUEURS'), true);
  assert.equal(isMadeToOrder('Mixed drinks'), true);
});

test('no category at all is not made to order', () => {
  assert.equal(isMadeToOrder(undefined), false);
  assert.equal(isMadeToOrder(''), false);
});

test('both things have to be true for the button to appear', () => {
  const recipes = [{ menu_item_id: 'mojito', ingredient_id: 'rum', qty_per_unit: 5 }];
  // A cocktail with a recipe: yes.
  assert.equal(showsRecipe('mojito', recipes, 'Cocktails'), true);
  // A beer with a recipe, which is how its stock comes off: no.
  assert.equal(showsRecipe('mojito', recipes, 'Beers'), false);
  // A cocktail nobody has written a recipe for yet: no, there is nothing to show.
  assert.equal(showsRecipe('daiquiri', recipes, 'Cocktails'), false);
});
