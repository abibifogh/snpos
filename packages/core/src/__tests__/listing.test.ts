import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matches, sortItems, sortStock, fillFraction, stockState,
} from '../listing.ts';

const item = (name: string, price: number, sort = 0, categoryName?: string) =>
  ({ name, price, sort, categoryName });

const stock = (name: string, current_qty: number, par_level: number, base_unit_cost = 0, category?: string) =>
  ({ name, current_qty, par_level, base_unit_cost, category });

test('searching is blind to case and to accents', () => {
  // "cafe" has to find "Café", because nobody types the accent at a till.
  assert.equal(matches('Café Latte', 'cafe'), true);
  assert.equal(matches('Café Latte', 'LATTE'), true);
  assert.equal(matches('Mojito', 'jit'), true);
  assert.equal(matches('Mojito', 'gin'), false);
});

test('an empty search matches everything rather than nothing', () => {
  assert.equal(matches('anything', ''), true);
  assert.equal(matches('anything', '   '), true);
  assert.equal(matches(undefined, ''), true);
});

test('drinks sort by price both ways, and ties fall back to the name', () => {
  const rows = [item('Mojito', 4500), item('Club', 2500), item('Amarula', 2500)];
  assert.deepEqual(sortItems(rows, 'price_low').map((r) => r.name), ['Amarula', 'Club', 'Mojito']);
  assert.deepEqual(sortItems(rows, 'price_high').map((r) => r.name), ['Mojito', 'Amarula', 'Club']);
});

test('within a category, drinks are still ordered by name', () => {
  // A category sorted by its own internal order reads as random to somebody
  // looking for one drink.
  const rows = [
    item('Zebra', 100, 1, 'Beer'), item('Apple', 200, 2, 'Beer'), item('Mango', 300, 3, 'Cocktails'),
  ];
  assert.deepEqual(sortItems(rows, 'category').map((r) => r.name), ['Apple', 'Zebra', 'Mango']);
});

test('the default keeps the order the menu was arranged in', () => {
  const rows = [item('Third', 0, 3), item('First', 0, 1), item('Second', 0, 2)];
  assert.deepEqual(sortItems(rows, 'menu').map((r) => r.name), ['First', 'Second', 'Third']);
});

test('sorting never edits the list it was handed', () => {
  const rows = [item('B', 2), item('A', 1)];
  sortItems(rows, 'name');
  assert.equal(rows[0].name, 'B', 'the original order is untouched');
});

test('what is lowest means lowest against par, not the smallest number', () => {
  // Four hundred grams of saffron is not "more stock" than two crates of
  // tonic. Raw quantity would call the saffron fine and the tonic urgent.
  const saffron = stock('Saffron', 400, 2000);   // a fifth of par
  const tonic = stock('Tonic', 20, 24);          // most of par
  assert.deepEqual(sortStock([tonic, saffron], 'level').map((r) => r.name), ['Saffron', 'Tonic']);
});

test('an item with no par set sorts last, not first', () => {
  // Nobody has given it a target, so it is not evidence of a shortage.
  const noPar = stock('Novelty glass', 0, 0);
  const low = stock('Gin', 2, 10);
  assert.deepEqual(sortStock([noPar, low], 'level').map((r) => r.name), ['Gin', 'Novelty glass']);
  assert.equal(fillFraction(noPar), Number.POSITIVE_INFINITY);
});

test('stock sorts by cost and by category too', () => {
  const rows = [stock('Cheap', 1, 1, 100, 'B'), stock('Dear', 1, 1, 9000, 'A')];
  assert.deepEqual(sortStock(rows, 'cost_high').map((r) => r.name), ['Dear', 'Cheap']);
  assert.deepEqual(sortStock(rows, 'category').map((r) => r.name), ['Dear', 'Cheap']);
});

test('out, low and fine are told apart the same way the shelf badge does', () => {
  assert.equal(stockState(stock('Gone', 0, 10)), 'out');
  assert.equal(stockState(stock('Nearly', 3, 10)), 'low', '30% of par is the default warning');
  assert.equal(stockState(stock('Plenty', 9, 10)), 'ok');
});

test('a warning level set by hand beats the percentage', () => {
  const own = { ...stock('Gin', 5, 100), low_threshold: 8 };
  assert.equal(stockState(own), 'low', '5 is under the 8 somebody typed');
  // Without the override, 5 of a par of 100 would be low anyway; use a case
  // where the two answers actually differ.
  const generous = { ...stock('Gin', 40, 100), low_threshold: 8 };
  assert.equal(stockState(generous), 'ok');
  assert.equal(stockState(stock('Gin', 40, 100)), 'ok');
  const strict = { ...stock('Gin', 40, 100), low_threshold: 50 };
  assert.equal(strict.low_threshold, 50);
  assert.equal(stockState(strict), 'low', 'the hand-set figure wins over 30% of par');
});

test('nothing on the shelf is out, whatever the thresholds say', () => {
  assert.equal(stockState({ ...stock('Gin', 0, 0), low_threshold: 0 }), 'out');
});
