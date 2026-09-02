import test from 'node:test';
import assert from 'node:assert/strict';
import { pourState, pourLabel, pourWords, unexplainedByWiring, drinksToMoveToBar } from '../pour-check.ts';

const drink = (over: Record<string, unknown> = {}) => ({
  $id: 'm1', name: 'Smirnoff Ice', module: 'bar', active: true, ...over,
});

test('a drink on the bar that names the bottle is pouring', () => {
  const state = pourState('ing1', [{ menu_item_id: 'm1', ingredient_id: 'ing1', qty_per_unit: 1 }], [drink()]);
  assert.equal(state, 'pours');
  // Nothing is said when there is nothing wrong. A badge on every row is a
  // badge nobody reads.
  assert.equal(pourLabel(state), null);
  assert.equal(pourWords(state, 'Smirnoff Ice'), null);
});

test('a bottle nothing on the menu uses never moves, and says so', () => {
  /**
   * The quiet failure this exists for. The sale is recorded, the money is
   * right, and the shelf is never touched — so the count reports the whole
   * night's sales as a shortage, every night, and it looks exactly like theft.
   */
  const state = pourState('ing1', [], [drink()]);
  assert.equal(state, 'nothing-sells-it');
  assert.match(String(pourWords(state, 'Lemonade')), /Nothing on the menu is set to use Lemonade/);
  // And it ends with the thing to go and do.
  assert.match(String(pourWords(state, 'Lemonade')), /Drinks & cocktails/);
});

test('a recipe with no measure on it is no recipe at all', () => {
  // Nought of something is poured every time, which moves nothing. Counting it
  // as wired up would be the screen agreeing with a setting that does nothing.
  const state = pourState('ing1', [{ menu_item_id: 'm1', ingredient_id: 'ing1', qty_per_unit: 0 }], [drink()]);
  assert.equal(state, 'nothing-sells-it');
});

test('a drink not set to the bar is skipped by the pour, and is its own answer', () => {
  /*
    Separated from "nothing sells it" because the fix is different and takes
    ten seconds: the recipe is already written, the drink simply is not on the
    bar's side of the business. Usually a drink added before the bar existed.
  */
  const rows = [{ menu_item_id: 'm1', ingredient_id: 'ing1', qty_per_unit: 1 }];
  assert.equal(pourState('ing1', rows, [drink({ module: 'kitchen' })]), 'not-on-the-bar');
  // Absent is not "bar". It has always meant the kitchen, and the server that
  // does the pouring checks for the word itself.
  assert.equal(pourState('ing1', rows, [drink({ module: undefined })]), 'not-on-the-bar');
  assert.match(String(pourLabel('not-on-the-bar')), /Not set to the bar/);
});

test('one live drink pouring it is enough', () => {
  /*
    The question is whether the shelf moves at all, not whether every route to
    it is wired up. A tonic poured by one cocktail and named by a retired one
    is being deducted.
  */
  const rows = [
    { menu_item_id: 'old', ingredient_id: 'ing1', qty_per_unit: 1 },
    { menu_item_id: 'm1', ingredient_id: 'ing1', qty_per_unit: 1 },
  ];
  const items = [drink({ $id: 'old', module: 'kitchen' }), drink()];
  assert.equal(pourState('ing1', rows, items), 'pours');
});

test('a retired drink does not count as pouring', () => {
  // Nothing can be rung up, so nothing can come off. Treating it as wired up
  // would hide the very shelf that has quietly stopped being deducted.
  const rows = [{ menu_item_id: 'm1', ingredient_id: 'ing1', qty_per_unit: 1 }];
  assert.equal(pourState('ing1', rows, [drink({ active: false })]), 'not-on-the-bar');
});

test('an add-on that pours counts on its own', () => {
  // It pours through whatever dish it was added to, so there is no single menu
  // item to look up, and requiring one would report a live shelf as dead.
  const rows = [{ addon_option_id: 'a1', ingredient_id: 'ing1', qty_per_unit: 1 }];
  assert.equal(pourState('ing1', rows, []), 'pours');
});

test('how much of a frightening total is only wiring', () => {
  /**
   * The number worth putting at the top of the sheet. A count reporting a big
   * shortage is alarming; the same count saying most of it is drinks nobody
   * finished setting up is a job, not an incident.
   */
  const rows = [
    // Dead: 12 short at 500 each.
    { ingredientId: 'dead', expected: 12, countedText: '0', unitCost: 500 },
    // Live: a real 2 short, which must NOT be explained away.
    { ingredientId: 'live', expected: 10, countedText: '8', unitCost: 500 },
    // Dead but not counted at all, so it says nothing either way.
    { ingredientId: 'dead', expected: 5, countedText: '', unitCost: 500 },
    // Dead and OVER, which is not a shortage and is not counted as one.
    { ingredientId: 'dead', expected: 3, countedText: '4', unitCost: 500 },
  ];
  const state = (id: string) => (id === 'live' ? 'pours' as const : 'nothing-sells-it' as const);
  assert.deepEqual(unexplainedByWiring(rows, state), { lines: 1, value: 6000 });
});

test('the drinks to move to the bar are exactly the ones the badge is about', () => {
  /**
   * The fix should be one press. So this names the rows: drinks that use the
   * bottle, are still sold, and are not on the bar's side — and nothing else,
   * because a "fix" that also moved a kitchen dish would be a new fault.
   */
  const rows = [
    { menu_item_id: 'gt', ingredient_id: 'tonic', qty_per_unit: 1 },
    { menu_item_id: 'old', ingredient_id: 'tonic', qty_per_unit: 1 },
    { menu_item_id: 'fine', ingredient_id: 'tonic', qty_per_unit: 1 },
    { menu_item_id: 'dish', ingredient_id: 'salt', qty_per_unit: 1 },
  ];
  const items = [
    drink({ $id: 'gt', name: 'G&T', module: 'kitchen' }),
    drink({ $id: 'old', name: 'Retired', module: 'kitchen', active: false }),
    drink({ $id: 'fine', name: 'Already bar', module: 'bar' }),
    drink({ $id: 'dish', name: 'Chips', module: 'kitchen' }),
  ];
  assert.deepEqual(drinksToMoveToBar('tonic', rows, items).map((i) => i.$id), ['gt']);
});
