import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOmissions, serialiseOmissions, couldBe, tagsWithout, couldBeWords,
  omissionWords, matchesDiet, dietChips,
} from '../dietary.ts';
import type { Omission } from '../dietary.ts';

const momoni: Omission = { key: 'o1', name: 'momoni (salted fish)', earns: ['vegetarian'], ingredientId: 'ing-momoni' };
const egg: Omission = { key: 'o2', name: 'boiled egg', earns: ['vegan'] };
const fish: Omission = { key: 'o3', name: 'the fish', earns: ['vegetarian', 'vegan'] };

test('a dish says what it could be, not what it already is', () => {
  assert.deepEqual(couldBe([], [momoni]), ['vegetarian']);
  // Already vegetarian, so it does not offer to become vegetarian again.
  assert.deepEqual(couldBe(['vegetarian'], [momoni]), []);
  assert.deepEqual(couldBe(['vegetarian'], [fish]), ['vegan']);
  // In the list's own order, not the order the omissions were written.
  assert.deepEqual(couldBe([], [egg, momoni]), ['vegetarian', 'vegan']);
});

test('a tag is earned only when everything standing in its way is left out', () => {
  const both = [momoni, fish];
  // Two things between this dish and vegetarian; leaving out one is not enough.
  assert.equal(tagsWithout([], both, ['o1']).includes('vegetarian'), false);
  assert.equal(tagsWithout([], both, ['o1', 'o3']).includes('vegetarian'), true);
  // What it already was is kept whatever is chosen.
  assert.equal(tagsWithout(['halal'], both, []).includes('halal'), true);
  assert.equal(tagsWithout(['halal'], both, ['o1', 'o3']).sort().join(','), 'halal,vegan,vegetarian');
});

test('nothing removable means nothing changes', () => {
  assert.deepEqual(couldBe(['vegan'], []), []);
  assert.deepEqual(tagsWithout(['vegan'], [], []), ['vegan']);
  assert.equal(couldBeWords(['vegan'], []), '');
  assert.deepEqual(dietChips([{ tags: [], omissions: [] }]), []);
});

test('the pill reads as a possibility, and never as a warning', () => {
  assert.equal(couldBeWords([], [momoni]), 'Vegetarian on request');
  assert.equal(couldBeWords([], [momoni, egg]), 'Vegetarian or Vegan on request');
  // A caution is not something to offer somebody: nobody asks for it spicy
  // by having something left out.
  assert.equal(couldBeWords([], [{ key: 'x', name: 'chilli', earns: ['spicy'] }]), '');
});

test('the switch says what it does in one line', () => {
  assert.equal(omissionWords(momoni), 'Leave out momoni (salted fish). Makes it vegetarian.');
  // The owner's own words, so "the fish" does not become "the the fish".
  assert.equal(omissionWords(fish), 'Leave out the fish. Makes it vegetarian and vegan.');
  // An omission that earns nothing is still worth offering, and says so plainly.
  assert.equal(omissionWords({ key: 'x', name: 'onions', earns: [] }), 'Leave out onions.');
});

test('a filter finds what a dish is and what it could be, and tells them apart', () => {
  assert.equal(matchesDiet(['vegetarian'], [], 'vegetarian'), 'is');
  assert.equal(matchesDiet([], [momoni], 'vegetarian'), 'could');
  assert.equal(matchesDiet([], [momoni], 'vegan'), null);
  assert.equal(matchesDiet([], [], 'gluten_free'), null);
  // No chip tapped means everything shows.
  assert.equal(matchesDiet([], [], ''), 'is');
});

test('only the diets this menu can actually meet get a chip', () => {
  const chips = dietChips([
    { tags: ['halal'], omissions: [] },
    { tags: [], omissions: [momoni] },
    { tags: ['contains_nuts'], omissions: [] },
  ]);
  // Halal because a dish is, vegetarian because one could be, and nothing for
  // the nuts: a caution is a warning, not something to filter down to.
  assert.deepEqual(chips.map((c) => c.key), ['vegetarian', 'halal']);
});

test('a list of omissions survives being written down and read back', () => {
  const text = serialiseOmissions([momoni, egg]);
  const back = parseOmissions(text);
  assert.equal(back.length, 2);
  assert.equal(back[0].name, 'momoni (salted fish)');
  assert.equal(back[0].ingredientId, 'ing-momoni');
  // The one with no recipe line behind it does not invent one.
  assert.equal(back[1].ingredientId, undefined);
});

test('a blank or broken list is no list, never a crash', () => {
  assert.deepEqual(parseOmissions(undefined), []);
  assert.deepEqual(parseOmissions(''), []);
  assert.deepEqual(parseOmissions('not json'), []);
  assert.deepEqual(parseOmissions('{"not":"an array"}'), []);
  // A row with no name is not an omission anybody could act on.
  assert.deepEqual(parseOmissions('[{"name":"  ","earns":[]}]'), []);
  assert.equal(serialiseOmissions([{ key: 'k', name: '   ', earns: [] }]), '[]');
});
