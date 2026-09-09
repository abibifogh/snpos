/**
 * End to end, against the real code, with an in-memory database.
 *
 * Seeds the bar as it actually is, reads the count sheet, presses the repair,
 * presses the catch-up, and reads the sheet again. Nothing is stubbed except
 * Appwrite itself.
 */
import { __seed, __reset, __all, __missingColumns, __unreachable } from './core/client.ts';
import {
  barCountSheet, relinkShelves, pourMissedSales, unpouredForShift, saveBarCount, hasOpeningCount,
} from './core/stock.ts';
import { applyQuantityCorrection, createOrder, loadOpenOrders, orderItemsFor } from './core/orders.ts';
import { unheldWords } from './core/bar-count.ts';
import {
  postShift, postSettlement, postTipsPaid, postTaxRemitted, hanging, lockPeriod,
} from './core/ledger.ts';
import { makersShareOf } from './core/consignment-math.ts';
import { decideSpend } from './core/spend-decide.ts';
import { db, DB_ID, Query } from './core/client.ts';
// The server's side of the books: the same code the notify function runs,
// against the same in-memory database. See functions/notify/src/books-post.js.
import { postShiftClose, postSpend, postPayoutRow, postWasteRow, sweepBooks } from './notify/books-post.js';

/** What the notify function hands its books code: the database and a log. */
const server = { db, DB_ID, Query, log: () => undefined };
const linesOf = (entryId: string | undefined) => (__all('journal_lines') as any[]).filter((l) => l.entry_id === entryId);
const byAccount = (lines: any[]) => Object.fromEntries(lines.map((l) => [l.account_code, l.debit - l.credit]));
import { receiveStock } from './core/stock.ts';
import { computeTotals } from './core/pricing.ts';
import { GHANA_LEVIES, splitTax, serialiseLevies } from './core/pricing.ts';

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

/* ------------------- filing a count against a database missing a column */

console.log('\n=== I — the count itself, on a database without the approval column ===');
{
  __reset();
  /*
    Exactly what was on the screen: "23 lines did not save. Nothing else has
    been touched — try the count again." Every line of a completed count was
    refused because the approval hold needs a column an admin has to provision,
    and Appwrite refuses a whole document for one attribute it does not know.
  */
  __missingColumns('shift_stock_checks', ['applied', 'approved_by', 'approved_at']);
  __seed('stock_locations', [
    { $id: 'counter', venue_id: 'main', name: 'Bar counter', kind: 'counter', module: 'bar', active: true },
  ]);
  __seed('ingredients', shelves);
  __seed('stock_levels', shelves.map((i, n) => ({
    $id: `lvl${n}`, ingredient_id: i.$id, location_id: 'counter', qty: i.current_qty,
  })));
  __seed('shifts', [{ $id: 'sh1', venue_id: 'main', module: 'bar', status: 'OPEN' }]);

  const sheet = await barCountSheet('main');
  const out = await saveBarCount({
    venueId: 'main',
    shiftId: 'sh1',
    phase: 'open',
    userId: 'u1',
    lines: sheet.map((r) => ({
      ...r,
      // One line matches, one is three short — so both paths are exercised.
      countedText: r.ingredientId === 'club-large' ? String(r.expected - 3) : String(r.expected),
    })),
  });
  console.log(`   saved: ${JSON.stringify(out)}`);

  results.push(['I the count saves instead of being refused wholesale', ok(
    'written / failed', [out.written, out.failed], [2, 0],
  )]);
  results.push(['I the difference is applied rather than silently held', ok(
    'unheld', out.unheld, 1,
  )]);
  results.push(['I and the shelf agrees with the record', ok(
    'club level',
    (await barCountSheet('main')).find((r) => r.ingredientId === 'club-large')?.expected,
    45,
  )]);
  results.push(['I the person is told the approval step is off', ok(
    'words mention provisioning', /Provision Appwrite/.test(String(unheldWords(out.unheld))), true,
  )]);
}

