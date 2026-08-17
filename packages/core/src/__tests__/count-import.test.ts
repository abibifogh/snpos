import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readCountImport, applyCountImport, summariseImport, COUNT_HEADINGS,
} from '../count-import.ts';
import type { CountLine } from '../stocktake.ts';

const line = (over: Partial<CountLine>): CountLine => ({
  menuItemId: 'm1', name: 'Large indigo bowl', onHand: 5, unitPrice: 10_000, ...over,
});

const shelf: CountLine[] = [
  line({ menuItemId: 'm1', name: 'Large indigo bowl', consignorName: 'Ama Serwaa', onHand: 5 }),
  line({ menuItemId: 'm2', variantId: 'v1', name: 'Woven basket', variantLabel: 'Small', consignorName: 'Kofi Mensah', onHand: 12 }),
  line({ menuItemId: 'm2', variantId: 'v2', name: 'Woven basket', variantLabel: 'Large', consignorName: 'Kofi Mensah', onHand: 3 }),
];

const ctx = {
  lines: shelf,
  owners: [{ $id: 'c1', name: 'Ama Serwaa' }, { $id: 'c2', name: 'Kofi Mensah' }],
  categories: [{ $id: 'k1', name: 'Pottery' }],
  decimals: 2,
};

const head = [...COUNT_HEADINGS];

test('a plain count fills the sheet', () => {
  const r = readCountImport([head, ['Large indigo bowl', '', 'Ama Serwaa', '', '4', '', '']], ctx);
  assert.equal(r.problems.length, 0);
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].counted, 4);
  assert.equal(r.matched[0].reason, 'counted');

  const filled = applyCountImport(shelf, r.matched);
  assert.equal(filled[0].countedText, '4');
  // Untouched lines stay untouched, not zeroed.
  assert.equal(filled[1].countedText, undefined);
});

test('a size is what tells two lines of the same piece apart', () => {
  const r = readCountImport([head,
    ['Woven basket', 'Small', 'Kofi Mensah', '', '11', '', ''],
    ['Woven basket', 'Large', 'Kofi Mensah', '', '2', 'damaged', ''],
  ], ctx);
  assert.equal(r.problems.length, 0);
  assert.deepEqual(r.matched.map((m) => m.line.variantLabel), ['Small', 'Large']);
  assert.equal(r.matched[1].reason, 'damaged');
});

test('a name matching two shelf lines is named, never guessed', () => {
  // Picking one would put somebody else's shortage on a maker's statement,
  // and it would look right.
  const r = readCountImport([head, ['Woven basket', '', '', '', '9', '', '']], ctx);
  assert.equal(r.matched.length, 0);
  assert.match(r.problems[0].message, /matches 2 lines/);
  assert.match(r.problems[0].message, /size or the owner/);
});

test('blank counted is skipped, because blank is not nought', () => {
  const r = readCountImport([head, ['Large indigo bowl', '', 'Ama Serwaa', '', '', '', '']], ctx);
  assert.equal(r.matched.length, 0);
  assert.equal(r.problems.length, 0, 'not a problem — just not counted');
});

test('nought is a real answer and writes the piece off', () => {
  const r = readCountImport([head, ['Large indigo bowl', '', 'Ama Serwaa', '', '0', 'missing', '']], ctx);
  assert.equal(r.matched[0].counted, 0);
  assert.equal(r.matched[0].reason, 'lost');
});

test('the words people actually type are understood', () => {
  const rows = [head,
    ['Large indigo bowl', '', 'Ama Serwaa', '', '1', 'BROKEN', ''],
    ['Woven basket', 'Small', 'Kofi Mensah', '', '1', 'went back', ''],
    ['Woven basket', 'Large', 'Kofi Mensah', '', '1', 'Miscount', ''],
  ];
  const r = readCountImport(rows, ctx);
  assert.deepEqual(r.matched.map((m) => m.reason), ['damaged', 'returned', 'counted']);
});

test('a reason nobody recognises stops that row rather than defaulting', () => {
  const r = readCountImport([head, ['Large indigo bowl', '', 'Ama Serwaa', '', '2', 'ate it', '']], ctx);
  assert.equal(r.matched.length, 0);
  assert.match(r.problems[0].message, /not a reason/);
});

test('a piece the shop does not have is offered, not refused', () => {
  const r = readCountImport([head, ['Clay pot', '', 'New Maker', 'Pottery', '6', '', '45.00']], ctx);
  assert.equal(r.matched.length, 0);
  assert.equal(r.missingProducts.length, 1);
  assert.equal(r.missingProducts[0].name, 'Clay pot');
  assert.equal(r.missingProducts[0].counted, 6);
  assert.equal(r.missingProducts[0].price, 4_500, 'money in minor units');
  assert.deepEqual(r.missingOwners, ['New Maker']);
});

test('an owner the shop has is not offered again', () => {
  const r = readCountImport([head, ['Clay pot', '', 'Ama Serwaa', 'Pottery', '6', '', '']], ctx);
  assert.deepEqual(r.missingOwners, [], 'Ama already exists');
  assert.equal(r.missingProducts.length, 1);
});

test('the same line twice is reported rather than counted twice', () => {
  const r = readCountImport([head,
    ['Large indigo bowl', '', 'Ama Serwaa', '', '4', '', ''],
    ['Large indigo bowl', '', 'Ama Serwaa', '', '7', '', ''],
  ], ctx);
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].counted, 4, 'the first answer stands');
  assert.deepEqual(r.duplicates, ['Large indigo bowl']);
});

test('a file with no product column is refused with the headings it wanted', () => {
  const r = readCountImport([['qty', 'notes'], ['4', 'x']], ctx);
  assert.match(r.problems[0].message, /no "product" column/);
  assert.match(r.problems[0].message, /counted/);
});

test('a file with no counted column has nothing to record', () => {
  const r = readCountImport([['product', 'owner'], ['Large indigo bowl', 'Ama Serwaa']], ctx);
  assert.match(r.problems[0].message, /nothing to record/);
});

test('what it comes to is said before it is applied', () => {
  const r = readCountImport([head,
    ['Large indigo bowl', '', 'Ama Serwaa', '', '3', '', ''],
    ['Woven basket', 'Small', 'Kofi Mensah', '', '14', '', ''],
  ], ctx);
  const s = summariseImport(r);
  assert.equal(s.willFill, 2);
  assert.equal(s.differences, 2);
  assert.equal(s.missing, 2, 'bowl 5 -> 3');
  assert.equal(s.extra, 2, 'basket 12 -> 14');
});

test('headings are matched however they are cased and spaced', () => {
  const r = readCountImport([
    ['  Product ', 'SIZE', 'Owner', 'category', ' Counted', 'reason', 'price'],
    ['Large indigo bowl', '', 'Ama Serwaa', '', '4', '', ''],
  ], ctx);
  assert.equal(r.matched.length, 1);
});

test('an empty file says so instead of throwing', () => {
  assert.match(readCountImport([], ctx).problems[0].message, /empty/);
});
