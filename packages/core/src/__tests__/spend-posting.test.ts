import test from 'node:test';
import assert from 'node:assert/strict';
import { spendDebits, spendPostingLines, sameDebits } from '../spend-posting.ts';

const STOCK = ['1200', '1210', '1220'];
const bar = (over: Partial<Parameters<typeof spendDebits>[0]> = {}) => spendDebits({
  amount: 27_620,
  lines: [
    { stocked: true, lineTotal: 24_000 },
    { stocked: true, lineTotal: 3_600 },
    { stocked: false, lineTotal: 20 },
  ],
  stockAccount: '1210',
  categoryAccount: '6010',
  fallbackAccount: '6090',
  stockAccounts: STOCK,
  ...over,
});

test('what went on the shelf is stock; what did not is spent', () => {
  /*
    The fault this exists for. A market run filed under "Supplies" was charged
    to expenses on the day and again as cost of sales at close, and the stock
    line on the balance sheet drifted negative every time.
  */
  assert.deepEqual(bar().map((d) => [d.account_code, d.amount]), [['1210', 27_600], ['6010', 20]]);
});

test('a spend with no lines is all the category, as it always was', () => {
  assert.deepEqual(
    spendDebits({ amount: 120, lines: [], stockAccount: '1200', categoryAccount: '6010', fallbackAccount: '6090', stockAccounts: STOCK }),
    [{ account_code: '6010', amount: 120, memo: 'Money paid out' }],
  );
});

test('a total typed above its lines still balances, and the difference is spent', () => {
  // The forms add the remainder on as "not itemised". Money that left and is
  // on no shelf is an overhead, whatever the cashier called it.
  const debits = bar({ amount: 28_000 });
  assert.deepEqual(debits.map((d) => [d.account_code, d.amount]), [['1210', 27_600], ['6010', 400]]);
});

test('a shelf cannot receive more than was paid', () => {
  // A line typed dearer than the total is a typing mistake; the total wins.
  const debits = bar({ amount: 20_000 });
  assert.deepEqual(debits.map((d) => [d.account_code, d.amount]), [['1210', 20_000]]);
});

test('an old stock category cannot carry the remainder to the balance sheet', () => {
  /*
    Rows from before this rule were filed under "Bar stock", which points at
    inventory. Money that was not itemised is on no shelf, so it goes to Other
    rather than inflating stock the business does not have.
  */
  const debits = bar({ categoryAccount: '1210' });
  assert.deepEqual(debits.map((d) => [d.account_code, d.amount]), [['1210', 27_600], ['6090', 20]]);
});

test('nothing to post is an empty list, not a zero line', () => {
  assert.deepEqual(spendDebits({ amount: 0, lines: [], stockAccount: '1200', categoryAccount: '6010', fallbackAccount: '6090', stockAccounts: STOCK }), []);
});

test('the posting balances: every debit, one credit for the lot', () => {
  const lines = spendPostingLines(bar(), '1000');
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  assert.equal(debit, credit);
  assert.equal(lines.at(-1)?.account_code, '1000');
  assert.equal(lines.at(-1)?.credit, 27_620);
});

test('the same posting is the same posting whatever order it was written in', () => {
  const a = bar();
  const b = [...a].reverse().map((d) => ({ ...d, memo: 'reworded' }));
  assert.equal(sameDebits(a, b), true);
  assert.equal(sameDebits(a, bar({ amount: 30_000 })), false);
});