console.log('\n=== J — the same count once the database has the column ===');
{
  __reset();
  __seed('stock_locations', [
    { $id: 'counter', venue_id: 'main', name: 'Bar counter', kind: 'counter', module: 'bar', active: true },
  ]);
  __seed('ingredients', shelves);
  __seed('stock_levels', shelves.map((i, n) => ({
    $id: `lvl${n}`, ingredient_id: i.$id, location_id: 'counter', qty: i.current_qty,
  })));
  __seed('shifts', [{ $id: 'sh1', venue_id: 'main', module: 'bar', status: 'OPEN' }]);

  const sheet = await barCountSheet('main');
  const out = await saveBarCount({
    venueId: 'main',
    shiftId: 'sh1',
    phase: 'open',
    userId: 'u1',
    lines: sheet.map((r) => ({
      ...r,
      countedText: r.ingredientId === 'club-large' ? String(r.expected - 3) : String(r.expected),
    })),
  });
  results.push(['J the difference waits for an admin', ok(
    'pending / unheld', [out.pending, out.unheld], [1, 0],
  )]);
  results.push(['J and the shelf has not moved yet', ok(
    'club level',
    (await barCountSheet('main')).find((r) => r.ingredientId === 'club-large')?.expected,
    48,
  )]);
}

/* ---------------------------------- taking a line off a bill that has poured */

console.log('\n=== K — a drink taken off a bill puts the bottle back ===');
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
  __seed('product_variants', [{ $id: 'large', menu_item_id: 'club', label: 'Large', active: true }]);
  __seed('recipes', [{
    $id: 'r1', menu_item_id: 'club', variant_id: 'large', addon_option_id: '',
    ingredient_id: 'club-large', qty_per_unit: 1, wastage_bp: 0,
  }]);
  __seed('shifts', [{ $id: 'sh1', venue_id: 'main', module: 'bar', status: 'OPEN' }]);
  __seed('orders', [{
    $id: 'o1', venue_id: 'main', shift_id: 'sh1', module: 'bar', status: 'PAID', order_no: 'ORD0543',
    subtotal: 8000, total: 8000, discount_total: 0,
  }]);
  __seed('order_items', [{
    $id: 'li1', order_id: 'o1', venue_id: 'main', menu_item_id: 'club', variant_id: 'large',
    name_snapshot: 'Club', variant_label: 'Large', qty: 8, unit_price: 1000, line_total: 8000,
    status: 'served',
  }]);

  // The sale actually poured, which is the only case a put-back applies to.
  await pourMissedSales({ venueId: 'main', shiftId: 'sh1', module: 'bar', userId: 'u1' });
  const afterSale = await barCountSheet('main');
  results.push(['K the sale took eight bottles off', ok(
    'club level', afterSale.find((r) => r.ingredientId === 'club-large')?.expected, 40,
  )]);

  // And now an admin takes the line off the bill entirely.
  const order = (__all('orders')[0]) as any;
  const lines = __all('order_items') as any[];
  await applyQuantityCorrection({
    order,
    lines,
    quantities: { li1: 0 },
    settings: { tax_bp: 0, service_charge_bp: 0, currency_code: 'GHS', currency_decimals: 2 } as any,
    actor: { id: 'admin', role: 'admin' },
    reason: 'Rung up on the wrong table',
    taken: 0,
    module: 'bar',
  });

  const afterRemoval = await barCountSheet('main');
  results.push(['K removing the line puts all eight back', ok(
    'club level', afterRemoval.find((r) => r.ingredientId === 'club-large')?.expected, 48,
  )]);
  results.push(['K and the bill is worth nothing', ok(
    'line + order total',
    [(__all('order_items')[0] as any).line_total, (__all('orders')[0] as any).total],
    [0, 0],
  )]);
  results.push(['K the correction is on the record', ok(
    'audit action',
    (__all('audit_log')[0] as any)?.action,
    'order_quantity_corrected',
  )]);
}

console.log('\n=== L — a line that never poured is not put back twice ===');
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
  __seed('product_variants', [{ $id: 'large', menu_item_id: 'club', label: 'Large', active: true }]);
  __seed('recipes', [{
    $id: 'r1', menu_item_id: 'club', variant_id: 'large', addon_option_id: '',
    ingredient_id: 'club-large', qty_per_unit: 1, wastage_bp: 0,
  }]);
  __seed('shifts', [{ $id: 'sh1', venue_id: 'main', module: 'bar', status: 'OPEN' }]);
  __seed('orders', [{
    $id: 'o1', venue_id: 'main', shift_id: 'sh1', module: 'bar', status: 'ACCEPTED', order_no: 'ORD0544',
    subtotal: 8000, total: 8000, discount_total: 0,
  }]);
  __seed('order_items', [{
    $id: 'li1', order_id: 'o1', venue_id: 'main', menu_item_id: 'club', variant_id: 'large',
    name_snapshot: 'Club', variant_label: 'Large', qty: 8, unit_price: 1000, line_total: 8000,
    status: 'queued',
  }]);

  /*
    Nothing has come off a bill that was never paid. Putting stock back here
    would credit a shelf that never lost it — and would leave the real pour,
    when it runs, thinking it had already happened.
  */
  await applyQuantityCorrection({
    order: __all('orders')[0] as any,
    lines: __all('order_items') as any[],
    quantities: { li1: 0 },
    settings: { tax_bp: 0, service_charge_bp: 0, currency_code: 'GHS', currency_decimals: 2 } as any,
    actor: { id: 'admin', role: 'admin' },
    reason: 'Duplicate',
    taken: 0,
    module: 'bar',
  });

  const sheet = await barCountSheet('main');
  results.push(['L a shelf that never moved is not credited', ok(
    'club level', sheet.find((r) => r.ingredientId === 'club-large')?.expected, 48,
  )]);
  results.push(['L and no movement was invented', ok(
    'movements', __all('stock_movements').length, 0,
  )]);
}

