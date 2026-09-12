import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIETARY_TAGS, isDietaryTag, dietaryLabels, dietarySummary, toggleDietaryTag, omissionProblem, tagsWithOptions, dietAssessed, dietLostWords, dietUnknownWords,
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

test('a choice can only take a diet away, never grant one', () => {
  /*
    The whole point. A vegan bowl with cheese on it is not a vegan bowl, and
    the menu would have gone on saying vegan the whole way to the pass.
  */
  const bowl = ['vegan', 'vegetarian', 'gluten_free', 'nut_free'];
  const cheese = { name: 'Extra cheese', tags: ['vegetarian', 'gluten_free', 'nut_free'] };

  const got = tagsWithOptions(bowl, [cheese]);
  assert.equal(got.tags.includes('vegan'), false);
  assert.equal(got.tags.includes('vegetarian'), true);
  assert.deepEqual(got.unknown, []);

  // And the other way round is refused: cheese being vegetarian does not make
  // a beef stew vegetarian.
  const stew = tagsWithOptions(['gluten_free'], [cheese]);
  assert.equal(stew.tags.includes('vegetarian'), false);
  assert.deepEqual(stew.tags, ['gluten_free']);
});

test('every chosen option has to agree before a tag survives', () => {
  const dish = ['vegan', 'vegetarian', 'nut_free'];
  const salad = { name: 'Side salad', tags: ['vegan', 'vegetarian', 'nut_free'] };
  const satay = { name: 'Satay sauce', tags: ['vegan', 'vegetarian', 'contains_nuts'] };

  assert.deepEqual(tagsWithOptions(dish, [salad]).tags, ['vegetarian', 'vegan', 'nut_free']);
  // Nut free cannot survive the satay, and the caution it carries comes with it.
  const both = tagsWithOptions(dish, [salad, satay]).tags;
  assert.equal(both.includes('nut_free'), false);
  assert.equal(both.includes('contains_nuts'), true);
  assert.equal(both.includes('vegan'), true);
});

test('a choice that is not food changes nothing', () => {
  /*
    "Extra napkin" and "well done" have no dietary opinion. Ticking every box
    on one would be a lie by another route; leaving them all blank would strip
    the dish of everything it is.
  */
  const dish = ['vegan', 'gluten_free'];
  const napkin = { name: 'Extra napkin', diet_neutral: true };
  assert.deepEqual(tagsWithOptions(dish, [napkin]).tags, ['vegan', 'gluten_free']);
  assert.deepEqual(tagsWithOptions(dish, [napkin]).unknown, []);
  assert.equal(dietAssessed(napkin), true);
});

test('an option nobody has judged strips nothing, and says so', () => {
  /*
    Every option in an existing menu is in this state. Treating "not assessed"
    as "meets nothing" would empty every dish of every claim the first time a
    guest ticked anything; guessing "safe" would risk somebody's health. So it
    is left alone and reported.
  */
  const dish = ['vegan', 'gluten_free'];
  const mystery = { name: 'Extra sauce' };
  const got = tagsWithOptions(dish, [mystery]);
  assert.deepEqual(got.tags, ['vegan', 'gluten_free']);
  assert.deepEqual(got.unknown, ['Extra sauce']);
  assert.equal(dietAssessed(mystery), false);
  assert.match(dietUnknownWords(got.unknown), /Extra sauce is suitable for|not recorded what Extra sauce/);
});

test('a caution on its own is not an assessment', () => {
  // "Extra chilli" ticked only as spicy has not been judged for any diet, and
  // stripping every diet off the dish because of it would be wrong.
  const chilli = { name: 'Extra chilli', tags: ['spicy'] };
  assert.equal(dietAssessed(chilli), false);
  const got = tagsWithOptions(['vegan'], [chilli]);
  assert.deepEqual(got.tags, ['vegan']);
  assert.deepEqual(got.unknown, ['Extra chilli']);
});

test('what the choice cost is said in the guest’s words', () => {
  assert.equal(dietLostWords(['vegan', 'vegetarian'], ['vegan', 'vegetarian']), '');
  assert.match(dietLostWords(['vegan', 'vegetarian'], ['vegetarian']), /no longer vegan/);
  assert.match(dietLostWords(['vegan', 'nut_free'], []), /no longer vegan or nut free/);
  // A caution appearing is not a loss and is not announced as one.
  assert.equal(dietLostWords(['vegan'], ['vegan', 'contains_nuts']), '');
  assert.equal(dietUnknownWords([]), '');
});

test('a half-filled omission is refused rather than dropped in silence', () => {
  /*
    serialiseOmissions drops a row with no name and has to — a switch labelled
    "Leave out ." is worse than no switch. Dropping it silently is how somebody
    ticks "makes it vegetarian", saves, watches the form close happily, and
    finds nothing changed. They then report that the feature does not work,
    which from where they are standing is exactly what happened.
  */
  assert.equal(omissionProblem([]), null);
  assert.equal(omissionProblem([{ key: 'a', name: 'momoni', earns: ['vegetarian'] }]), null);

  assert.match(
    String(omissionProblem([{ key: 'a', name: '  ', earns: ['vegetarian'] }])),
    /Say what can be left out to make this vegetarian/,
  );
  assert.match(
    String(omissionProblem([{ key: 'a', name: '', earns: [] }])),
    /has no name/,
  );
  // Named, but it makes the dish nothing, so the switch would do nothing.
  assert.match(
    String(omissionProblem([{ key: 'a', name: 'momoni', earns: [] }])),
    /Tick what the dish becomes without momoni/,
  );
});
