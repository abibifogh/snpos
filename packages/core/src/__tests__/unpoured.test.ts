import test from 'node:test';
import assert from 'node:assert/strict';
import {
  poursSomething, soldName, unpouredSales, unpouredWords, unpouredSummary,
} from '../unpoured.ts';
import { soldInShift } from '../bar-count.ts';

const drink = (over: Record<string, unknown> = {}) => ({
  $id: 'club', name: 'Club', module: 'bar', ...over,
});

const sold = (over: Record<string, unknown> = {}) => ({
  menu_item_id: 'club', name_snapshot: 'Club', qty: 8, ...over,
});

test('a size with its own recipe pours, and the drink is left alone', () => {
  const recipes = [{ menu_item_id: 'club', variant_id: 'large', ingredient_id: 'club-large', qty_per_unit: 1 }];
  assert.equal(poursSomething(sold({ variant_id: 'large' }), recipes), true);
});

test('a size with no recipe of its own falls back to the drink', () => {
  /*
    Putting sizes on an existing cocktail must not silently stop it pouring.
    A size with nothing of its own is still the drink.
  */
  const recipes = [{ menu_item_id: 'club', ingredient_id: 'club-bottle', qty_per_unit: 1 }];
  assert.equal(poursSomething(sold({ variant_id: 'large' }), recipes), true);
});

test('a size whose recipe names a size that no longer exists pours NOTHING', () => {
  /**
   * The fault behind eight large Clubs sold and eight still on the shelf. A
   * size switched off and added again is a new size with a new id; the recipe
   * still names the one it replaced. The drink's only recipes belong to sizes,
   * so there is no fallback — and nothing anywhere said so.
   */
  const recipes = [{ menu_item_id: 'club', variant_id: 'old-large', ingredient_id: 'club-large', qty_per_unit: 1 }];
  assert.equal(poursSomething(sold({ variant_id: 'new-large' }), recipes), false);

  const [row] = unpouredSales([sold({ variant_id: 'new-large', variant_label: 'Large' })], recipes, [drink()]);
  assert.equal(row.reason, 'size-has-no-recipe');
  assert.equal(row.qty, 8);
  // And the words name the cause and the fix, because the fix is not obvious.
  assert.match(unpouredWords(row.reason, row.name), /switched off and added again/);
  assert.match(unpouredWords(row.reason, row.name), /Give every size its own shelf/);
});

test('a recipe with no measure on it pours nothing', () => {
  // Nought of something, every time, which moves nothing. Counting it as
  // wired up would be the screen agreeing with a setting that does nothing.
  const recipes = [{ menu_item_id: 'club', ingredient_id: 'club-bottle', qty_per_unit: 0 }];
  assert.equal(poursSomething(sold(), recipes), false);
});

test('a drink not set to the bar is named as that, not as a missing recipe', () => {
  /*
    Two different jobs. One is a setting on the drink; the other is writing a
    recipe. Telling somebody to write a recipe they already have is how a
    warning stops being read.
  */
  const recipes = [{ menu_item_id: 'club', ingredient_id: 'club-bottle', qty_per_unit: 1 }];
  const [row] = unpouredSales([sold()], recipes, [drink({ module: 'kitchen' })]);
  assert.equal(row.reason, 'not-on-the-bar');
  assert.match(unpouredWords(row.reason, row.name), /set to the bar/);
});

test('what pours correctly is not reported at all', () => {
  const recipes = [{ menu_item_id: 'club', ingredient_id: 'club-bottle', qty_per_unit: 1 }];
  assert.deepEqual(unpouredSales([sold()], recipes, [drink()]), []);
});

test('a voided line, and a line of nothing, sold nothing', () => {
  assert.deepEqual(unpouredSales([sold({ status: 'void' })], [], [drink()]), []);
  assert.deepEqual(unpouredSales([sold({ qty: 0 })], [], [drink()]), []);
});

test('the same drink across several orders is one line to go and fix', () => {
  const rows = unpouredSales(
    [sold({ qty: 5, variant_id: 'v' }), sold({ qty: 3, variant_id: 'v' })],
    [],
    [drink()],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 8);
});

test('two sizes of one drink are two lines, because they are two shelves', () => {
  const rows = unpouredSales(
    [
      sold({ qty: 8, variant_id: 'large', variant_label: 'Large' }),
      sold({ qty: 2, variant_id: 'small', variant_label: 'Small' }),
    ],
    [],
    [drink()],
  );
  assert.deepEqual(rows.map((r) => [r.name, r.qty]), [['Club · Large', 8], ['Club · Small', 2]]);
});

test('a size already in the name is not said twice', () => {
  /**
   * A drink somebody named "Club · Large" with a size called "Large" read as
   * "Club · Large · Large" on the sold list. The size is in the name because
   * somebody typed it there, and repeating it is the kind of small wrongness
   * that makes a screen look untrustworthy on the day it reports something
   * true.
   */
  assert.equal(soldName({ name_snapshot: 'Club · Large', variant_label: 'Large' }), 'Club · Large');
  assert.equal(soldName({ name_snapshot: 'Club', variant_label: 'Large' }), 'Club · Large');
  assert.equal(soldName({ name_snapshot: 'Club', variant_label: '' }), 'Club');
  assert.equal(soldName({ name_snapshot: '', variant_label: '' }), 'Something no longer named');
});

test('the summary says it is not a shortage', () => {
  /*
    The most important sentence on the page. A bar reading a difference of
    minus eight assumes eight bottles are missing; the truth is that eight
    were sold and nothing recorded it.
  */
  const rows = unpouredSales([sold({ qty: 8, variant_id: 'v' })], [], [drink()]);
  const words = String(unpouredSummary(rows));
  assert.match(words, /8 drinks sold/);
  assert.match(words, /not a shortage/);
  assert.equal(unpouredSummary([]), null);
});

test('soldInShift and soldName agree on every shape, and are kept that way', () => {
  /**
   * Both files are pure and neither may import the other at runtime, so the
   * rule for building one name out of a drink and a size is written twice.
   * This is what stops the two drifting: a sold list and a fault report that
   * name the same drink differently are two screens somebody has to reconcile
   * by eye.
   */
  const shapes = [
    { name_snapshot: 'Club · Large', variant_label: 'Large' },
    { name_snapshot: 'Club', variant_label: 'Large' },
    { name_snapshot: 'Club', variant_label: '' },
    { name_snapshot: '', variant_label: 'Large' },
    { name_snapshot: 'Large', variant_label: 'Large' },
    { name_snapshot: '  Club  ', variant_label: '  Large  ' },
  ];
  for (const shape of shapes) {
    const [line] = soldInShift([{ ...shape, qty: 1, line_total: 100 }]);
    assert.equal(line.name, soldName(shape), `disagreed on ${JSON.stringify(shape)}`);
  }
});