console.log('\n=== K2 — filing a held count raises exactly one notice ===');
{
  __reset();
  __seed('stock_locations', [
    { $id: 'counter', venue_id: 'main', name: 'Bar counter', kind: 'counter', module: 'bar', active: true },
  ]);
  __seed('ingredients', shelves);
  __seed('stock_levels', shelves.map((i, n) => ({
    $id: `lvl${n}`, ingredient_id: i.$id, location_id: 'counter', qty: i.current_qty,
  })));
  __seed('shifts', [{ $id: 'sh1', venue_id: 'main', module: 'bar', status: 'OPEN' }]);

  const sheet = await barCountSheet('main');
  // Two shelves short, so the count is held and somebody has to be told.
  const out = await saveBarCount({
    venueId: 'main',
    shiftId: 'sh1',
    phase: 'close',
    userId: 'regina',
    lines: sheet.map((r) => ({ ...r, countedText: String(r.expected - 2) })),
  });

  const notices = __all('approval_notices') as any[];
  results.push(['K2 one notice for the whole count, not one per line', ok(
    'notices / held lines', [notices.length, out.pending], [1, 2],
  )]);
  results.push(['K2 it carries the totals the count actually found', ok(
    'kind / lines / shift',
    [notices[0]?.kind, notices[0]?.lines, notices[0]?.shift_id, notices[0]?.counted_by],
    ['bar_count', 2, 'sh1', 'regina'],
  )]);
  results.push(['K2 and it has not been marked sent by the thing that wrote it', ok(
    'sent_at', notices[0]?.sent_at ?? null, null,
  )]);
}

console.log('\n=== K3 — a count that matched tells nobody ===');
{
  __reset();
  __seed('stock_locations', [
    { $id: 'counter', venue_id: 'main', name: 'Bar counter', kind: 'counter', module: 'bar', active: true },
  ]);
  __seed('ingredients', shelves);
  __seed('stock_levels', shelves.map((i, n) => ({
    $id: `lvl${n}`, ingredient_id: i.$id, location_id: 'counter', qty: i.current_qty,
  })));
  __seed('shifts', [{ $id: 'sh1', venue_id: 'main', module: 'bar', status: 'OPEN' }]);

  const sheet = await barCountSheet('main');
  await saveBarCount({
    venueId: 'main',
    shiftId: 'sh1',
    phase: 'close',
    userId: 'regina',
    // Everything as expected. Nothing is held, so nothing needs approving.
    lines: sheet.map((r) => ({ ...r, countedText: String(r.expected) })),
  });
  results.push(['K3 a count with no difference raises nothing', ok(
    'notices', (__all('approval_notices') as any[]).length, 0,
  )]);
}

/* ------------------ a till that was switched off, and whether it was counted in */

