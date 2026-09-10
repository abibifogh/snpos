import test from 'node:test';
import assert from 'node:assert/strict';
import {
  barReviewLines, shopReviewLines, spendReviewLines, worstFirst, linesAgainst, offWords, REASON_WORDS,
} from '../waiting-lines.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

test('the line worth arguing about is at the top, whichever way it goes', () => {
  const lines = worstFirst([
    { name: 'a', worth: -100 },
    { name: 'b', worth: 5_000 },
    { name: 'c', worth: -20_000 },
    { name: 'd', worth: 0 },
  ]);
  assert.deepEqual(lines.map((l) => l.name), ['c', 'b', 'a', 'd']);
});

test('a bar count keeps the sign, because short and over are not the same news', () => {
  const lines = barReviewLines(
    [
      { ingredient_id: 'gin', theoretical_qty: 10, counted_qty: 8, variance_qty: -2, variance_value: -4_000 },
      { ingredient_id: 'tonic', theoretical_qty: 20, counted_qty: 21, variance_qty: 1, variance_value: 300 },
    ],
    (id) => ({ gin: 'Gin', tonic: 'Tonic' }[id] ?? ''),
  );
  assert.deepEqual(lines.map((l) => l.name), ['Gin', 'Tonic']);
  assert.equal(lines[0].worth, -4_000);
  assert.equal(lines[0].delta, -2);
  assert.equal(lines[1].worth, 300);
});

test('an ingredient that has since been removed still shows its line', () => {
  // The alternative is a count whose figures do not add up to the lines shown,
  // which is worse than a name nobody recognises.
  const [line] = barReviewLines([{ ingredient_id: 'gone', variance_value: -500 }], () => '');
  assert.match(line.name, /no longer on the list/);
  assert.equal(line.worth, -500);
});

test('a shop count names the size, the maker and the reason, and skips the obvious one', () => {
  const [basket, bead] = shopReviewLines([
    {
      name_snapshot: 'Basket', variant_label: 'Large', consignor_name: 'Ama',
      expected: 5, counted: 2, delta: -3, reason: 'damaged', unit_price: 10_000,
    },
    {
      name_snapshot: 'Beads', expected: 4, counted: 3, delta: -1, reason: 'counted', unit_price: 1_000,
    },
  ]);
  assert.equal(basket.note, `Large · Ama · ${REASON_WORDS.damaged}`);
  assert.equal(basket.worth, -30_000);
  // 'counted' means a miscount, which the numbers already say.
  assert.equal(bead.note, undefined);
});

test('a spend works a line total out when the row never stored one', () => {
  const lines = spendReviewLines([
    { name_snapshot: 'Rice', qty: 4, unit_cost: 1_250, line_total: 5_000 },
    { name_snapshot: 'Oil', qty: 2, unit_cost: 3_000 },
  ]);
  assert.equal(lines[0].worth, 5_000);
  assert.equal(lines[1].worth, 6_000);
  // Spend lines keep the order they were written in: a receipt is read down.
  assert.deepEqual(lines.map((l) => l.name), ['Rice', 'Oil']);
});

test('lines that do not add up to the amount are the reason to look', () => {
  const lines = spendReviewLines([{ name_snapshot: 'Rice', qty: 4, unit_cost: 1_250 }]);
  const short = linesAgainst(lines, 8_000);
  assert.equal(short.total, 5_000);
  assert.equal(short.off, -3_000);
  assert.equal(short.agrees, false);
  assert.match(offWords(short.off, money), /less than the spend says/);

  const over = linesAgainst(lines, 4_000);
  assert.match(offWords(over.off, money), /MORE than the spend says/);
});

test('a rounding cedi is not treated as a discrepancy', () => {
  const lines = spendReviewLines([{ name_snapshot: 'Rice', line_total: 5_001 }]);
  assert.equal(linesAgainst(lines, 5_000).agrees, true);
  assert.equal(offWords(0, money), '');
});

test('nothing itemised is nought, not a false accusation', () => {
  const none = linesAgainst([], 0);
  assert.equal(none.total, 0);
  assert.equal(none.agrees, true);
});
