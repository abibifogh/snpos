import test from 'node:test';
import assert from 'node:assert/strict';
import {
  menuEngineering, whatToActOn, soldAtALoss, quadrantLabel,
  MIN_ITEMS, MIN_PLATES, POPULARITY_RULE_BP,
  type SoldLine, type CostedItem,
} from '../menu-engineering.ts';

/**
 * Somebody will take a dish off the menu because of this report, so the ways
 * it could be quietly wrong matter more than the ways it could be obviously
 * wrong. Three in particular:
 *
 *   an uncosted dish counted as free, which flatters it and drags the
 *   benchmark up so properly costed dishes read as failures;
 *
 *   an unweighted benchmark, which lets one rarely-ordered luxury item put
 *   the line above almost everything on the menu;
 *
 *   list price instead of what was actually taken, which hides exactly the
 *   till overrides this is meant to surface.
 *
 * Each has a test below.
 */

const sold = (menuItemId: string, name: string, qty: number, revenue: number): SoldLine =>
  ({ menuItemId, name, qty, revenue });
const cost = (menuItemId: string, unitCost: number): CostedItem =>
  ({ menuItemId, unitCost, unknown: false });
const noRecipe = (menuItemId: string): CostedItem =>
  ({ menuItemId, unitCost: 0, unknown: true });

/**
 * A menu with one dish in each quadrant, by construction.
 *
 * 100 plates over four dishes. An even share is 25%, so the popularity line
 * sits at 17.5%. Weighted contribution:
 *   (30×1500 + 60×300 + 5×2000 + 5×200) / 100 = 740.
 */
function fourQuadrantMenu() {
  const lines = [
    sold('jollof', 'Jollof rice', 30, 30 * 2500),   // 30% of plates, 1500 each → star
    sold('banku', 'Banku', 60, 60 * 1000),          // 60% of plates, 300 each  → plough
    sold('steak', 'Steak', 5, 5 * 3000),            // 5% of plates, 2000 each  → puzzle
    sold('salad', 'Side salad', 5, 5 * 600),        // 5% of plates, 200 each   → dog
  ];
  const costs = [cost('jollof', 1000), cost('banku', 700), cost('steak', 1000), cost('salad', 400)];
  return { lines, costs };
}

test('each dish lands in the quadrant its two numbers put it in', () => {
  const { lines, costs } = fourQuadrantMenu();
  const a = menuEngineering(lines, costs);

  assert.equal(a.tooThin, null);
  const by = new Map(a.rows.map((r) => [r.menuItemId, r]));
  assert.equal(by.get('jollof')?.quadrant, 'star');
  assert.equal(by.get('banku')?.quadrant, 'plough');
  assert.equal(by.get('steak')?.quadrant, 'puzzle');
  assert.equal(by.get('salad')?.quadrant, 'dog');
});

test('the benchmark is the average plate, not the average dish', () => {
  const { lines, costs } = fourQuadrantMenu();
  const a = menuEngineering(lines, costs);

  // Weighted: total contribution 74,000 over 100 plates.
  assert.equal(a.benchmarks?.contribution, 740);
  // The unweighted mean of the four dishes would be (1500+300+2000+200)/4 = 1000,
  // which is a different and worse answer — it lets the five-plate steak pull
  // the line up past the dish carrying the menu.
  assert.notEqual(a.benchmarks?.contribution, 1000);
});

