import test from 'node:test';
import assert from 'node:assert/strict';
import { relinkPlan, relinkWords, relinkIsEmpty } from '../shelf-relink.ts';
import { poursSomething } from '../unpoured.ts';

const items = [{ $id: 'club', name: 'Club' }, { $id: 'sprite', name: 'Sprite' }];

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