console.log('\n=== N — a till reopened after a count in does not ask for it again ===');
{
  /*
    What the till asks the moment it boots with a shift already running. The
    bar counted in at six; the tablet was switched off at nine and on again at
    ten. The answer has to be "yes, counted" — and when the tablet cannot reach
    the server yet, which is the usual state of a tablet that has just been
    switched on, it has to be "cannot tell", never "no".
  */
  __reset();
  __seed('stock_locations', [
    { $id: 'counter', venue_id: 'main', name: 'Bar counter', kind: 'counter', module: 'bar', active: true },
  ]);
  __seed('ingredients', shelves);
  __seed('stock_levels', shelves.map((i, n) => ({
    $id: `lvl${n}`, ingredient_id: i.$id, location_id: 'counter', qty: i.current_qty,
  })));
  __seed('shifts', [{ $id: 'sh1', venue_id: 'main', module: 'bar', status: 'open' }]);

  results.push(['N before anybody counts, the shift is not counted in', ok(
    'counted in', await hasOpeningCount('sh1'), false,
  )]);

  // Counted in, and everything on the shelf was exactly as expected — the
  // commonest count there is, and one that changes no figure anywhere.
  const sheet = await barCountSheet('main');
  const filed = await saveBarCount({
    venueId: 'main', shiftId: 'sh1', phase: 'open', userId: 'regina',
    lines: sheet.map((r) => ({ ...r, countedText: String(r.expected) })),
  });
  results.push(['N a count that matched still files every line', ok('written', filed.written, sheet.length)]);
  results.push(['N reopened with the server there: counted in', ok(
    'counted in', await hasOpeningCount('sh1'), true,
  )]);

  // Switched off, switched on, no wifi yet.
  __unreachable(true);
  results.push(['N reopened with no network: "cannot tell", not "no"', ok(
    'counted in', await hasOpeningCount('sh1'), null,
  )]);
  __unreachable(false);
}

/* ------------------------------------ a market run, and where it lands */

console.log('\n=== O — a market run posts its bottles to stock and its taxi to transport ===');
{
  /*
    The double charge this closes: filed under "Supplies", a market run used
    to be charged to expenses on the day and again as cost of sales at close.
    The lines now decide. And the server does the posting, from the row the
    till saved: the same rows, the notify function's code, fake database.
  */
  __reset();
  __seed('expense_categories', [
    { $id: 'c1', key: 'supplies', name: 'Supplies', account_code: '6000' },
    { $id: 'c2', key: 'transport', name: 'Transport', account_code: '6010' },
  ]);
  __seed('shift_expenses', [{
    $id: 'e1', venue_id: 'main', shift_id: 'sh5', amount: 27_620, module: 'bar', category_key: 'supplies',
    created_by: 'regina', approval_status: 'pending',
  }]);
  __seed('expense_items', [
    { $id: 'i1', expense_id: 'e1', stocked: true, line_total: 24_000 },   // Club · Large, 24 bottles
    { $id: 'i2', expense_id: 'e1', stocked: true, line_total: 3_600 },    // Tonic
    { $id: 'i3', expense_id: 'e1', stocked: false, line_total: 20 },      // the taxi, an overhead line
  ]);
  const spend = (__all('shift_expenses') as any[])[0];

  const first = await postSpend(server, spend);
  results.push(['O the bottles are stock, the taxi is not, cash out', ok(
    'lines', byAccount(linesOf(first.entryId)), { '1210': 27_600, '6000': 20, '1000': -27_620 },
  )]);

  // The event arrives again, and the shift close runs over it: nothing doubles.
  const again = await postSpend(server, spend);
  results.push(['O delivered twice, posted once', ok('second posting', [again.skipped, __all('journal_entries').length], ['already posted', 1])]);

  // Corrected a week later: the taxi was 120, not 20. The row changes, the books follow.
  await db.updateDocument(DB_ID, 'shift_expenses', 'e1', { amount: 27_720 });
  await db.updateDocument(DB_ID, 'expense_items', 'i3', { line_total: 120 });
  const fixed = await postSpend(server, (__all('shift_expenses') as any[])[0]);
  results.push(['O a correction moves the books to the new figure, in place', ok(
    'lines after', [fixed.corrected, byAccount(linesOf(first.entryId))], ['edited', { '1210': 27_600, '6000': 120, '1000': -27_720 }],
  )]);

  // Paid from the bank instead: the credit moves off the drawer.
  await db.updateDocument(DB_ID, 'shift_expenses', 'e1', { source: 'bank' });
  await postSpend(server, (__all('shift_expenses') as any[])[0]);
  results.push(['O paid by transfer, the money leaves the bank, not the till', ok(
    'credit', byAccount(linesOf(first.entryId))['1040'], -27_720,
  )]);
}

/* ------------------------------------ the makers, in the shop's own books */

