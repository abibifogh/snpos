import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addonsCharged, rewrittenLines, sizePriceFixes, sizePriceProblem, sizePriceWords, sizePriceDelta,
} from '../size-price.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
const log = (...corrections: string[]) => [{ after: JSON.stringify({ order_no: 'ORD1090', corrections }) }];

const club = {
  $id: 'l1', name_snapshot: 'Club · Large', qty: 1, unit_price: 2_500, line_total: 2_500,
  status: 'queued', variant_id: 'large', addons: '',
};

test('a large Club the server rewrote to the plain price goes back to the size\'s price', () => {
  const fixes = sizePriceFixes([club], { large: 3_000 }, rewrittenLines(log('Club · Large: sent 3000, actual 2500')));
  assert.deepEqual(fixes, [{ lineId: 'l1', name: 'Club · Large', qty: 1, fromTotal: 2_500, toUnit: 3_000, toTotal: 3_000 }]);
  assert.equal(sizePriceWords(fixes[0]!, money), '1× Club · Large: GH₵25.00 → GH₵30.00');
  assert.equal(sizePriceDelta(fixes), 500);
});

test('quantity and the choices as they were charged are kept', () => {
  const line = { ...club, qty: 2, line_total: 5_400, addons: JSON.stringify([{ option_id: 'ice', price_delta: 200, qty: 1 }]) };
  const [fix] = sizePriceFixes([line], { large: 3_000 }, ['Club · Large']);
  assert.equal(fix?.toUnit, 3_200);
  assert.equal(fix?.toTotal, 6_400);
});

test('without the server\'s own record of a rewrite, nothing is offered', () => {
  // A size charged below today's price may just be a price that went up since.
  assert.deepEqual(sizePriceFixes([club], { large: 3_000 }, []), []);
  assert.deepEqual(rewrittenLines(log('Club · Large: sent 2500, actual 2500')), []);
  assert.deepEqual(rewrittenLines([{ after: 'not json' }]), []);
});

test('lines already right, voided, repriced by hand, unsized or unreadable are left alone', () => {
  const names = ['Club · Large'];
  assert.deepEqual(sizePriceFixes([{ ...club, line_total: 3_000 }], { large: 3_000 }, names), [], 'already put right');
  assert.deepEqual(sizePriceFixes([{ ...club, status: 'void' }], { large: 3_000 }, names), []);
  assert.deepEqual(sizePriceFixes([{ ...club, list_price: 3_000 }], { large: 3_000 }, names), []);
  assert.deepEqual(sizePriceFixes([{ ...club, variant_id: '' }], { large: 3_000 }, names), []);
  assert.deepEqual(sizePriceFixes([club], {}, names), [], 'size could not be read');
  assert.deepEqual(sizePriceFixes([{ ...club, addons: '{oops' }], { large: 3_000 }, names), []);
  assert.equal(addonsCharged('{oops'), null);
});

test('only a bill nobody has paid anything on can be repriced', () => {
  assert.equal(sizePriceProblem({ status: 'SERVED', payment_status: 'unpaid' }, 0), null);
  assert.match(sizePriceProblem({ status: 'SERVED', payment_status: 'paid' }, 2_500) ?? '', /already been taken/);
  assert.match(sizePriceProblem({ status: 'SERVED', payment_status: 'unpaid' }, 1_000) ?? '', /already been taken/);
  assert.match(sizePriceProblem({ status: 'CANCELLED', payment_status: 'unpaid' }, 0) ?? '', /cancelled/);
});
