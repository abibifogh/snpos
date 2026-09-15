import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals } from '../pricing.ts';
import { paymentStatusAfter, moneyEffect } from '../order-edit.ts';
import type { Settings } from '../types.ts';

/*
  The arithmetic behind discounting a bill that has already been rung up.

  discountPlacedOrder itself talks to a database, so what is pinned here is
  the part that decides the money: a discount comes off the SUBTOTAL and tax
  and service follow it down. Subtracting it from the total instead — the
  obvious shortcut, and the one the pass would have had to take by hand —
  gives a different and wrong answer, and the difference is money.
*/

const settings = {
  currency_symbol: 'GH₵',
  currency_decimals: 2,
  tax_inclusive: false,
  vat_charged: true,
  tax_rate_bp: 1500,
  service_charge_bp: 0,
} as unknown as Settings;

const lines = [{ key: 'l1', menu_item_id: 'm1', name: 'Jollof', unit_price: 10_000, qty: 1, addons: [] }];

test('a discount comes off the subtotal, and the tax follows it down', () => {
  const full = computeTotals({ lines, discount: 0, settings });
  const cut = computeTotals({ lines, discount: 2_000, settings });

  assert.equal(full.subtotal, 10_000);
  assert.equal(full.tax_total, 1_500, '15% of 100');
  assert.equal(full.total, 11_500);

  assert.equal(cut.discount_total, 2_000);
  assert.equal(cut.tax_total, 1_200, '15% of the 80 that is actually being charged');
  assert.equal(cut.total, 9_200);

  /*
    THE SHORTCUT THAT WOULD HAVE BEEN WRONG. Taking 20 off the total gives
    95, not 92: the customer would be charged tax on money they were never
    asked for, and the books would not agree with the lines.
  */
  assert.notEqual(full.total - 2_000, cut.total);
  assert.equal(full.total - 2_000, 9_500);
});

test('a bill discounted to nothing is a bill that owes nothing', () => {
  const none = computeTotals({ lines, discount: 10_000, settings });
  assert.equal(none.subtotal, 10_000);
  assert.equal(none.discount_total, 10_000);
  assert.equal(none.total, 0, 'and no tax on nothing');
});

test('money already taken decides what the bill becomes', () => {
  // Part-paid by one of four at a table: the rest simply drops.
  assert.equal(paymentStatusAfter(5_000, 9_200), 'partial');
  // Discounted down to exactly what is in the drawer: settled.
  assert.equal(paymentStatusAfter(9_200, 9_200), 'paid');
  // Nothing taken yet is left alone — an unpaid bill is still unpaid.
  assert.equal(paymentStatusAfter(0, 9_200), null);
});

test('below what has already been paid is a refund, and says so', () => {
  /*
    The line discountPlacedOrder refuses to cross. Taking a bill under the
    money already in the drawer is not a discount: somebody has to hand cash
    back, which is a different decision with a different button.
  */
  const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
  const said = moneyEffect(11_500, 9_200, money);
  assert.match(String(said), /owed GH₵23\.00 back/);
  assert.match(String(said), /record the refund separately/);
});
