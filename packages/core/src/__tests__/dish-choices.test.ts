import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPicks, unmetChoice, unmetChoiceWords, needsChoosing } from '../dish-choices.ts';
import type { ChoiceSet } from '../dish-choices.ts';

const group = (over: Partial<{ $id: string; name: string; required: boolean; min_select: number }> = {}) => ({
  $id: 'g1', name: 'Size', required: false, min_select: 0, ...over,
});

test('a dish with nothing to decide is one tap', () => {
  assert.equal(needsChoosing([]), false);
  const optional: ChoiceSet = [{ group: group({ name: 'Extras' }), options: [{ $id: 'o1' }, { $id: 'o2' }] }];
  assert.equal(needsChoosing(optional), false);
});

test('a required choice nobody has answered has to be asked', () => {
  const sized: ChoiceSet = [{ group: group({ required: true }), options: [{ $id: 'o1' }, { $id: 'o2' }] }];
  assert.equal(needsChoosing(sized), true);
  assert.match(String(unmetChoiceWords(sized, {})), /Please choose size/);
});

test('a required choice that already has its usual answer does not', () => {
  /*
    The point of the defaults. Making somebody open a sheet to agree with the
    answer already selected is a tap spent on nothing, and it is most of the
    menu.
  */
  const sized: ChoiceSet = [{
    group: group({ required: true }),
    options: [{ $id: 'o1', default_selected: true }, { $id: 'o2' }],
  }];
  assert.deepEqual(defaultPicks(sized), { g1: ['o1'] });
  assert.equal(needsChoosing(sized), false);
  assert.equal(unmetChoice(sized, defaultPicks(sized)), null);
});

test('"pick two sides" is not broken by picking one', () => {
  /*
    An optional group with a minimum means "if you are having any, have at
    least this many". Untouched is fine. Half-answered is how a ticket reaches
    the pass saying two sides and naming one.
  */
  const sides: ChoiceSet = [{
    group: group({ $id: 'g2', name: 'Sides', required: false, min_select: 2 }),
    options: [{ $id: 'a' }, { $id: 'b' }, { $id: 'c' }],
  }];
  assert.equal(unmetChoice(sides, { g2: [] }), null);
  assert.equal(needsChoosing(sides), false);
  assert.equal(unmetChoice(sides, { g2: ['a'] }), 'Sides');
  assert.match(String(unmetChoiceWords(sides, { g2: ['a'] })), /at least 2 from sides/);
  assert.equal(unmetChoice(sides, { g2: ['a', 'b'] }), null);
});

test('the first thing wrong is the one named, in the order they are shown', () => {
  const both: ChoiceSet = [
    { group: group({ $id: 'g1', name: 'Size', required: true }), options: [{ $id: 'o1' }] },
    { group: group({ $id: 'g2', name: 'Protein', required: true }), options: [{ $id: 'o2' }] },
  ];
  assert.equal(unmetChoice(both, {}), 'Size');
  assert.equal(unmetChoice(both, { g1: ['o1'] }), 'Protein');
  assert.equal(unmetChoice(both, { g1: ['o1'], g2: ['o2'] }), null);
});

test('a dish sold in sizes is always asked about', () => {
  // Where variants exist the item's own price is not what anything sells for,
  // so adding one without asking would add it at a price that is not real.
  assert.equal(needsChoosing([], [{ $id: 'small' }, { $id: 'large' }]), true);
  assert.equal(needsChoosing([], []), false);
});
