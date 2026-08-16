import test from 'node:test';
import assert from 'node:assert/strict';
import { owedBreakdown } from '../consignment-math.ts';
import { splitSale, rateFor, flatFor, dueFor, balanceOf, buildStatement, onHandFor } from '../consignment-math.ts';
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
  assert.deepEqual(splitSale(1000, 0), { gross: 1000, commission: 0, consignor: 1000, bp: 0, flat: 0 });
  assert.deepEqual(splitSale(1000, 10000), { gross: 1000, commission: 1000, consignor: 0, bp: 10000, flat: 0 });
});

test('a flat commission is taken per piece, and beats the percentage', () => {
  // Two cedis a basket at 30%: the flat wins, three baskets, six cedis.
  const three = splitSale(9000, 3000, 200, 3);
  assert.equal(three.commission, 600);
  assert.equal(three.consignor, 8400);
  assert.equal(three.flat, 200);

  // The percentage still applies when no flat is set.
  assert.equal(splitSale(9000, 3000, 0, 3).commission, 2700);
});

test('a flat commission can never leave the maker owing the shop', () => {
  // Two cedis due on a piece discounted to one. The shop takes the sale, not
  // more than the sale.
  const tiny = splitSale(100, 3000, 200, 1);
  assert.equal(tiny.commission, 100);
  assert.equal(tiny.consignor, 0);
  assert.ok(tiny.consignor >= 0);

  // A free line, however it happens, is not a debt either.
  const free = splitSale(0, 3000, 200, 2);
  assert.equal(free.commission, 0);
  assert.equal(free.consignor, 0);
});

test('flatFor prefers the piece, then the maker, and zero means no flat', () => {
  assert.equal(flatFor({ commission_flat: 150 }, { commission_flat: 300 }), 150);
  assert.equal(flatFor({}, { commission_flat: 300 }), 300);
  assert.equal(flatFor({ commission_flat: 0 }, { commission_flat: 300 }), 300, 'zero on the piece is not an override');
  assert.equal(flatFor({}, {}), 0);
  assert.equal(flatFor(null, null), 0);
});

test('what a piece is worth to the maker before anything sells', () => {
  assert.equal(dueFor(1000, 3000), 700);
  assert.equal(dueFor(1000, 3000, 200), 800, 'a flat amount comes off instead of the share');
  assert.equal(dueFor(100, 3000, 200), 0, 'never below nothing');
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

test('a statement separates the four questions a maker actually asks', () => {
  const entries = [
    { entry_at: '2026-02-10T10:00:00.000Z', kind: 'sale' as const, amount: 700, gross: 1000, commission: 300, qty: 1 },
    { entry_at: '2026-02-14T10:00:00.000Z', kind: 'sale' as const, amount: 350, gross: 500, commission: 150, qty: 2 },
    { entry_at: '2026-02-20T10:00:00.000Z', kind: 'payout' as const, amount: -800, description: 'Paid momo' },
    { entry_at: '2026-02-22T10:00:00.000Z', kind: 'fee' as const, amount: -50, description: 'Label printing' },
  ];
  const intakes = [
    { received_at: '2026-02-01T09:00:00.000Z', reference: 'INT-0009', piece_count: 6, total_due: 4200 },
    // Outside the window. A statement for February is February.
    { received_at: '2026-01-05T09:00:00.000Z', reference: 'INT-0008', piece_count: 3, total_due: 2100 },
  ];
  const unsold = [{ name: 'Woven basket', qty: 4, value: 2800 }];

  const st = buildStatement(
    { name: 'Ama' },
    entries,
    new Date('2026-02-01'),
    new Date('2026-02-28'),
    { intakes, unsold },
  );

  assert.equal(st.broughtIn.lines.length, 1, 'only deliveries inside the window');
  assert.equal(st.broughtIn.pieces, 6);
  assert.equal(st.broughtIn.value, 4200);

  assert.equal(st.sold.length, 2);
  assert.equal(st.soldCount, 3, 'quantities, not rows');
  assert.equal(st.earned, 1050);

  assert.equal(st.payments.length, 1);
  assert.equal(st.paidOut, 800, 'reported as the positive amount handed over');

  assert.equal(st.other.length, 1, 'a fee is neither a sale nor a payment');
  assert.equal(st.unsold.pieces, 4);
  assert.equal(st.unsold.value, 2800);

  // The balance is still the ledger and only the ledger. Deliveries and unsold
  // stock are not money and must never touch it.
  assert.equal(st.closingBalance, 700 + 350 - 800 - 50);
});

test('a statement with nothing extra is the statement it always was', () => {
  const entries = [
    { entry_at: '2026-02-10T10:00:00.000Z', kind: 'sale' as const, amount: 700, gross: 1000, commission: 300, qty: 1 },
  ];
  const st = buildStatement({ name: 'Ama' }, entries, new Date('2026-02-01'), new Date('2026-02-28'));
  assert.equal(st.broughtIn.pieces, 0);
  assert.equal(st.broughtIn.value, 0);
  assert.equal(st.unsold.pieces, 0);
  assert.equal(st.closingBalance, 700);
});

test('the owed figure and its breakdown are the same sum', () => {
  /**
   * The whole reason this takes no date range. A statement for a period can
   * exclude the very entry that explains the figure on the list, and then two
   * screens disagree with nothing to say which is right. Here the running
   * balance on the newest row IS the number that was clicked, by construction.
   */
  const entries = [
    { entry_at: '2026-03-01', kind: 'sale' as const, amount: 7000, description: 'Basket' },
    { entry_at: '2026-01-10', kind: 'sale' as const, amount: 5000, description: 'Mat' },
    { entry_at: '2026-02-01', kind: 'payout' as const, amount: -5000, description: 'Paid by momo' },
  ];
  const { lines, balance } = owedBreakdown(entries);

  assert.equal(balance, 7000);
  // Newest first, because the entry somebody is asking about is nearly always
  // the most recent one.
  assert.deepEqual(lines.map((l) => l.entry.entry_at), ['2026-03-01', '2026-02-01', '2026-01-10']);
  // The running balance is still worked out oldest-first, or every row would
  // show the wrong total.
  assert.deepEqual(lines.map((l) => l.runningBalance), [7000, 0, 5000]);
  assert.equal(lines[0].runningBalance, balance, 'the top row is the figure on the list');
});

test('an account with nothing on it owes nothing, and says so as nothing', () => {
  const { lines, balance } = owedBreakdown([]);
  assert.deepEqual(lines, []);
  assert.equal(balance, 0);
});
