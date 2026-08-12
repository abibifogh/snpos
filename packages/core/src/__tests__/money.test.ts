import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSale, rateFor, balanceOf, buildStatement, onHandFor } from '../consignment-math.ts';
import { computeTotals } from '../pricing.ts';
import { sharesFor } from '../money.ts';
import type { CartLine } from '../pricing.ts';

const line = (over: Partial<CartLine> = {}): CartLine => ({
  key: 'k', menu_item_id: 'm', name: 'Thing', unit_price: 1000, qty: 1, addons: [], ...over,
});

test('splitSale never loses a pesewa, at any price or rate', () => {
  for (let gross = 0; gross <= 5000; gross += 7) {
    for (const bp of [0, 1, 999, 2500, 3000, 3333, 5000, 6667, 9999, 10000]) {
      const s = splitSale(gross, bp);
      assert.equal(s.commission + s.consignor, gross, `${gross} @ ${bp}bp must add back up`);
      assert.ok(s.commission >= 0 && s.consignor >= 0, 'neither side may go negative');
    }
  }
});

test('splitSale clamps a nonsense rate rather than inventing money', () => {
  assert.equal(splitSale(1000, -500).commission, 0);
  assert.equal(splitSale(1000, 99999).consignor, 0);
  assert.equal(splitSale(1000, 99999).commission, 1000);
});

test('splitSale at the two ends', () => {
  assert.deepEqual(splitSale(1000, 0), { gross: 1000, commission: 0, consignor: 1000, bp: 0 });
  assert.deepEqual(splitSale(1000, 10000), { gross: 1000, commission: 1000, consignor: 0, bp: 10000 });
});

test('rateFor prefers the piece, then the maker, then the shop', () => {
  assert.equal(rateFor({ commission_bp: 1000 }, { commission_bp: 2000 }, { default_commission_bp: 3000 }), 1000);
  assert.equal(rateFor({}, { commission_bp: 2000 }, { default_commission_bp: 3000 }), 2000);
  assert.equal(rateFor({}, {}, { default_commission_bp: 3000 }), 3000);
  assert.equal(rateFor({}, {}, {}), 3000, 'falls back to 30% rather than to nothing');
  // Zero is a real rate, not a missing one.
  assert.equal(rateFor({ commission_bp: 0 }, { commission_bp: 2000 }, null), 0);
  assert.equal(rateFor({ commission_bp: null }, null, null), 3000);
});

test('a statement adds up on its own', () => {
  const entries = [
    { entry_at: '2026-01-15T10:00:00.000Z', kind: 'sale' as const, amount: 700, gross: 1000, commission: 300, qty: 1 },
    { entry_at: '2026-02-10T10:00:00.000Z', kind: 'sale' as const, amount: 350, gross: 500, commission: 150, qty: 1 },
    { entry_at: '2026-02-20T10:00:00.000Z', kind: 'payout' as const, amount: -1000 },
  ];
  const st = buildStatement({ name: 'Ako' }, entries, new Date('2026-02-01'), new Date('2026-02-28'));

  assert.equal(st.openingBalance, 700, 'January is before the window and forms the opening');
  assert.equal(st.closingBalance, 700 + 350 - 1000);
  assert.equal(st.openingBalance + st.lines.reduce((n, l) => n + l.amount, 0), st.closingBalance);
  assert.equal(st.paidOut, 1000, 'a payout is reported as the positive amount handed over');
  assert.equal(st.earned, 350);
  assert.equal(st.consignor.name, 'Ako', 'the consignor is carried through untouched');
});

test('a statement includes the last day of the period', () => {
  const late = [{ entry_at: '2026-03-31T23:30:00.000Z', kind: 'sale' as const, amount: 500 }];
  const st = buildStatement(null, late, new Date('2026-03-01'), new Date('2026-03-31'));
  assert.equal(st.lines.length, 1, 'the 31st belongs to March');
  assert.equal(st.closingBalance, 500);
});

test('an empty period still balances', () => {
  const st = buildStatement(null, [], new Date('2026-05-01'), new Date('2026-05-31'));
  assert.equal(st.lines.length, 0);
  assert.equal(st.openingBalance, 0);
  assert.equal(st.closingBalance, 0);
});

test('balanceOf sums signed entries', () => {
  assert.equal(balanceOf([{ amount: 500 }, { amount: -200 }, { amount: 0 }]), 300);
  assert.equal(balanceOf([]), 0);
});

test('on-hand comes from the variants when there are any', () => {
  assert.equal(onHandFor({ on_hand: 9 }, []), 9, 'no variants, the product carries the count');
  assert.equal(onHandFor({ on_hand: 9 }, [{ on_hand: 2, active: true }, { on_hand: 3, active: true }]), 5);
  assert.equal(
    onHandFor({ on_hand: 9 }, [{ on_hand: 2, active: true }, { on_hand: 99, active: false }]),
    2,
    'a retired size is not on the shelf',
  );
});

test('totals: tax added on top', () => {
  const t = computeTotals({
    lines: [line({ unit_price: 1000, qty: 2 })],
    settings: { tax_rate_bp: 1500, tax_inclusive: false, service_charge_bp: 0 } as never,
  });
  assert.equal(t.subtotal, 2000);
  assert.equal(t.tax_total, 300);
  assert.equal(t.total, 2300);
});

test('totals: tax already inside the price', () => {
  const t = computeTotals({
    lines: [line({ unit_price: 1150 })],
    settings: { tax_rate_bp: 1500, tax_inclusive: true, service_charge_bp: 0 } as never,
  });
  assert.equal(t.total, 1150, 'an inclusive price is what the customer pays');
  assert.equal(t.tax_total, 150);
});

test('totals: a discount reduces the tax and service with it', () => {
  const t = computeTotals({
    lines: [line({ unit_price: 2000 })],
    discount: 1000,
    settings: { tax_rate_bp: 1000, tax_inclusive: false, service_charge_bp: 1000 } as never,
  });
  assert.equal(t.service_total, 100, 'service is charged on the discounted figure');
  assert.equal(t.total, 1000 + 100 + 110);
});

test('a tender split across bills always adds back to what was taken', () => {
  // The awkward case: three equal bills and a hundred. Thirds do not divide,
  // and a naive split loses a pesewa every single time.
  const bills = [{ total: 3334 }, { total: 3333 }, { total: 3333 }];
  const shares = sharesFor(bills, 10000);
  assert.equal(shares.reduce((a, b) => a + b, 0), 10000);

  // Part payments too. Nothing about taking half changes the rule.
  for (const taken of [1, 7, 99, 4999, 10000]) {
    assert.equal(sharesFor(bills, taken).reduce((a, b) => a + b, 0), taken, `taken ${taken}`);
  }
});

test('one bill takes the whole tender, and no bills take nothing', () => {
  assert.deepEqual(sharesFor([{ total: 2500 }], 2500), [2500]);
  assert.deepEqual(sharesFor([{ total: 2500 }], 1000), [1000], 'a part payment on a single bill');
  assert.deepEqual(sharesFor([], 5000), []);
});

test('a bill list totalling nothing does not divide by zero', () => {
  const shares = sharesFor([{ total: 0 }, { total: 0 }], 500);
  assert.equal(shares.reduce((a, b) => a + b, 0), 500);
  assert.ok(shares.every((n) => Number.isFinite(n)));
});
