import test from 'node:test';
import assert from 'node:assert/strict';
import { relinkPlan, relinkWords, relinkIsEmpty, shelfNameFor } from '../shelf-relink.ts';
import { poursSomething } from '../unpoured.ts';
import { ingredientNameFor } from '../variant-recipes.ts';

const items = [
  { $id: 'club', name: 'Club', module: 'bar' },
  { $id: 'sprite', name: 'Sprite', module: 'bar' },
];

test('a size switched off and added again gets its link pointed at the new one', () => {
  /**
   * The reported fault, in its first shape. Eight large Clubs sold, eight
   * still on the shelf: the link named the Large that was retired, the till
   * sold the Large that replaced it, and nothing anywhere connected the two.
   */
  const plan = relinkPlan(
    [{ $id: 'r1', menu_item_id: 'club', variant_id: 'old-large', ingredient_id: 'club-large' }],
    [
      { $id: 'old-large', menu_item_id: 'club', label: 'Large', active: false },
      { $id: 'new-large', menu_item_id: 'club', label: 'Large', active: true },
    ],
    items,
  );
  assert.deepEqual(plan.repoint.map((r) => [r.recipeId, r.toVariantId]), [['r1', 'new-large']]);
  assert.equal(plan.release.length, 0);
  assert.equal(plan.undecided.length, 0);
  assert.match(relinkWords(plan), /pointed back at the size/);
});

test('a drink whose sizes are all gone gets its one link handed back to the drink', () => {
  /**
   * The reported fault, in its second shape, and the one that reads as
   * nonsense from the screen: "these do not have sizes, yet they are on the
   * list of things that took nothing off a shelf". They had sizes once. The
   * sizes went, the link stayed, and the drink now sells with no size on the
   * line — so the link matches nothing and the bottle never moves.
   */
  const plan = relinkPlan(
    [{ $id: 'r1', menu_item_id: 'sprite', variant_id: 'gone', ingredient_id: 'sprite-bottle' }],
    [],
    items,
  );
  assert.deepEqual(plan.release.map((r) => r.recipeId), ['r1']);
  assert.equal(plan.repoint.length, 0);
  assert.match(relinkWords(plan), /handed back to the drink/);
});

test('and after the repair the sale actually pours, which is the whole point', () => {
  // The check that reports the fault and the repair that ends it must agree,
  // or the screen goes on saying the same thing after a repair that worked.
  const before = [{ menu_item_id: 'sprite', variant_id: 'gone', ingredient_id: 'sprite-bottle', qty_per_unit: 1 }];
  const line = { menu_item_id: 'sprite', qty: 7 };
  assert.equal(poursSomething(line, before), false);

  const plan = relinkPlan(
    [{ $id: 'r1', menu_item_id: 'sprite', variant_id: 'gone', ingredient_id: 'sprite-bottle' }],
    [],
    items,
  );
  const after = before.map((r) => (plan.release.length ? { ...r, variant_id: undefined } : r));
  assert.equal(poursSomething(line, after), true);
});

test('two leftover links and no sizes is asked about, never guessed', () => {
  /*
    Both shelves are real — a small Sprite and a large Sprite were bought and
    stacked apart — and the drink now sells plain. Picking one would pour the
    wrong bottle every night, invisibly, which is worse than the fault.
  */
  const plan = relinkPlan(
    [
      { $id: 'r1', menu_item_id: 'sprite', variant_id: 'gone-a', ingredient_id: 'sprite-small' },
      { $id: 'r2', menu_item_id: 'sprite', variant_id: 'gone-b', ingredient_id: 'sprite-large' },
    ],
    [],
    items,
  );
  assert.equal(plan.release.length, 0);
  assert.equal(plan.repoint.length, 0);
  assert.deepEqual(plan.undecided.map((u) => u.recipeId), ['r1', 'r2']);
  assert.match(plan.undecided[0].why, /only one of them/);
  assert.match(relinkWords(plan), /none of them can be repaired without guessing/);
});

