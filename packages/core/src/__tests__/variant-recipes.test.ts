import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recipeFor, hasOwnRecipe, ingredientNameFor, OWN_STOCK_QTY,
} from '../variant-recipes.ts';

const rows = [
  { menu_item_id: 'club', ingredient_id: 'club_small', variant_id: 'small', qty_per_unit: 1 },
  { menu_item_id: 'club', ingredient_id: 'club_large', variant_id: 'large', qty_per_unit: 1 },
  { menu_item_id: 'mojito', ingredient_id: 'rum', qty_per_unit: 5 },
  { menu_item_id: 'mojito', ingredient_id: 'mint', qty_per_unit: 8 },
];

test('a size pours its own stock, not the drink’s', () => {
  assert.deepEqual(recipeFor(rows, 'club', 'large').map((r) => r.ingredient_id), ['club_large']);
  assert.deepEqual(recipeFor(rows, 'club', 'small').map((r) => r.ingredient_id), ['club_small']);
});

test('a variant’s rows win outright rather than adding to the drink’s', () => {
  // A large Club is a large Club; it is not a small Club plus something.
  // Taking both would pour the small as well and leave the bar one short
  // every time somebody bought a large.
  const mixed = [
    { menu_item_id: 'club', ingredient_id: 'club_general', qty_per_unit: 1 },
    { menu_item_id: 'club', ingredient_id: 'club_large', variant_id: 'large', qty_per_unit: 1 },
  ];
  assert.deepEqual(recipeFor(mixed, 'club', 'large').map((r) => r.ingredient_id), ['club_large']);
});

test('a size with nothing of its own falls back to the drink’s', () => {
  // So putting sizes on an existing cocktail does not silently stop it
  // depleting anything at all.
  assert.deepEqual(
    recipeFor(rows, 'mojito', 'double').map((r) => r.ingredient_id),
    ['rum', 'mint'],
  );
});

test('a drink rung up with no size gets only the rows tied to no size', () => {
  const mixed = [
    { menu_item_id: 'club', ingredient_id: 'club_general', qty_per_unit: 1 },
    { menu_item_id: 'club', ingredient_id: 'club_large', variant_id: 'large', qty_per_unit: 1 },
  ];
  assert.deepEqual(recipeFor(mixed, 'club').map((r) => r.ingredient_id), ['club_general']);
});

test('another drink’s recipe is never poured', () => {
  assert.deepEqual(recipeFor(rows, 'club').map((r) => r.ingredient_id), []);
  assert.equal(recipeFor(rows, 'nothing', 'large').length, 0);
});

test('an add-on’s ingredients are not part of the drink itself', () => {
  const withAddon = [
    { menu_item_id: 'gin', ingredient_id: 'gin', qty_per_unit: 5 },
    { menu_item_id: 'gin', addon_option_id: 'double', ingredient_id: 'gin', qty_per_unit: 5 },
  ];
  assert.equal(recipeFor(withAddon, 'gin').length, 1);
});

test('whether a size carries its own stock is answerable', () => {
  assert.equal(hasOwnRecipe(rows, 'club', 'large'), true);
  assert.equal(hasOwnRecipe(rows, 'mojito', 'double'), false);
});

test('a stock item is named for the drink and the size together', () => {
  // "Large" alone is not findable on a stock list, and "Club" three times is
  // worse.
  assert.equal(ingredientNameFor('Club Beer', 'Large'), 'Club Beer · Large');
});

test('a long name is trimmed, and the size is what survives', () => {
  // Two rows ending "…" cannot be told apart; two keeping their sizes can.
  const out = ingredientNameFor('A'.repeat(200), 'Large', 20);
  assert.ok(out.length <= 20, out);
  assert.ok(out.endsWith('· Large'), out);
});

test('a size with no name is just the drink', () => {
  assert.equal(ingredientNameFor('Club Beer', ''), 'Club Beer');
  assert.equal(ingredientNameFor('Club Beer', '   '), 'Club Beer');
});

test('one of these uses one of its own', () => {
  assert.equal(OWN_STOCK_QTY, 1);
});
