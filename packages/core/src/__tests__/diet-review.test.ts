import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewDish, reviewAgreement, reviewOptions, reviewMenu, reviewSummary, dietsClaimed,
} from '../dietary.ts';

const dish = (name: string, tags: string[] = [], $id = name) => ({ $id, name, tags });

test('two things that cannot both be true of one plate', () => {
  const found = reviewDish(dish('Satay wrap', ['nut_free', 'contains_nuts']));
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'wrong');
  assert.match(found[0].says, /both nut free and contains nuts/);

  // Shellfish is not vegetarian, whatever else is true of it. Two findings
  // here, not one: the claim is also carrying pescatarian with it, tested
  // below — so the contradiction is looked for rather than counted.
  const prawn = reviewDish(dish('Prawn salad', ['vegetarian', 'pescatarian', 'contains_shellfish']));
  assert.deepEqual(prawn.map((f) => f.kind), ['contradiction']);
  // And shellfish is perfectly ordinary on a dish that claims no diet it rules out.
  assert.deepEqual(reviewDish(dish('Prawn salad', ['pescatarian', 'contains_shellfish'])), []);
});

test('a claim that carries another with it', () => {
  /*
    These are claims about who a dish SUITS, not about what is in it. A vegan
    dish suits a vegetarian and a pescatarian, because both eat everything a
    vegan eats and more. Marked vegan alone it is not wrong about the food — it
    is missing from the vegetarian filter, so the guests who need it never see
    it.
  */
  const found = reviewDish(dish('Veggie wrap', ['vegan', 'nut_free']));
  const said = found.map((f) => f.says).join(' ');
  assert.match(said, /vegan but not vegetarian/i);
  assert.match(said, /vegan but not pescatarian/i);
  assert.match(said, /vegan but not dairy free/i);
  assert.equal(found.every((f) => f.severity === 'gap'), true);

  // Fully marked, nothing to say.
  assert.deepEqual(
    reviewDish(dish('Veggie wrap', ['vegan', 'vegetarian', 'pescatarian', 'dairy_free', 'nut_free'])),
    [],
  );
  // Vegetarian carries pescatarian and nothing else.
  assert.equal(reviewDish(dish('Cheese toastie', ['vegetarian', 'pescatarian'])).length, 0);
  assert.equal(reviewDish(dish('Cheese toastie', ['vegetarian'])).length, 1);
});

test('a dish with nothing said about it is a dish a party will not risk', () => {
  const found = reviewDish(dish('Mystery stew', []));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'untagged');
});

test('the same dish tagged two ways is whichever one they happened to tap', () => {
  const found = reviewAgreement([
    dish('Fries', ['vegan', 'gluten_free'], 'a'),
    dish('Fries', ['vegan'], 'b'),
    dish('Jollof', ['vegan'], 'c'),
  ]);
  // Both rows are named, because either could be the one that is wrong.
  assert.deepEqual(found.map((f) => f.itemId), ['a', 'b']);
  assert.equal(found[0].severity, 'wrong');

  // The same dish twice with the same tags is a deliberate listing, not a fault.
  assert.deepEqual(reviewAgreement([dish('Fries', ['vegan'], 'a'), dish('Fries', ['vegan'], 'b')]), []);
});

test('a choice nobody has judged leaves the dish claiming what it no longer is', () => {
  /*
    The hardest of these to see by reading the menu: the dish is correctly
    tagged, the option is correctly priced, and the fault exists only once
    somebody ticks the box. An unjudged option takes nothing away by design, so
    a vegan bowl with unjudged cheese on it still says vegan.
  */
  const bowl = dish('Vegan bowl', ['vegan', 'vegetarian', 'pescatarian', 'dairy_free']);
  const found = reviewOptions([bowl], () => [{ name: 'Extra cheese' }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'option-unassessed');
  assert.equal(found[0].severity, 'wrong');
  assert.match(found[0].says, /Extra cheese/);
});

test('a choice that is judged and does strip is listed to be checked, not called wrong', () => {
  const bowl = dish('Vegan bowl', ['vegan', 'vegetarian', 'pescatarian', 'dairy_free']);
  const cheese = { name: 'Extra cheese', tags: ['vegetarian', 'pescatarian'] };
  const found = reviewOptions([bowl], () => [cheese]);
  assert.equal(found[0].kind, 'option-strips');
  assert.equal(found[0].severity, 'gap');

  // A choice that meets everything the dish claims takes nothing away.
  const salad = { name: 'Side salad', tags: ['vegan', 'vegetarian', 'pescatarian', 'dairy_free'] };
  assert.deepEqual(reviewOptions([bowl], () => [salad]), []);
  // Nor does something that is not food.
  assert.deepEqual(reviewOptions([bowl], () => [{ name: 'Extra napkin', diet_neutral: true }]), []);
  // And a dish claiming nothing has nothing to lose.
  assert.deepEqual(reviewOptions([dish('Plain', [])], () => [{ name: 'Extra cheese' }]), []);
});

test('the whole review reads worst first', () => {
  const all = reviewMenu([
    dish('Zebra cake', ['vegan'], 'z'),
    dish('Apple pie', ['nut_free', 'contains_nuts'], 'a'),
  ]);
  assert.equal(all[0].severity, 'wrong');
  assert.equal(all[0].dish, 'Apple pie');
});

test('the headline counts what was checked as well as what was found', () => {
  assert.match(reviewSummary([], 12), /All 12 dishes checked/);
  assert.equal(reviewSummary([], 0), 'No dishes to check.');
  const found = reviewMenu([dish('Apple pie', ['nut_free', 'contains_nuts']), dish('Zebra', ['vegan'])]);
  assert.match(reviewSummary(found, 2), /2 dishes checked: 1 to put right, 3 worth a look/);
});

test('what the menu claims, and how often, in the list’s own order', () => {
  const claimed = dietsClaimed([dish('a', ['vegan', 'nut_free']), dish('b', ['nut_free'])]);
  assert.deepEqual(claimed, [
    { key: 'vegan', label: 'Vegan', count: 1 },
    { key: 'nut_free', label: 'Nut free', count: 2 },
  ]);
});