test('a leftover link on a drink that still has sizes is asked about', () => {
  // The live sizes are named differently, so nothing here says which of them
  // the old link was meant for.
  const plan = relinkPlan(
    [{ $id: 'r1', menu_item_id: 'club', variant_id: 'gone', ingredient_id: 'club-large' }],
    [{ $id: 'small', menu_item_id: 'club', label: 'Small' }],
    items,
  );
  assert.equal(plan.repoint.length + plan.release.length, 0);
  assert.match(plan.undecided[0].why, /still has sizes/);
});

test('a leftover link on a drink that already pours is left where it is', () => {
  // Handing it back would give the drink two recipes and pour two shelves for
  // one sale, which is a shortage invented by the repair itself.
  const plan = relinkPlan(
    [
      { $id: 'r1', menu_item_id: 'sprite', variant_id: 'gone', ingredient_id: 'sprite-small' },
      { $id: 'r2', menu_item_id: 'sprite', ingredient_id: 'sprite-bottle' },
    ],
    [],
    items,
  );
  assert.equal(plan.release.length, 0);
  assert.match(plan.undecided[0].why, /already pours something of its own/);
});

test('links pointing at sizes that still exist are not touched', () => {
  const plan = relinkPlan(
    [{ $id: 'r1', menu_item_id: 'club', variant_id: 'large', ingredient_id: 'club-large' }],
    [{ $id: 'large', menu_item_id: 'club', label: 'Large' }],
    items,
  );
  assert.equal(relinkIsEmpty(plan), true);
  assert.match(relinkWords(plan), /Nothing needed changing/);
});

test('a size with no flag on it is live, so its links are left alone', () => {
  // Every size written before the flag existed was being sold.
  const plan = relinkPlan(
    [{ $id: 'r1', menu_item_id: 'club', variant_id: 'large', ingredient_id: 'club-large' }],
    [{ $id: 'large', menu_item_id: 'club', label: 'Large' }],
    items,
  );
  assert.equal(relinkIsEmpty(plan), true);
});

test("an add-on's link is never a leftover, because it names no size", () => {
  const plan = relinkPlan(
    [{ $id: 'r1', menu_item_id: 'club', addon_option_id: 'ice', variant_id: 'gone', ingredient_id: 'ice' }],
    [],
    items,
  );
  assert.equal(relinkIsEmpty(plan), true);
});

test('a size with NO link is joined to the shelf already carrying its name', () => {
  /**
   * The case that repointing cannot reach, and the one that started all of
   * this. Club had two Larges; the link belonged to the one that was deleted,
   * and deleting it took the link with it. The size that actually sold eight
   * bottles has no link at all, so there is nothing to repoint — but the shelf
   * is not missing. It is on the count sheet, called "Club · Large".
   */
  const plan = relinkPlan(
    [],
    [{ $id: 'large', menu_item_id: 'club', label: 'Large' }],
    items,
    [{ $id: 'club-large', name: 'Club · Large', module: 'bar' }],
  );
  assert.deepEqual(
    plan.adopt.map((a) => [a.variantId, a.ingredientId]),
    [['large', 'club-large']],
  );
  assert.match(relinkWords(plan), /joined to the shelf already carrying its name/);
});

test('a RETIRED size is joined too, because its sales still happened', () => {
  /*
    Retiring a size does not retire the shelf and does not unmake the eight
    bottles that left. Skipping retired sizes here would leave the shelf
    overstated for ever, which is the exact complaint this exists to answer.
  */
  const plan = relinkPlan(
    [],
    [{ $id: 'large', menu_item_id: 'club', label: 'Large', active: false }],
    items,
    [{ $id: 'club-large', name: 'Club · Large', module: 'bar' }],
  );
  assert.deepEqual(plan.adopt.map((a) => a.variantId), ['large']);
});

