import test from 'node:test';
import assert from 'node:assert/strict';
import { makersShareOf, splitSale } from '../consignment-math.ts';

const makers = [
  { $id: 'ama', commission_bp: 3000 },
  { $id: 'kofi', commission_bp: 2000, commission_flat: 500 },
];

test('the makers are owed everything the shop does not keep', () => {
  /*
    A consigned piece is not the shop's. Crediting the whole sale to sales
    overstated the shop's income by every maker's share, and the payouts had
    nowhere to go.
  */
  const share = makersShareOf([
    { consignor_id: 'ama', line_total: 20_000, qty: 2 },
    { consignor_id: 'kofi', line_total: 3_000, qty: 1 },
  ], makers, { default_commission_bp: 3000 });
  // Ama: 30% commission on 20,000 → 14,000 hers. Kofi: flat 500 → 2,500 his.
  assert.equal(share, 16_500);
});

test('the shop’s own pieces contribute nothing', () => {
  assert.equal(makersShareOf([{ consignor_id: '', line_total: 5_000 }], makers), 0);
  assert.equal(makersShareOf([], makers), 0);
});

test('the line’s own rate wins over the maker’s, as it does on the statement', () => {
  // The same three-way lookup the server uses when it credits a maker, so
  // the books and the statement cannot disagree about one sale.
  const share = makersShareOf([{ consignor_id: 'ama', line_total: 10_000, commission_bp: 5000 }], makers);
  assert.equal(share, splitSale(10_000, 5000).consignor);
  assert.equal(share, 5_000);
});

test('a maker not on the list still gets the shop default', () => {
  assert.equal(makersShareOf([{ consignor_id: 'gone', line_total: 1_000 }], [], { default_commission_bp: 2500 }), 750);
});
