import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findCode, codeProblem, discountAmount, needsManager, discountLabelFor,
} from '../discount-codes.ts';
import type { DiscountRow } from '../discount-codes.ts';

const base = (over: Partial<DiscountRow> = {}): DiscountRow => ({
  $id: 'd1',
  name: 'Opening week',
  code: 'OPEN10',
  kind: 'percent',
  value: 1000,           // 10%
  min_order_total: 0,
  staff_applicable: true,
  requires_manager: false,
  used_count: 0,
  active: true,
  ...over,
});

// A Monday at 14:30 local.
const monday = new Date(2026, 7, 17, 14, 30);

test('a code is found however it was typed', () => {
  const rows = [base()];
  assert.equal(findCode(rows, 'open10')?.$id, 'd1');
  assert.equal(findCode(rows, '  OPEN10 ')?.$id, 'd1');
  assert.equal(findCode(rows, 'OPEN11'), null);
  assert.equal(findCode(rows, ''), null, 'an empty box is not a match for everything');
});

test('an unknown code says what to do rather than just "invalid"', () => {
  const said = codeProblem(null, { subtotal: 5000, at: monday }) ?? '';
  assert.match(said, /Check the spelling/);
});

test('a good code on a good basket has nothing to say', () => {
  assert.equal(codeProblem(base(), { subtotal: 5000, at: monday }), null);
});

test('a switched-off code is refused by name', () => {
  assert.match(codeProblem(base({ active: false }), { subtotal: 5000, at: monday }) ?? '', /switched off/);
});

test('a customers-only code is not a till code', () => {
  const said = codeProblem(base({ staff_applicable: false }), { subtotal: 5000, at: monday }) ?? '';
  assert.match(said, /customers ordering themselves/);
});

test('dates are honoured at both ends', () => {
  const early = base({ starts_at: '2026-09-01T00:00:00.000Z' });
  assert.match(codeProblem(early, { subtotal: 5000, at: monday }) ?? '', /does not start until/);
  const done = base({ ends_at: '2026-08-01T00:00:00.000Z' });
  assert.match(codeProblem(done, { subtotal: 5000, at: monday }) ?? '', /ended on/);
});

test('a code for certain days is refused on the others, by name', () => {
  const weekend = base({ days_of_week: ['sat', 'sun'] });
  assert.match(codeProblem(weekend, { subtotal: 5000, at: monday }) ?? '', /only runs on sat, sun/);
  const mondays = base({ days_of_week: ['mon'] });
  assert.equal(codeProblem(mondays, { subtotal: 5000, at: monday }), null);
});

test('a happy hour holds inside its window and not outside', () => {
  const happy = base({ time_start: '17:00', time_end: '19:00' });
  assert.match(codeProblem(happy, { subtotal: 5000, at: monday }) ?? '', /between 17:00 and 19:00/);
  const evening = new Date(2026, 7, 17, 18, 0);
  assert.equal(codeProblem(happy, { subtotal: 5000, at: evening }), null);
});

test('a window that wraps midnight is a real thing a late bar sets', () => {
  const late = base({ time_start: '22:00', time_end: '02:00' });
  assert.equal(codeProblem(late, { subtotal: 5000, at: new Date(2026, 7, 17, 23, 30) }), null);
  assert.equal(codeProblem(late, { subtotal: 5000, at: new Date(2026, 7, 17, 1, 0) }), null);
  assert.match(codeProblem(late, { subtotal: 5000, at: monday }) ?? '', /between 22:00 and 02:00/);
});

test('a minimum basket is checked before it is applied', () => {
  const big = base({ min_order_total: 10_000 });
  assert.match(codeProblem(big, { subtotal: 5000, at: monday }) ?? '', /at least 100.00/);
  assert.equal(codeProblem(big, { subtotal: 10_000, at: monday }), null, 'exactly the minimum qualifies');
});

test('a code with a use limit stops when it is spent', () => {
  const spent = base({ usage_limit_total: 50, used_count: 50 });
  assert.match(codeProblem(spent, { subtotal: 5000, at: monday }) ?? '', /full 50 times/);
  const left = base({ usage_limit_total: 50, used_count: 49 });
  assert.equal(codeProblem(left, { subtotal: 5000, at: monday }), null);
});

test('a free-item offer says the till cannot do it rather than doing it wrong', () => {
  const freebie = base({ kind: 'free_item' });
  assert.match(codeProblem(freebie, { subtotal: 5000, at: monday }) ?? '', /cannot apply yet/);
});

test('a percentage comes off, and a flat amount comes off', () => {
  assert.equal(discountAmount(base(), 5000), 500, '10% of 50.00');
  assert.equal(discountAmount(base({ kind: 'amount', value: 750 }), 5000), 750);
});

test('a cap stops a promotion meant for a small basket paying out on a large one', () => {
  const capped = base({ value: 2000, max_discount_amount: 500 });
  assert.equal(discountAmount(capped, 100_000), 500, '20% would be 200.00, capped at 5.00');
  assert.equal(discountAmount(capped, 1000), 200, 'under the cap, the percentage stands');
});

test('a discount never exceeds the basket it is taken off', () => {
  assert.equal(discountAmount(base({ kind: 'amount', value: 9999 }), 1000), 1000);
  assert.equal(discountAmount(base(), 0), 0);
});

test('a manager is needed when the offer says so, or when it is over the cashier', () => {
  const flagged = base({ requires_manager: true });
  assert.match(needsManager(flagged, { subtotal: 5000, at: monday, ceilingBp: 10_000 }) ?? '', /needs a manager/);

  // 10% off, and this cashier may authorise 5%.
  const said = needsManager(base(), { subtotal: 5000, at: monday, ceilingBp: 500 }) ?? '';
  assert.match(said, /comes to 10%/);
  assert.match(said, /authorise 5%/);

  assert.equal(needsManager(base(), { subtotal: 5000, at: monday, ceilingBp: 1000 }), null, 'exactly at the limit is fine');
});

test('the bill says which offer it was', () => {
  assert.equal(discountLabelFor(base()), 'Opening week (OPEN10)');
  assert.equal(discountLabelFor(base({ code: undefined })), 'Opening week');
});
