import test from 'node:test';
import assert from 'node:assert/strict';
import {
  previousWindow, movement, sliceBy, analyseSide, analyseExpenses, overTime,
  changeWords, highlights, sideOf, SIDE_WORDS,
  type AnalysedExpense,
} from '../expense-analysis.ts';

const spend = (over: Partial<AnalysedExpense> = {}): AnalysedExpense => ({
  $id: 'e1', $createdAt: '2026-08-10T10:00:00.000Z', amount: 10_000, ...over,
});

const money = (n: number) => `GH¢${(n / 100).toFixed(2)}`;

test('the period before is the same length, not "last month"', () => {
  /**
   * Comparing eleven days against thirty is how a report tells somebody their
   * costs have collapsed. The window also ends where this one begins, so the
   * two never overlap and nothing is counted twice.
   */
  const back = previousWindow('2026-08-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
  assert.equal(back.to < '2026-08-01T00:00:00.000Z', true, 'no overlap');
  assert.equal(
    Date.parse('2026-08-31T00:00:00.000Z') - Date.parse('2026-08-01T00:00:00.000Z'),
    Date.parse('2026-08-01T00:00:00.000Z') - Date.parse(back.from),
    'the same span',
  );
});

test('nothing before is not a hundred per cent rise', () => {
  /**
   * Nought to five hundred is not "up 100%" — it is a thing that did not
   * happen before and does now. A percentage there is arithmetic pretending to
   * be insight.
   */
  assert.equal(movement(50_000, 0).changeBp, null);
  assert.equal(changeWords(null).text, 'new');
  assert.equal(movement(15_000, 10_000).changeBp, 5_000);
  assert.equal(changeWords(5_000).text, 'up 50%');
  assert.equal(changeWords(-5_000).text, 'down 50%');
  // Spending more is the warning here, which is the opposite of a sales report.
  assert.equal(changeWords(5_000).tone, 'warn');
  assert.equal(changeWords(-5_000).tone, 'ok');
});

test('a change too small to mean anything is not dressed up as a trend', () => {
  // Under five per cent is noise in a month's spending, and calling it a trend
  // is how a report stops being believed.
  assert.equal(changeWords(300).text, 'about the same');
  assert.equal(changeWords(-400).tone, 'default');
});

test('something spent last month and not this one still gets a row', () => {
  /**
   * A supplier who stopped being paid is exactly what somebody wants to see,
   * and it can only appear if the earlier rows may create keys the current
   * ones never mention.
   */
  const rows = sliceBy({
    now: [spend({ category_key: 'transport', amount: 5_000 })],
    before: [
      spend({ category_key: 'transport', amount: 4_000 }),
      spend({ category_key: 'repairs', amount: 30_000 }),
    ],
    keyOf: (e) => e.category_key ?? '',
  });
  const repairs = rows.find((r) => r.key === 'repairs');
  assert.equal(repairs?.now, 0);
  assert.equal(repairs?.before, 30_000);
  // Sorted by what is being spent NOW: a category that went from two cedis to
  // twenty must not outrank the one quietly eating a third of the month.
  assert.deepEqual(rows.map((r) => r.key), ['transport', 'repairs']);
});

test('shares are of this period, and add up', () => {
  const rows = sliceBy({
    now: [
      spend({ category_key: 'a', amount: 7_500 }),
      spend({ category_key: 'b', amount: 2_500 }),
    ],
    before: [],
    keyOf: (e) => e.category_key ?? '',
  });
  assert.equal(rows[0].shareBp, 7_500);
  assert.equal(rows.reduce((a, r) => a + r.shareBp, 0), 10_000);
});

test('a side with no module on it is the kitchen, like everywhere else', () => {
  assert.equal(sideOf(spend()), 'kitchen');
  assert.equal(sideOf(spend({ module: 'bar' })), 'bar');
  assert.equal(sideOf(spend({ module: 'nonsense' })), 'kitchen');
});

test('each trade is measured against itself, not against the business', () => {
  /**
   * A bar's spending is almost all stock and a shop's is barely anything.
   * Added together they describe none of them, so a side's own figures are
   * built from its own rows.
   */
  const now = [
    spend({ $id: 'a', module: 'bar', amount: 60_000, category_key: 'bar_stock' }),
    spend({ $id: 'b', module: 'kitchen', amount: 20_000, category_key: 'transport' }),
  ];
  const before = [spend({ $id: 'c', module: 'bar', amount: 30_000, category_key: 'bar_stock' })];

  const bar = analyseSide({ side: 'bar', now, before });
  assert.equal(bar.spend.now, 60_000);
  assert.equal(bar.spend.before, 30_000);
  assert.equal(bar.spend.changeBp, 10_000, 'doubled');
  assert.equal(bar.largest?.$id, 'a');
  // Its share of ITS OWN spending, not of the business's.
  assert.equal(bar.categories[0].shareBp, 10_000);
});

test('money that never came out of a drawer is counted but told apart', () => {
  /**
   * Petty cash and out-of-pocket are real spending and belong in every total.
   * What they are not is money a till is short of, and a figure that cannot
   * tell the two apart sends somebody looking for cash that was never there.
   */
  const a = analyseExpenses({
    now: [
      spend({ $id: 'a', amount: 10_000 }),
      spend({ $id: 'b', amount: 4_000, from_takings: false }),
    ],
    before: [],
    fromIso: '2026-08-01T00:00:00.000Z',
    toIso: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(a.spend.now, 14_000, 'both are spending');
  assert.equal(a.offDrawer, 4_000, 'only one is off the drawer');
});

test('a day nothing was spent on is a gap, not a missing bar', () => {
  /**
   * A chart that skips its empty days makes a fortnight of nothing look like a
   * busy week, which is the one shape this is meant to reveal.
   */
  const buckets = overTime({
    rows: [spend({ $createdAt: '2026-08-03T10:00:00.000Z', amount: 5_000 })],
    fromIso: '2026-08-01T00:00:00.000Z',
    toIso: '2026-08-05T23:59:59.999Z',
    by: 'day',
  });
  assert.equal(buckets.length, 5);
  assert.deepEqual(buckets.map((b) => b.total), [0, 0, 5_000, 0, 0]);
  assert.equal(buckets[2].bySide.kitchen, 5_000);
});

test('a week always covers the same seven days, whenever it is read', () => {
  // Anchored to the Monday. Buckets that started on "whatever day somebody
  // opened the page" would move every morning and never compare.
  const buckets = overTime({
    rows: [
      spend({ $createdAt: '2026-08-04T10:00:00.000Z', amount: 1_000 }),
      spend({ $createdAt: '2026-08-06T10:00:00.000Z', amount: 2_000 }),
    ],
    fromIso: '2026-08-03T00:00:00.000Z',
    toIso: '2026-08-16T23:59:59.999Z',
    by: 'week',
  });
  assert.equal(buckets[0].total, 3_000, 'both fall in the same week');
  assert.equal(buckets[0].key, '2026-08-03', 'that week begins on the Monday');
});

test('the highlights say the things nobody knew to ask', () => {
  const a = analyseExpenses({
    now: [
      spend({ $id: 'a', category_key: 'transport', amount: 40_000 }),
      spend({ $id: 'b', category_key: 'gas', amount: 5_000 }),
    ],
    before: [
      spend({ $id: 'c', category_key: 'transport', amount: 10_000 }),
      spend({ $id: 'd', category_key: 'repairs', amount: 20_000 }),
    ],
    fromIso: '2026-08-01T00:00:00.000Z',
    toIso: '2026-08-31T23:59:59.999Z',
  });
  const said = highlights(a, money).join(' | ');
  assert.match(said, /transport is up 300%/i);
  assert.match(said, /gas is new this period/i);
  assert.match(said, /Nothing was spent on repairs/i);
  // Nothing has a receipt, and that is worth saying.
  assert.match(said, /has a receipt behind it/i);
});

test('the trades are named the way the rest of the system names them', () => {
  assert.equal(SIDE_WORDS.kitchen, 'Bistro');
  assert.equal(SIDE_WORDS.bar, 'Bar');
  assert.equal(SIDE_WORDS.craft, 'Craft shop');
});