console.log('\n=== P — a craft shift keeps its commission and holds the rest for the makers ===');
{
  /*
    Before this, a craft sale was credited in full to Craft shop sales, no
    cost was posted, and a payout never reached the books. The shop's profit
    stood at the whole sale and the money paid to makers was invisible.
  */
  __reset();
  const makers = [{ $id: 'ama', commission_bp: 3000 }];
  const lines = [
    { consignor_id: 'ama', line_total: 20_000, qty: 2 },   // two stoles, 30% to the shop
    { consignor_id: '', line_total: 5_000, qty: 1 },       // the shop's own tote bag
  ];
  const share = makersShareOf(lines, makers, { default_commission_bp: 3000 });
  results.push(['P the makers are owed their share of what sold', ok('share', share, 14_000)]);

  const ids = await postShift({
    venueId: 'main', shiftId: 'sh9', postedBy: 'betty', module: 'craft',
    takings: { cash: 25_000, card: 0, mobile_money: 0, other: 0 },
    tips: 0, tax: 0, discounts: 0, cogs: 0, cashVariance: 0, makersShare: share, expenses: [],
  });
  const sales = (__all('journal_lines') as any[]).filter((l) => l.entry_id === ids[0]);
  const by = Object.fromEntries(sales.map((l) => [l.account_code, l.debit - l.credit]));
  results.push(['P cash in; commission is sales; the rest is owed to makers', ok(
    'lines', by, { '1000': 25_000, '4020': -11_000, '2400': -14_000 },
  )]);

  __seed('consignor_payouts', [{
    $id: 'p1', venue_id: 'main', consignor_id: 'ama', amount: 14_000, method: 'momo', reference: 'PAY-0001',
    paid_at: new Date().toISOString(), status: 'recorded', paid_by: 'micheal',
  }]);
  const payout = (__all('consignor_payouts') as any[])[0];
  const posted = await postPayoutRow(server, payout);
  results.push(['P paying the maker clears what was owed, from the wallet', ok(
    'lines', byAccount(linesOf(posted.entryId)), { '2400': 14_000, '1020': -14_000 },
  )]);
  results.push(['P a retried payout does not pay the books down twice', ok(
    'again', (await postPayoutRow(server, payout)).skipped, 'already posted',
  )]);

  // Reversed by an admin: the books give the money back.
  await db.updateDocument(DB_ID, 'consignor_payouts', 'p1', { status: 'reversed', reversed_reason: 'wrong maker' });
  await postPayoutRow(server, (__all('consignor_payouts') as any[])[0]);
  const owed = (__all('journal_lines') as any[]).filter((l) => l.account_code === '2400').reduce((s2, l) => s2 + l.debit - l.credit, 0);
  results.push(['P a reversed payout is owed again', ok('owed to makers', owed, -14_000)]);
}

/* ---------------------------------------- one dear bottle, and the shelf */

console.log('\n=== Q — a dear delivery moves the shelf’s cost by one bottle’s worth ===');
{
  __reset();
  __seed('ingredients', [{
    $id: 'club-large', venue_id: 'main', name: 'Club · Large', module: 'bar', active: true,
    unit: 'bottle', base_unit_cost: 850, current_qty: 40, count_each_shift: true,
  }]);
  const ing = (__all('ingredients') as any[])[0];
  await receiveStock({ venueId: 'main', ingredient: ing, qty: 1, unitCost: 1200, refType: 'expense', refId: 'e9' });
  const after = (__all('ingredients') as any[])[0];
  results.push(['Q the shelf is valued at the weighted average, not the last receipt', ok(
    'cost / last / qty', [after.base_unit_cost, after.last_unit_cost, after.current_qty], [859, 1200, 41],
  )]);
}

/* ----------------------------------- what a close leaves hanging, cleared */

console.log('\n=== R — settling up clears what the shift close left hanging ===');
{
  __reset();
  await postShift({
    venueId: 'main', shiftId: 'sh10', postedBy: 'kofi', module: 'kitchen',
    takings: { cash: 10_000, card: 0, mobile_money: 12_400, other: 0 },
    tips: 1_240, tax: 3_000, discounts: 0, cogs: 0, cashVariance: 0, expenses: [],
  });
  const b = await hanging('main');
  results.push(['R after a close, MoMo, tips and tax are all waiting', ok(
    'hanging', [b.card, b.momo, b.tips, b.tax, b.taxes], [0, 12_400, 1_240, 3_000, [{ account_code: '2100', name: 'VAT', amount: 3_000 }]],
  )]);

  await postSettlement('main', { kind: 'momo', received: 12_276, fee: 124, reference: 'MTN-77', postedBy: 'micheal' });
  await postTipsPaid('main', { amount: 1_240, postedBy: 'micheal' });
  await postTaxRemitted('main', { amount: 3_000, reference: 'GRA-SEP', postedBy: 'micheal' });
  const a = await hanging('main');
  results.push(['R settled, paid and remitted, nothing is left hanging', ok(
    'hanging', [a.card, a.momo, a.tips, a.tax, a.taxes], [0, 0, 0, 0, []],
  )]);
  const lines = __all('journal_lines') as any[];
  const bank = lines.filter((l) => l.account_code === '1040').reduce((s, l) => s + l.debit - l.credit, 0);
  const fees = lines.filter((l) => l.account_code === '6070').reduce((s, l) => s + l.debit - l.credit, 0);
  results.push(['R the bank holds what arrived less the tax, and the fee is a cost', ok(
    'bank / fees', [bank, fees], [12_276 - 3_000, 124],
  )]);
}

