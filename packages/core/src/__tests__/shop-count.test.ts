import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shopCountRules, isFullCountDay, shelvesOf, shelfForDay, countParts, partIndexes, resumeWords, DEFAULT_COUNT_OVER,
} from '../shop-count.ts';
import type { CountLine } from '../stocktake.ts';

const piece = (id: string, price: number, cat?: [string, string], variantId?: string): CountLine => ({
  menuItemId: id, variantId, name: id, onHand: 1, unitPrice: price,
  categoryId: cat?.[0], categoryName: cat?.[1],
});

const BASKETS: [string, string] = ['c-b', 'Baskets wall'];
const TEXTILES: [string, string] = ['c-t', 'Textiles'];
const lines = [
  piece('basket-s', 8_000, BASKETS),
  piece('basket-xl', 65_000, BASKETS),
  piece('stole', 72_000, TEXTILES),
  piece('runner', 12_000, TEXTILES),
  piece('card', 1_500),
];
// A Tuesday: not the default Sunday full count.
const tuesday = new Date(2026, 9, 27);

test('nothing answered means the short count, with the full count on Sunday', () => {
  assert.deepEqual(shopCountRules(null), { sold: true, over: DEFAULT_COUNT_OVER, rotate: true, full: 'sun' });
  assert.deepEqual(
    shopCountRules({ shop_count_sold: false, shop_count_over: 0, shop_count_rotate: false, shop_count_full: 'month' }),
    { sold: false, over: 0, rotate: false, full: 'month' },
  );
  assert.equal(shopCountRules({ shop_count_full: 'whenever' }).full, 'sun', 'an unknown answer is the default');
});

test('the full-count day', () => {
  assert.equal(isFullCountDay('sun', new Date(2026, 10, 1)), true);
  assert.equal(isFullCountDay('sun', tuesday), false);
  assert.equal(isFullCountDay('month', new Date(2026, 10, 1)), true);
  assert.equal(isFullCountDay('month', new Date(2026, 10, 2)), false);
  assert.equal(isFullCountDay('never', new Date(2026, 10, 1)), false);
});

test('shelves take turns by the day, and pieces on no shelf share one at the end', () => {
  const shelves = shelvesOf(lines);
  assert.deepEqual(shelves.map((s) => s.name), ['Baskets wall', 'Textiles', 'Other']);
  const a = shelfForDay(shelves, tuesday)!.name;
  const b = shelfForDay(shelves, new Date(2026, 9, 28))!.name;
  assert.notEqual(a, b, 'a different shelf the next day');
  assert.equal(shelfForDay(shelves, new Date(2026, 9, 27, 23, 59))!.name, a, 'the same shelf all day, in and out');
  assert.equal(shelfForDay([], tuesday), null);
});

test('tonight is sold or moved, then the valuable pieces, then today\'s shelf, each piece once', () => {
  const parts = countParts({
    lines, rules: shopCountRules(null), day: tuesday, moved: new Set(['stole:']), money: (n) => `GH₵${n / 100}`,
  });
  const names = (p: { indexes: number[] }) => p.indexes.map((i) => lines[i].menuItemId);
  assert.equal(parts[0].key, 'sold');
  assert.deepEqual(names(parts[0]), ['stole']);
  assert.equal(parts[1].title, 'Worth GH₵500 or more');
  assert.deepEqual(names(parts[1]), ['basket-xl'], 'the stole is already counted as sold');
  assert.equal(parts[2].key, 'shelf');
  const all = partIndexes(parts);
  assert.equal(all.length, new Set(all).size, 'nothing counted twice');
  assert.ok(all.length < lines.length, 'fewer than the whole shop');
});

test('the full-count day, or every switch off, is the whole shop in one part', () => {
  const sunday = new Date(2026, 10, 1);
  const full = countParts({ lines, rules: shopCountRules(null), day: sunday, moved: new Set() });
  assert.equal(full.length, 1);
  assert.equal(full[0].key, 'all');
  assert.equal(full[0].indexes.length, lines.length);
  const off = countParts({
    lines, rules: { sold: false, over: 0, rotate: false, full: 'never' }, day: tuesday, moved: new Set(),
  });
  assert.equal(off[0].indexes.length, lines.length);
});

test('pieces waiting for an admin are left off, and empty parts are dropped', () => {
  const parts = countParts({
    lines, rules: { sold: true, over: 50_000, rotate: false, full: 'never' }, day: tuesday,
    moved: new Set(), held: new Set(['basket-xl:']),
  });
  assert.deepEqual(parts.map((p) => p.key), ['valuable'], 'nothing sold, so no sold part');
  assert.deepEqual(parts[0].indexes.map((i) => lines[i].menuItemId), ['stole']);
});

test('a size is its own piece', () => {
  const sized = [piece('basket', 60_000, BASKETS, 'v-l'), piece('basket', 9_000, BASKETS, 'v-s')];
  const parts = countParts({
    lines: sized, rules: { sold: true, over: 0, rotate: false, full: 'never' }, day: tuesday, moved: new Set(['basket:v-s']),
  });
  assert.deepEqual(parts[0].indexes, [1]);
});

test('a resumed count says who, how far and when', () => {
  assert.equal(
    resumeWords({ who: 'Esi', done: 14, total: 38, at: 1, time: () => '2:10 pm' }),
    'Esi counted 14 of 38 at 2:10 pm. Everything typed is kept on the system, so it is here on any till.',
  );
  assert.match(resumeWords({ done: 1, total: 2, time: () => '' }), /^Somebody counted 1 of 2\./);
});
