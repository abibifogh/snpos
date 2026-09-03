/**
 * End to end, against the real code, with an in-memory database.
 *
 * Seeds the bar as it actually is, reads the count sheet, presses the repair,
 * presses the catch-up, and reads the sheet again. Nothing is stubbed except
 * Appwrite itself.
 */
import { __seed, __reset, __all } from './core/client.ts';
import { barCountSheet, relinkShelves, pourMissedSales, unpouredForShift } from './core/stock.ts';

const ok = (label: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  return pass;
};

interface Seed {
  variants: Record<string, unknown>[];
  recipes: Record<string, unknown>[];
  ingredients: Record<string, unknown>[];
  soldVariant?: string;
  locations?: Record<string, unknown>[];
}

async function scenario(name: string, s: Seed) {
  console.log(`\n=== ${name} ===`);
  __reset();

  __seed('stock_locations', s.locations ?? [
    { $id: 'counter', venue_id: 'main', name: 'Bar counter', kind: 'counter', module: 'bar', active: true },
  ]);
  __seed('ingredients', s.ingredients);
  __seed('stock_levels', s.ingredients.map((i: any, n) => ({
    $id: `lvl${n}`, ingredient_id: i.$id, location_id: 'counter', qty: i.current_qty,
  })));
  __seed('menu_items', [{ $id: 'club', venue_id: 'main', name: 'Club', module: 'bar', active: true }]);
  __seed('product_variants', s.variants);
  __seed('recipes', s.recipes);
  __seed('shifts', [{ $id: 'sh1', venue_id: 'main', module: 'bar', status: 'OPEN' }]);
  __seed('orders', [{
    $id: 'o1', venue_id: 'main', shift_id: 'sh1', module: 'bar', status: 'PAID', number: 'ORD1',
  }]);
  __seed('order_items', [{
    $id: 'li1', order_id: 'o1', menu_item_id: 'club', variant_id: s.soldVariant ?? '',
    name_snapshot: 'Club', variant_label: s.soldVariant ? 'Large' : '', qty: 8, line_total: 8000,
  }]);

  const before = await barCountSheet('main');
  const largeBefore = before.find((r) => r.ingredientId === 'club-large');
  ok('sheet before', largeBefore?.expected, 48);

  const un = await unpouredForShift('main', 'sh1', 'bar');
  console.log(`   unpoured: ${JSON.stringify(un.map((u) => [u.name, u.qty, u.reason]))}`);

  const plan = await relinkShelves('main', 'sh1');
  console.log(`   repoint=${plan.repoint.length} release=${plan.release.length} `
    + `adopt=${JSON.stringify(plan.adopt.map((a) => [a.variantId, a.ingredientId]))} `
    + `undecided=${plan.undecided.length}`);

  const run = await pourMissedSales({ venueId: 'main', shiftId: 'sh1', module: 'bar', userId: 'u1' });
  console.log(`   catch-up: ${JSON.stringify(run)}`);

  const after = await barCountSheet('main');
  const largeAfter = after.find((r) => r.ingredientId === 'club-large');
  const pass = ok('sheet after', largeAfter?.expected, 40);

  const un2 = await unpouredForShift('main', 'sh1', 'bar');
  ok('nothing left unpoured', un2.length, 0);
  return pass;
}

const shelves = [
  {
    $id: 'club-large', venue_id: 'main', name: 'Club · Large', module: 'bar', active: true,
    unit: 'bottle', base_unit_cost: 1000, current_qty: 48, count_each_shift: true,
  },
  {
    $id: 'club-small', venue_id: 'main', name: 'Club · Small', module: 'bar', active: true,
    unit: 'bottle', base_unit_cost: 800, current_qty: 12, count_each_shift: true,
  },
];

const results: [string, boolean][] = [];

results.push(['A two Larges, the linked one retired', await scenario(
  'A — two Larges: the link belongs to the retired one, the sale to the other',
  {
    variants: [
      { $id: 'small', menu_item_id: 'club', label: 'Small', active: true },
      { $id: 'largeA', menu_item_id: 'club', label: 'Large', active: false },
      { $id: 'largeB', menu_item_id: 'club', label: 'Large', active: false },
    ],
    recipes: [{
      $id: 'r1', menu_item_id: 'club', variant_id: 'largeA', addon_option_id: '',
      ingredient_id: 'club-large', qty_per_unit: 1, wastage_bp: 0,
    }],
    ingredients: shelves,
    soldVariant: 'largeB',
  },
)]);