test('one rare luxury dish cannot move the line the rest are judged against', () => {
  const { lines, costs } = fourQuadrantMenu();
  const without = menuEngineering(lines, costs);
  const withLobster = menuEngineering(
    [...lines, sold('lobster', 'Lobster', 1, 20_000)],
    [...costs, cost('lobster', 2_000)],
  );

  // One plate contributing 18,000 arrives on a menu of 100 plates. Asserted as
  // a comparison rather than against a threshold I picked: the claim being
  // made is that weighting is *less* distortable, and the honest way to show
  // that is to work out what the unweighted answer would have done.
  const unweighted = (a: ReturnType<typeof menuEngineering>) =>
    a.rows.reduce((t, r) => t + r.contribution, 0) / a.rows.length;

  const weightedMove = (withLobster.benchmarks!.contribution - without.benchmarks!.contribution)
    / without.benchmarks!.contribution;
  const unweightedMove = (unweighted(withLobster) - unweighted(without)) / unweighted(without);

  assert.ok(unweightedMove > 3, `an unweighted line would have moved ${(unweightedMove * 100).toFixed(0)}%`);
  assert.ok(
    weightedMove < unweightedMove / 10,
    `weighted moved ${(weightedMove * 100).toFixed(0)}%, unweighted ${(unweightedMove * 100).toFixed(0)}%`,
  );

  // And the dish actually carrying the menu is still a star.
  assert.equal(withLobster.rows.find((r) => r.menuItemId === 'jollof')?.quadrant, 'star');
  // Under an unweighted line of 4,400 it would not have been.
  assert.ok(unweighted(withLobster) > withLobster.rows.find((r) => r.menuItemId === 'jollof')!.contribution);
});

test('a dish with no recipe is never classified, and never counted as free', () => {
  const { lines, costs } = fourQuadrantMenu();
  const a = menuEngineering(
    [...lines, sold('mystery', 'Chef special', 50, 50 * 4000)],
    [...costs, noRecipe('mystery')],
  );

  assert.equal(a.rows.find((r) => r.menuItemId === 'mystery'), undefined, 'it must not be in the grid');
  assert.equal(a.uncosted.rows[0]?.menuItemId, 'mystery');
  assert.equal(a.uncosted.rows[0]?.quadrant, null);

  // The decisive part: costing it at zero would have made it the most
  // profitable thing on the menu and lifted the benchmark for everyone else.
  const clean = menuEngineering(lines, costs);
  assert.equal(a.benchmarks?.contribution, clean.benchmarks?.contribution);
  assert.equal(a.rows.find((r) => r.menuItemId === 'banku')?.quadrant, 'plough');
});

test('how much of the takings is uncosted is reported, because it limits everything else', () => {
  const { lines, costs } = fourQuadrantMenu();
  const mystery = sold('mystery', 'Chef special', 50, 200_000);
  const a = menuEngineering([...lines, mystery], [...costs, noRecipe('mystery')]);

  // Derived from the fixture rather than written out, so editing the fixture
  // cannot leave a stale number here that still passes for the wrong reason.
  const everything = [...lines, mystery].reduce((t, x) => t + x.revenue, 0);
  assert.equal(a.uncosted.revenue, 200_000);
  assert.equal(a.uncosted.revenueBp, Math.round((200_000 / everything) * 10_000));
  assert.ok(a.uncosted.revenueBp > 5_000, 'over half the takings here are uncosted');
});

test('what was actually taken is used, not the list price', () => {
  // Sixty plates that should have made 60 × 2500, discounted at the till to
  // 60 × 1200. The dish is not what the menu says it is.
  const a = menuEngineering(
    [sold('a', 'A', 60, 60 * 1200), sold('b', 'B', 30, 30 * 2000),
      sold('c', 'C', 30, 30 * 2000), sold('d', 'D', 30, 30 * 2000)],
    [cost('a', 1000), cost('b', 800), cost('c', 800), cost('d', 800)],
  );
  const row = a.rows.find((r) => r.menuItemId === 'a')!;
  assert.equal(row.unitPrice, 1200, 'the realised price, not 2500');
  assert.equal(row.contribution, 200);
  assert.equal(row.quadrant, 'plough', 'popular and thin — which is only visible at the realised price');
});

test('a dish sold below cost is reported as a loss, not as a small margin', () => {
  const a = menuEngineering(
    [sold('a', 'Loss leader', 40, 40 * 500), sold('b', 'B', 30, 30 * 2000),
      sold('c', 'C', 30, 30 * 2000), sold('d', 'D', 30, 30 * 2000)],
    [cost('a', 900), cost('b', 800), cost('c', 800), cost('d', 800)],
  );
  const losses = soldAtALoss(a);
  assert.equal(losses.length, 1);
  assert.equal(losses[0].menuItemId, 'a');
  assert.equal(losses[0].contribution, -400);
  assert.equal(losses[0].totalContribution, -16_000, 'every plate makes it worse');
  assert.ok(losses[0].marginBp < 0);
});