test('a size that already has a link is left exactly as it is', () => {
  const plan = relinkPlan(
    [{ $id: 'r1', menu_item_id: 'club', variant_id: 'large', ingredient_id: 'somewhere-else' }],
    [{ $id: 'large', menu_item_id: 'club', label: 'Large' }],
    items,
    [{ $id: 'club-large', name: 'Club · Large', module: 'bar' }],
  );
  assert.equal(plan.adopt.length, 0);
});

test('no shelf of that name, or two of them, and nothing is joined', () => {
  /*
    A drink whose sizes share the drink's own bottle — a gin's single and
    double — has no "Gin · Double" shelf, and inventing a link to some other
    shelf would pour the wrong bottle every night. Two shelves of one name
    identify neither.
  */
  const sizes = [{ $id: 'large', menu_item_id: 'club', label: 'Large' }];
  assert.equal(relinkPlan([], sizes, items, [{ $id: 'x', name: 'Something else' }]).adopt.length, 0);
  assert.equal(relinkPlan([], sizes, items, [
    { $id: 'a', name: 'Club · Large' },
    { $id: 'b', name: 'club · large' },
  ]).adopt.length, 0);
});

test('a shelf that is switched off, or is the kitchen’s, is not joined to', () => {
  const sizes = [{ $id: 'large', menu_item_id: 'club', label: 'Large' }];
  assert.equal(relinkPlan([], sizes, items, [
    { $id: 'club-large', name: 'Club · Large', module: 'bar', active: false },
  ]).adopt.length, 0);
  assert.equal(relinkPlan([], sizes, items, [
    { $id: 'club-large', name: 'Club · Large', module: 'kitchen' },
  ]).adopt.length, 0);
});

test('a drink that was helped is not also listed as left alone', () => {
  /*
    Club, exactly as reported: a leftover link naming a Large that is gone,
    a live Small that is not it, and the sold Large sitting there with no link
    at all. The leftover cannot be repaired — but the sold size can, and saying
    both at once would be a screen contradicting itself.
  */
  const plan = relinkPlan(
    [{ $id: 'r1', menu_item_id: 'club', variant_id: 'deleted-large', ingredient_id: 'club-large' }],
    [
      { $id: 'small', menu_item_id: 'club', label: 'Small' },
      { $id: 'sold-large', menu_item_id: 'club', label: 'Large', active: false },
    ],
    items,
    [{ $id: 'club-large', name: 'Club · Large', module: 'bar' }],
  );
  assert.deepEqual(plan.adopt.map((a) => a.variantId), ['sold-large']);
  assert.equal(plan.undecided.length, 0);
});

test('shelfNameFor and ingredientNameFor agree on every shape, and are kept that way', () => {
  /**
   * Both files are pure and neither may import the other at runtime, so the
   * rule for naming a size's own shelf is written twice. This is what stops
   * the two drifting: a repair that spells the shelf name differently from
   * the code that CREATED the shelf would match nothing, silently, on exactly
   * the drinks it exists for.
   */
  const shapes: [string, string][] = [
    ['Club', 'Large'],
    ['Club', ''],
    ['', 'Large'],
    ['  Club  ', '  Large  '],
    ['Club Beer Original Lager From The Accra Brewery Company Limited And Its Many Friends', 'Large'],
    ['Short', 'A size name so long that nothing whatever is left over for the drink it belongs to, at all'],
  ];
  for (const [drink, size] of shapes) {
    assert.equal(
      shelfNameFor(drink, size),
      ingredientNameFor(drink, size),
      `disagreed on ${JSON.stringify([drink, size])}`,
    );
  }
});

test('a name is the same name whatever the case or spacing', () => {
  const plan = relinkPlan(
    [{ $id: 'r1', menu_item_id: 'club', variant_id: 'old', ingredient_id: 'club-large' }],
    [
      { $id: 'old', menu_item_id: 'club', label: '  LARGE ', active: false },
      { $id: 'new', menu_item_id: 'club', label: 'Large' },
    ],
    items,
  );
  assert.equal(plan.repoint[0].toVariantId, 'new');
});