results.push(['B no recipe rows at all', await scenario(
  'B — the size that sold has no link, and the drink has none either',
  {
    variants: [
      { $id: 'small', menu_item_id: 'club', label: 'Small', active: true },
      { $id: 'largeB', menu_item_id: 'club', label: 'Large', active: false },
    ],
    recipes: [],
    ingredients: shelves,
    soldVariant: 'largeB',
  },
)]);

results.push(['C the sold size is still live', await scenario(
  'C — the sold size is still live and simply never had a link',
  {
    variants: [
      { $id: 'small', menu_item_id: 'club', label: 'Small', active: true },
      { $id: 'largeB', menu_item_id: 'club', label: 'Large', active: true },
    ],
    recipes: [],
    ingredients: shelves,
    soldVariant: 'largeB',
  },
)]);

results.push(['D the sold size row is GONE from the database', await scenario(
  'D — the size was deleted outright, so the sale names a size that does not exist',
  {
    variants: [{ $id: 'small', menu_item_id: 'club', label: 'Small', active: true }],
    recipes: [],
    ingredients: shelves,
    soldVariant: 'largeB',
  },
)]);

results.push(['E shelf named without the separator', await scenario(
  'E — the shelf is called "Club Large", not "Club · Large"',
  {
    variants: [
      { $id: 'small', menu_item_id: 'club', label: 'Small', active: true },
      { $id: 'largeB', menu_item_id: 'club', label: 'Large', active: false },
    ],
    recipes: [],
    ingredients: [{ ...shelves[0], name: 'Club Large' }, shelves[1]],
    soldVariant: 'largeB',
  },
)]);

/* ------------------------------------------------------ pressing it twice */

console.log('\n=== F — the repair and the catch-up, pressed twice ===');
{
  __reset();
  __seed('stock_locations', [
    { $id: 'counter', venue_id: 'main', name: 'Bar counter', kind: 'counter', module: 'bar', active: true },
  ]);
  __seed('ingredients', shelves);
  __seed('stock_levels', shelves.map((i, n) => ({
    $id: `lvl${n}`, ingredient_id: i.$id, location_id: 'counter', qty: i.current_qty,
  })));
  __seed('menu_items', [{ $id: 'club', venue_id: 'main', name: 'Club', module: 'bar', active: true }]);
  __seed('product_variants', [
    { $id: 'small', menu_item_id: 'club', label: 'Small', active: true },
    { $id: 'largeB', menu_item_id: 'club', label: 'Large', active: false },
  ]);
  __seed('recipes', []);
  __seed('shifts', [{ $id: 'sh1', venue_id: 'main', module: 'bar', status: 'OPEN' }]);
  __seed('orders', [{ $id: 'o1', venue_id: 'main', shift_id: 'sh1', module: 'bar', status: 'PAID' }]);
  __seed('order_items', [{
    $id: 'li1', order_id: 'o1', menu_item_id: 'club', variant_id: 'largeB',
    name_snapshot: 'Club', variant_label: 'Large', qty: 8, line_total: 8000,
  }]);

  for (let n = 1; n <= 3; n += 1) {
    await relinkShelves('main', 'sh1');
    const run = await pourMissedSales({ venueId: 'main', shiftId: 'sh1', module: 'bar', userId: 'u1' });
    const sheet = await barCountSheet('main');
    const large = sheet.find((r) => r.ingredientId === 'club-large');
    console.log(`   press ${n}: poured=${run.poured} lines=${run.lines} sheet=${large?.expected} `
      + `recipes=${__all('recipes').length}`);
  }
  const sheet = await barCountSheet('main');
  results.push(['F pressing it three times still lands on 40', ok(
    'after three presses', sheet.find((r) => r.ingredientId === 'club-large')?.expected, 40,
  )]);
  results.push(['F no duplicate links piled up', ok('recipe rows', __all('recipes').length, 2)]);
}

/* ------------------------------------- a drink whose sizes share one bottle */