test('what to act on is ranked by what the fix is worth, not by how bad it looks', () => {
  // `thin` is far below the benchmark and barely sells. `busy` is a little
  // below it and sells constantly. Sorting by margin puts them the wrong way
  // round; sorting by money does not.
  const a = menuEngineering(
    [sold('thin', 'Thin', 4, 4 * 1000), sold('busy', 'Busy', 200, 200 * 2000),
      sold('c', 'C', 40, 40 * 3000), sold('d', 'D', 40, 40 * 3000)],
    [cost('thin', 900), cost('busy', 1200), cost('c', 1000), cost('d', 1000)],
  );
  const act = whatToActOn(a);
  assert.equal(act[0].menuItemId, 'busy', 'the volume dish is the bigger prize');
  assert.ok(act[0].upside > (act.find((r) => r.menuItemId === 'thin')?.upside ?? 0));
  // Sorting the other way would have picked `thin`, which has the worse margin.
  assert.ok(a.rows.find((r) => r.menuItemId === 'thin')!.marginBp
    < a.rows.find((r) => r.menuItemId === 'busy')!.marginBp);
});

test('a dish already at the benchmark has nothing on the table', () => {
  const { lines, costs } = fourQuadrantMenu();
  const a = menuEngineering(lines, costs);
  for (const r of a.rows) {
    if (r.profitable) assert.equal(r.upside, 0, `${r.name} is above the line and should have no upside`);
    else assert.ok(r.upside > 0, `${r.name} is below the line and should have one`);
  }
  assert.equal(a.totals.upside, a.rows.reduce((t, r) => t + r.upside, 0));
});

test('too few dishes is said out loud rather than drawn as a grid', () => {
  const a = menuEngineering(
    [sold('a', 'A', 50, 50_000), sold('b', 'B', 50, 50_000)],
    [cost('a', 100), cost('b', 100)],
  );
  assert.equal(a.benchmarks, null);
  assert.match(a.tooThin ?? '', new RegExp(`at least ${MIN_ITEMS}`));
  assert.ok(a.rows.every((r) => r.quadrant === null), 'nothing may be classified without a benchmark');
});

test('too few plates is said out loud too', () => {
  const a = menuEngineering(
    [sold('a', 'A', 2, 4000), sold('b', 'B', 2, 4000), sold('c', 'C', 2, 4000), sold('d', 'D', 2, 4000)],
    [cost('a', 100), cost('b', 100), cost('c', 100), cost('d', 100)],
  );
  assert.equal(a.benchmarks, null);
  assert.match(a.tooThin ?? '', /plates/);
  assert.ok((a.tooThin ?? '').includes(String(MIN_PLATES)) || /decide the whole grid/.test(a.tooThin ?? ''));
});

test('a menu where nothing is costed says so plainly', () => {
  const a = menuEngineering(
    [sold('a', 'A', 50, 50_000), sold('b', 'B', 50, 50_000)],
    [noRecipe('a'), noRecipe('b')],
  );
  assert.equal(a.benchmarks, null);
  assert.match(a.tooThin ?? '', /no recipe|nothing can be costed/i);
  assert.equal(a.uncosted.revenueBp, 10_000, 'all of it');
});

test('dishes are joined on id, so two things with the same name stay apart', () => {
  const a = menuEngineering(
    [sold('rice-1', 'Rice', 40, 40 * 2000), sold('rice-2', 'Rice', 40, 40 * 800),
      sold('c', 'C', 30, 30 * 2000), sold('d', 'D', 30, 30 * 2000)],
    [cost('rice-1', 500), cost('rice-2', 500), cost('c', 800), cost('d', 800)],
  );
  assert.equal(a.rows.filter((r) => r.name === 'Rice').length, 2);
  assert.equal(a.rows.find((r) => r.menuItemId === 'rice-1')?.contribution, 1500);
  assert.equal(a.rows.find((r) => r.menuItemId === 'rice-2')?.contribution, 300);
});