/* ------------------------- a spend corrected after its month was closed */

console.log('\n=== S — a correction in a closed month is a reversal and a fresh entry, not an edit ===');
{
  __reset();
  __seed('expense_categories', [{ $id: 'c2', key: 'transport', name: 'Transport', account_code: '6010' }]);
  __seed('shift_expenses', [{
    $id: 'e-aug', venue_id: 'main', amount: 2_000, module: 'kitchen', category_key: 'transport',
    created_by: 'kofi', approval_status: 'pending', $createdAt: '2026-08-20T12:00:00.000Z',
  }]);
  const original = (await postSpend(server, (__all('shift_expenses') as any[])[0])).entryId;
  await lockPeriod('main', '2026-08-31', { lockedBy: 'micheal' });

  // A week into September somebody notices the taxi was 2,500.
  await db.updateDocument(DB_ID, 'shift_expenses', 'e-aug', { amount: 2_500 });
  const landed = await postSpend(server, (__all('shift_expenses') as any[])[0]);

  const entries = __all('journal_entries') as any[];
  results.push(['S the closed month keeps its figure untouched', ok(
    'august lines', linesOf(original).map((l) => [l.account_code, l.debit, l.credit]), [['6010', 2000, 0], ['1000', 0, 2000]],
  )]);
  const reversal = entries.find((e) => e.reversal_of === original);
  results.push(['S a reversal cancels it in the first open day', ok(
    'reversal', [landed.corrected, reversal?.date?.slice(0, 10), linesOf(reversal?.$id).map((l) => [l.account_code, l.debit, l.credit])],
    ['reversed', '2026-09-01', [['6010', 0, 2000], ['1000', 2000, 0]]],
  )]);
  results.push(['S and a fresh entry says it right, keyed to the same spend', ok(
    'fresh', [entries.find((e) => e.$id === landed.entryId)?.source_id, linesOf(landed.entryId).map((l) => [l.account_code, l.debit, l.credit])],
    ['expense:e-aug', [['6010', 2500, 0], ['1000', 0, 2500]]],
  )]);
  const net = (__all('journal_lines') as any[]).filter((l) => l.account_code === '6010').reduce((s2, l) => s2 + l.debit - l.credit, 0);
  results.push(['S the books net to the corrected figure', ok('transport', net, 2_500)]);
  // And a spend recorded INTO the closed month now is refused, not posted.
  __seed('shift_expenses', [{
    $id: 'e-late', venue_id: 'main', amount: 900, module: 'kitchen', category_key: 'transport',
    created_by: 'kofi', approval_status: 'pending', $createdAt: '2026-08-02T12:00:00.000Z',
  }]);
  results.push(['S a spend dated inside the closed month is held, not posted', ok(
    'late', (await postSpend(server, (__all('shift_expenses') as any[]).find((e) => e.$id === 'e-late'))).skipped, 'locked',
  )]);
}

/* ----------------------------------------- VAT and the levies beside it */

console.log('\n=== T — a bill carries each levy, and the close credits each to its own account ===');
{
  __reset();
  const settings = { tax_rate_bp: 1500, tax_inclusive: false, service_charge_bp: 0, levies: serialiseLevies([...GHANA_LEVIES]) };
  const totals = computeTotals({
    lines: [{ key: 'k', menu_item_id: 'm', name: 'Jollof', unit_price: 10_000, qty: 1, addons: [] }],
    settings,
  });
  results.push(['T a 10,000 bill carries NHIL, GETFund, tourism, then VAT on the lot', ok(
    'parts / total', [totals.tax_parts.map((p) => [p.key, p.amount]), totals.total],
    [[['nhil', 250], ['getfund', 250], ['tourism', 100], ['vat', 1590]], 12_190],
  )]);

  const parts = splitTax(totals.tax_total, { vatBp: 1500, levies: [...GHANA_LEVIES] });
  const ids = await postShift({
    venueId: 'main', shiftId: 'sh11', postedBy: 'kofi', module: 'kitchen',
    takings: { cash: 12_190, card: 0, mobile_money: 0, other: 0 },
    tips: 0, tax: totals.tax_total, taxParts: parts, discounts: 0, cogs: 0, cashVariance: 0, expenses: [],
  });
  const lines = (__all('journal_lines') as any[]).filter((l) => l.entry_id === ids[0]);
  const by = Object.fromEntries(lines.map((l) => [l.account_code, l.debit - l.credit]));
  results.push(['T each levy is owed on its own account', ok(
    'lines', by, { '1000': 12_190, '4000': -10_000, '2110': -250, '2120': -250, '2130': -100, '2100': -1_590 },
  )]);
}