console.log('\n=== G — a gin: single and double out of the same bottle ===');
{
  __reset();
  __seed('stock_locations', [
    { $id: 'counter', venue_id: 'main', name: 'Bar counter', kind: 'counter', module: 'bar', active: true },
  ]);
  __seed('ingredients', [{
    $id: 'gin-bottle', venue_id: 'main', name: 'Gin', module: 'bar', active: true,
    unit: 'cl', base_unit_cost: 50, current_qty: 100, count_each_shift: true,
  }]);
  __seed('stock_levels', [{ $id: 'l1', ingredient_id: 'gin-bottle', location_id: 'counter', qty: 100 }]);
  __seed('menu_items', [{ $id: 'gin', venue_id: 'main', name: 'Gin', module: 'bar', active: true }]);
  __seed('product_variants', [
    { $id: 'single', menu_item_id: 'gin', label: 'Single', active: true },
    { $id: 'double', menu_item_id: 'gin', label: 'Double', active: true },
  ]);
  // The drink's own recipe, which every size falls back to. Nothing is broken.
  __seed('recipes', [{
    $id: 'r1', menu_item_id: 'gin', variant_id: '', addon_option_id: '',
    ingredient_id: 'gin-bottle', qty_per_unit: 5, wastage_bp: 0,
  }]);
  __seed('shifts', [{ $id: 'sh1', venue_id: 'main', module: 'bar', status: 'OPEN' }]);
  __seed('orders', [{ $id: 'o1', venue_id: 'main', shift_id: 'sh1', module: 'bar', status: 'PAID' }]);
  __seed('order_items', [{
    $id: 'li1', order_id: 'o1', menu_item_id: 'gin', variant_id: 'double',
    name_snapshot: 'Gin', variant_label: 'Double', qty: 2, line_total: 2000,
  }]);

  const plan = await relinkShelves('main', 'sh1');
  results.push(['G a working drink is left completely alone', ok(
    'nothing planned', [plan.repoint.length, plan.release.length, plan.adopt.length], [0, 0, 0],
  )]);
  await pourMissedSales({ venueId: 'main', shiftId: 'sh1', module: 'bar', userId: 'u1' });
  const sheet = await barCountSheet('main');
  results.push(['G it pours the gin, once, off the gin', ok(
    'gin level', sheet.find((r) => r.ingredientId === 'gin-bottle')?.expected, 90,
  )]);
}

/* --------------------------------- Sprite: a drink whose sizes are all gone */

console.log('\n=== H — Sprite: sizes gone, the link left behind, sold plain ===');
{
  __reset();
  __seed('stock_locations', [
    { $id: 'counter', venue_id: 'main', name: 'Bar counter', kind: 'counter', module: 'bar', active: true },
  ]);
  __seed('ingredients', [{
    $id: 'sprite', venue_id: 'main', name: 'Sprite', module: 'bar', active: true,
    unit: 'bottle', base_unit_cost: 500, current_qty: 30, count_each_shift: true,
  }]);
  __seed('stock_levels', [{ $id: 'l1', ingredient_id: 'sprite', location_id: 'counter', qty: 30 }]);
  __seed('menu_items', [{ $id: 'sp', venue_id: 'main', name: 'Sprite', module: 'bar', active: true }]);
  __seed('product_variants', []);
  __seed('recipes', [{
    $id: 'r1', menu_item_id: 'sp', variant_id: 'long-gone', addon_option_id: '',
    ingredient_id: 'sprite', qty_per_unit: 1, wastage_bp: 0,
  }]);
  __seed('shifts', [{ $id: 'sh1', venue_id: 'main', module: 'bar', status: 'OPEN' }]);
  __seed('orders', [{ $id: 'o1', venue_id: 'main', shift_id: 'sh1', module: 'bar', status: 'PAID' }]);
  __seed('order_items', [{
    $id: 'li1', order_id: 'o1', menu_item_id: 'sp', variant_id: '',
    name_snapshot: 'Sprite', variant_label: '', qty: 7, line_total: 7000,
  }]);

  const un = await unpouredForShift('main', 'sh1', 'bar');
  console.log(`   unpoured: ${JSON.stringify(un.map((u) => [u.name, u.qty, u.reason]))}`);
  const plan = await relinkShelves('main', 'sh1');
  console.log(`   release=${plan.release.length} adopt=${plan.adopt.length}`);
  await pourMissedSales({ venueId: 'main', shiftId: 'sh1', module: 'bar', userId: 'u1' });
  const sheet = await barCountSheet('main');
  results.push(['H Sprite comes down by seven', ok(
    'sprite level', sheet.find((r) => r.ingredientId === 'sprite')?.expected, 23,
  )]);
  results.push(['H and a plain sale now pours by itself', ok(
    'still unpoured', (await unpouredForShift('main', 'sh1', 'bar')).length, 0,
  )]);
}

console.log('\n=== summary ===');
for (const [name, pass] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
if (results.some(([, p]) => !p)) process.exitCode = 1;