test('a dish that sold nothing is left out rather than dividing by zero', () => {
  const { lines, costs } = fourQuadrantMenu();
  const a = menuEngineering([...lines, sold('never', 'Never ordered', 0, 0)], [...costs, cost('never', 500)]);
  assert.equal(a.rows.find((r) => r.menuItemId === 'never'), undefined);
  assert.ok(a.rows.every((r) => Number.isFinite(r.unitPrice)));
});

test('the popularity line is 70% of an even share', () => {
  const { lines, costs } = fourQuadrantMenu();
  const a = menuEngineering(lines, costs);
  // Four dishes: an even share is 2500bp, so the line is 1750bp.
  assert.equal(a.benchmarks?.popularityBp, 1_750);
  assert.equal(POPULARITY_RULE_BP, 7_000);

  // And it is a convention, so it can be moved.
  const strict = menuEngineering(lines, costs, { popularityRuleBp: 10_000 });
  assert.equal(strict.benchmarks?.popularityBp, 2_500);
  assert.equal(strict.rows.find((r) => r.menuItemId === 'salad')?.popular, false);
});

test('the quadrant totals add up to the whole menu', () => {
  const { lines, costs } = fourQuadrantMenu();
  const a = menuEngineering(lines, costs);
  const q = Object.values(a.totals.byQuadrant);
  assert.equal(q.reduce((t, x) => t + x.items, 0), a.rows.length);
  assert.equal(q.reduce((t, x) => t + x.plates, 0), a.totals.plates);
  assert.equal(q.reduce((t, x) => t + x.contribution, 0), a.totals.contribution);
});

test('revenue counts every dish, costed or not', () => {
  const { lines, costs } = fourQuadrantMenu();
  const a = menuEngineering([...lines, sold('m', 'M', 10, 10_000)], [...costs, noRecipe('m')]);
  const expected = [...lines, sold('m', 'M', 10, 10_000)].reduce((t, s) => t + s.revenue, 0);
  assert.equal(a.totals.revenue, expected);
});

test('money stays in whole minor units', () => {
  // 7 plates for 1000 is 142.857 each. Nothing downstream may carry a fraction
  // of a pesewa into a total somebody reconciles.
  const a = menuEngineering(
    [sold('a', 'A', 7, 1000), sold('b', 'B', 30, 30 * 2000),
      sold('c', 'C', 30, 30 * 2000), sold('d', 'D', 30, 30 * 2000)],
    [cost('a', 33), cost('b', 800), cost('c', 800), cost('d', 800)],
  );
  for (const r of a.rows) {
    for (const [field, v] of Object.entries({
      unitPrice: r.unitPrice, contribution: r.contribution, totalContribution: r.totalContribution, upside: r.upside,
    })) {
      assert.ok(Number.isInteger(v), `${r.name}.${field} is ${v}`);
    }
  }
  assert.ok(Number.isInteger(a.benchmarks?.contribution));
  assert.ok(Number.isInteger(a.totals.upside));
});

test('an empty period is empty rather than broken', () => {
  const a = menuEngineering([], []);
  assert.equal(a.rows.length, 0);
  assert.equal(a.benchmarks, null);
  assert.equal(a.totals.plates, 0);
  assert.equal(a.totals.revenue, 0);
  assert.equal(a.uncosted.revenueBp, 0, 'no revenue means no share, not a division by zero');
  assert.equal(whatToActOn(a).length, 0);
  assert.equal(soldAtALoss(a).length, 0);
});

test('every quadrant has a label and something to do about it', () => {
  for (const q of ['star', 'plough', 'puzzle', 'dog'] as const) {
    assert.ok(quadrantLabel(q).length > 2);
  }
  assert.equal(quadrantLabel(null), 'Not costed');
});