/* ------------------------------------------------- waste, off the books */

console.log('\n=== U — waste is written off the shelf and onto the month ===');
{
  __reset();
  __seed('ingredients', [{ $id: 'chk', venue_id: 'main', name: 'Chicken', module: 'kitchen', unit: 'kg', base_unit_cost: 600, current_qty: 10 }]);
  __seed('waste_log', [{
    $id: 'w1', venue_id: 'main', ingredient_id: 'chk', qty: 3, unit: 'kg', reason: 'spoiled', value: 1_800, recorded_by: 'kofi',
  }]);
  const waste = (__all('waste_log') as any[])[0];
  const posted = await postWasteRow(server, waste);
  results.push(['U spoiled chicken is a cost, and the larder is lighter', ok('lines', byAccount(linesOf(posted.entryId)), { '6080': 1_800, '1200': -1_800 })]);
  results.push(['U the memo says what went', ok('memo', (__all('journal_entries') as any[])[0].memo, 'Written off: 3 kg Chicken, spoiled')]);
  results.push(['U written off once, however many times it is asked', ok(
    'again', (await postWasteRow(server, waste)).skipped, 'already posted',
  )]);
}

/* ------------------------------------------- a spend looked at, and refused */

console.log('\n=== V — refusing a spend takes it off the books; approving only stamps it ===');
{
  __reset();
  __seed('expense_categories', [{ $id: 'c3', key: 'transport', name: 'Transport', account_code: '6010' }]);
  __seed('shift_expenses', [
    { $id: 'e-ok', venue_id: 'main', amount: 1_500, category_key: 'transport', created_by: 'kofi', approval_status: 'pending' },
    { $id: 'e-no', venue_id: 'main', amount: 4_000, category_key: 'transport', created_by: 'kofi', approval_status: 'pending' },
  ]);
  for (const e of __all('shift_expenses') as any[]) await postSpend(server, e);

  // The admin presses the buttons; the rows change; the server answers each.
  await decideSpend({ expenseId: 'e-ok', decision: 'approved', by: 'micheal' });
  await decideSpend({ expenseId: 'e-no', decision: 'rejected', by: 'micheal' });
  const rows = __all('shift_expenses') as any[];
  results.push(['V both rows say who decided, and what', ok(
    'rows', rows.map((r) => [r.$id, r.approval_status, r.approved_by]),
    [['e-ok', 'approved', 'micheal'], ['e-no', 'rejected', 'micheal']],
  )]);
  const kept = await postSpend(server, rows.find((r) => r.$id === 'e-ok'));
  const refused = await postSpend(server, rows.find((r) => r.$id === 'e-no'));
  results.push(['V approving posts nothing new; refusing reverses', ok('reversed', [kept.skipped, refused.reversed], ['already posted', true])]);
  const lines = __all('journal_lines') as any[];
  const transport = lines.filter((l) => l.account_code === '6010').reduce((s2, l) => s2 + l.debit - l.credit, 0);
  const cash = lines.filter((l) => l.account_code === '1000').reduce((s2, l) => s2 + l.debit - l.credit, 0);
  results.push(['V the month carries the approved taxi and not the refused one', ok('transport / cash', [transport, cash], [1_500, -1_500])]);
  // Refusing again does not reverse the reversal.
  const again = await postSpend(server, rows.find((r) => r.$id === 'e-no'));
  results.push(['V refused twice is refused once', ok('again', again.skipped, 'refused, nothing on the books')]);
}

/* ------------------------------ a shift closed at the till, booked by the server */

