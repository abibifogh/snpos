import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kindOf, countedByKind, rangeTotals, kindsWorthShowing, MONEY_KINDS,
  type TotalledShift, type KindedMethod,
} from '../shift-totals.ts';

const methods: KindedMethod[] = [
  { $id: 'm-cash', kind: 'cash' },
  { $id: 'm-card', kind: 'card' },
  { $id: 'm-momo', kind: 'mobile_money' },
];

const shift = (over: Partial<TotalledShift> = {}): TotalledShift => ({
  $id: 's1', status: 'closed', sales_total: 0, ...over,
});

test('a method that has since been deleted lands in Other, not in nothing', () => {
  // Money that came in really came in. A total quietly missing a retired card
  // machine is worse than one with a line called Other on it.
  assert.equal(kindOf('m-cash', methods), 'cash');
  assert.equal(kindOf('gone', methods), 'other');
  // An unrecognised kind is not trusted into a bucket it does not belong in.
  assert.equal(kindOf('x', [{ $id: 'x', kind: 'crypto' }]), 'other');
});

test('the totals are built from what was counted, never from what was expected', () => {
  /**
   * Expected is what the records say should have been in the drawer; counted
   * is what somebody's hand found in it. Adding up the expected figures gives
   * a week that always balances perfectly, which is a comforting number and a
   * useless one.
   */
  const rows = [
    shift({ $id: 'a', counted: '{"m-cash":40000,"m-card":15000}', expected: '{"m-cash":99999}' }),
    shift({ $id: 'b', counted: '{"m-cash":20000,"m-momo":5000}' }),
  ];
  assert.deepEqual(countedByKind(rows, methods), {
    cash: 60_000, card: 15_000, mobile_money: 5_000, other: 0,
  });
});

test('a shift still open is counted by nobody and adds nothing', () => {
  // A total that quietly included tonight's half-finished takings would change
  // every time somebody refreshed the page.
  const totals = rangeTotals({
    shifts: [
      shift({ $id: 'a', counted: '{"m-cash":10000}', sales_total: 12_000 }),
      shift({ $id: 'b', status: 'open', counted: '{"m-cash":99999}', sales_total: 50_000 }),
    ],
    methods,
    expenses: [],
  });
  assert.equal(totals.shifts, 2);
  assert.equal(totals.closed, 1);
  assert.equal(totals.open, 1);
  assert.equal(totals.counted.cash, 10_000);
  assert.equal(totals.sales, 12_000);
});

test('spending comes from the expense rows, not the snapshot on the shift', () => {
  /**
   * `expense_total` is written at close, and an expense reclassified afterwards
   * does not change it. The rows are the truth.
   */
  const totals = rangeTotals({
    shifts: [shift({ $id: 'a', expense_total: 999 })],
    methods,
    expenses: [
      { shift_id: 'a', amount: 3_000 },
      { shift_id: 'a', amount: 1_500 },
      // Belongs to a shift outside this range; must not be added in.
      { shift_id: 'elsewhere', amount: 90_000 },
      // Recorded outside any shift at all.
      { amount: 700 },
    ],
  });
  assert.equal(totals.expenses, 4_500);
});

test('over and short are summed across the range, keeping their signs', () => {
  // A night 500 over and a night 500 short is a range that balances, and
  // saying so is more useful than reporting 1,000 of movement.
  const totals = rangeTotals({
    shifts: [
      shift({ $id: 'a', variance: '{"m-cash":500}' }),
      shift({ $id: 'b', variance: '{"m-cash":-500}' }),
    ],
    methods,
    expenses: [],
  });
  assert.equal(totals.variance, 0);
});

test('a count that will not parse is left out rather than read as nought', () => {
  // It is not a count of nothing; it is a row that cannot be read, and adding
  // a wrong figure to the totals is worse than being one row short.
  const totals = rangeTotals({
    shifts: [shift({ $id: 'a', counted: 'not json', variance: '{{' })],
    methods,
    expenses: [],
  });
  assert.equal(totals.countedTotal, 0);
  assert.equal(totals.variance, 0);
});

test('columns nobody uses are not shown, but cash always is', () => {
  /**
   * A business that has never taken a card should not be shown a Card column
   * reading nought for ever. Cash always shows: a total without it looks
   * broken rather than empty.
   */
  assert.deepEqual(kindsWorthShowing({ cash: 0, card: 0, mobile_money: 0, other: 0 }), ['cash']);
  assert.deepEqual(
    kindsWorthShowing({ cash: 100, card: 0, mobile_money: 50, other: 0 }),
    ['cash', 'mobile_money'],
  );
  assert.equal(MONEY_KINDS.length, 4);
});
