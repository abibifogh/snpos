import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIETARY_TAGS, isDietaryTag, dietaryLabels, dietarySummary, toggleDietaryTag,
} from '../dietary.ts';

test('the words come out in the list order, whatever order they were ticked in', () => {
  /*
    A guest scanning a menu for "vegan" wants it in the same place on every
    dish. Ticking order is whatever the admin's hand did that afternoon.
  */
  const labels = dietaryLabels(['gluten_free', 'vegan', 'vegetarian']).map((t) => t.label);
  assert.deepEqual(labels, ['Vegetarian', 'Vegan', 'Gluten free']);
  assert.equal(dietarySummary(['gluten_free', 'vegan']), 'Vegan · Gluten free');
});

test('a dish with nothing said about it says nothing', () => {
  assert.deepEqual(dietaryLabels(undefined), []);
  assert.deepEqual(dietaryLabels([]), []);
  assert.deepEqual(dietaryLabels(['', '  ']), []);
  assert.equal(dietarySummary(null), '');
});

test('a tag the list does not know is shown rather than dropped', () => {
  // Written about the dish somewhere else. Losing it because the word is not
  // one of ours would be the menu quietly saying less than the database does.
  const [tag] = dietaryLabels(['low_sugar']);
  assert.deepEqual([tag.key, tag.label], ['low_sugar', 'Low sugar']);
  assert.equal(isDietaryTag('low_sugar'), false);
  assert.equal(isDietaryTag('vegan'), true);
});

test('warnings are told apart from reassurances', () => {
  // "Contains nuts" says stay away; "vegan" says come in. The menu must not
  // colour them the same.
  const caution = DIETARY_TAGS.filter((t) => t.caution).map((t) => t.key);
  assert.deepEqual(caution, ['contains_nuts', 'contains_shellfish', 'spicy']);
  assert.equal(DIETARY_TAGS.find((t) => t.key === 'vegan')?.caution, undefined);
});

test('ticking and unticking', () => {
  assert.deepEqual(toggleDietaryTag([], 'vegan'), ['vegan']);
  assert.deepEqual(toggleDietaryTag(['vegan'], 'vegan'), []);
  assert.deepEqual(toggleDietaryTag(undefined, 'halal'), ['halal']);
  // Saved in the list's order, so two admins ticking the same boxes in a
  // different order produce the same row.
  assert.deepEqual(toggleDietaryTag(['gluten_free'], 'vegetarian'), ['vegetarian', 'gluten_free']);
});

test('a dish cannot be nut free and contain nuts at once', () => {
  assert.deepEqual(toggleDietaryTag(['nut_free'], 'contains_nuts'), ['contains_nuts']);
  assert.deepEqual(toggleDietaryTag(['contains_nuts', 'vegan'], 'nut_free'), ['vegan', 'nut_free']);
});

test('a tag from elsewhere survives a tick', () => {
  assert.deepEqual(toggleDietaryTag(['low_sugar'], 'vegan'), ['vegan', 'low_sugar']);
});