console.log('\n=== W — a closed shift reaches the books from its row, once, and the sweep catches a missed one ===');
{
  __reset();
  __seed('settings', [{ $id: 'main', tax_rate_bp: 1500, tax_inclusive: false, levies: serialiseLevies([...GHANA_LEVIES]) }]);
  __seed('payment_methods', [
    { $id: 'm-cash', venue_id: 'main', name: 'Cash', kind: 'cash', enabled: true },
    { $id: 'm-momo', venue_id: 'main', name: 'MoMo', kind: 'mobile_money', enabled: true },
  ]);
  __seed('payments', [
    { $id: 'pay1', shift_id: 'sh20', method_id: 'm-cash', amount: 10_000, tip: 0 },
    { $id: 'pay2', shift_id: 'sh20', method_id: 'm-momo', amount: 12_190, tip: 500 },
    { $id: 'pay3', shift_id: 'sh20', method_id: 'm-cash', amount: 3_000, tip: 0, status: 'voided' },
  ]);
  // What the till wrote at close: the drawer was 100 short.
  __seed('shifts', [{
    $id: 'sh20', venue_id: 'main', code: 'BIST-20', module: 'kitchen', status: 'closed',
    opened_at: '2026-09-08T08:00:00.000Z', closed_at: '2026-09-08T22:00:00.000Z', closed_by: 'kofi',
    expected: JSON.stringify({ 'm-cash': 10_000, 'm-momo': 12_690 }), counted: JSON.stringify({ 'm-cash': 9_900, 'm-momo': 12_690 }),
    tip_total: 500, tax_total: 2_190, discount_total: 0, cogs_total: 6_000, posted_to_ledger: false,
  }]);
  const shift = (__all('shifts') as any[])[0];

  const first = await postShiftClose(server, shift);
  const entries = __all('journal_entries') as any[];
  results.push(['W the close makes three entries and marks the shift posted', ok(
    'entries / flag', [first.posted, entries.map((e) => e.memo), (__all('shifts') as any[])[0].posted_to_ledger],
    [3, ['Shift sales', 'Cost of bistro goods sold', 'Cash short'], true],
  )]);
  const sales = byAccount(linesOf(entries[0].$id));
  results.push(['W cash and mobile money in, sales, each levy, VAT and tips owed', ok(
    'sales', sales, { '1000': 10_000, '1020': 12_190, '4000': -(22_190 - 2_190 - 500), '2110': -250, '2120': -250, '2130': -100, '2100': -1_590, '2200': -500 },
  )]);
  results.push(['W the entries are dated when the shift closed', ok('date', entries[0].date, '2026-09-08T22:00:00.000Z')]);
  results.push(['W the update that marks it posted, and every later touch, posts nothing more', ok(
    'again', [(await postShiftClose(server, (__all('shifts') as any[])[0])).skipped, __all('journal_entries').length], ['already posted', 3],
  )]);

  // A second shift closed while the function was down. The sweep finds it.
  __seed('shifts', [{
    $id: 'sh21', venue_id: 'main', code: 'BAR-21', module: 'bar', status: 'closed',
    closed_at: '2026-09-08T23:30:00.000Z', closed_by: 'ama', expected: '{}', counted: '{}',
    tip_total: 0, tax_total: 0, discount_total: 0, cogs_total: 0, posted_to_ledger: false,
  }]);
  __seed('payments', [{ $id: 'pay4', shift_id: 'sh21', method_id: 'm-cash', amount: 4_000, tip: 0 }]);
  const swept = await sweepBooks(server);
  const bar = (__all('journal_entries') as any[]).find((e) => e.source_id === 'sh21');
  results.push(['W the hourly sweep posts the shift the event missed', ok(
    'swept', [swept.shifts, byAccount(linesOf(bar?.$id))], [1, { '1000': 4_000, '4010': -4_000 }],
  )]);

  // A month closed, then a shift somehow closed inside it: held, said, never posted.
  await lockPeriod('main', '2026-09-30', { lockedBy: 'micheal' });
  __seed('shifts', [{
    $id: 'sh22', venue_id: 'main', code: 'BIST-22', status: 'closed', closed_at: '2026-09-09T22:00:00.000Z',
    expected: '{}', counted: '{}', tip_total: 0, tax_total: 0, discount_total: 0, cogs_total: 0, posted_to_ledger: false,
  }]);
  __seed('payments', [{ $id: 'pay5', shift_id: 'sh22', method_id: 'm-cash', amount: 100, tip: 0 }]);
  results.push(['W a shift inside a locked month is held, not posted', ok(
    'locked', (await postShiftClose(server, (__all('shifts') as any[]).find((x) => x.$id === 'sh22'))).skipped, 'locked',
  )]);
}

console.log('\n=== summary ===');
for (const [name, pass] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
if (results.some(([, p]) => !p)) process.exitCode = 1;
