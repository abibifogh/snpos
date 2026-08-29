import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quantityEditProblem, lineIsEditable, storedUnitPrice, newLineTotal,
  quantityChanges, quantityProblem, moneyEffect, paymentStatusAfter,
} from '../order-edit.ts';
import { retotalOrder } from '../pricing.ts';

const line = (over: Record<string, unknown> = {}) => ({
  $id: 'l1',
  name_snapshot: 'Club sandwich',
  unit_price: 9500,
  qty: 2,
  status: 'served',
  ...over,
}) as Parameters<typeof storedUnitPrice>[0];

const plain = { tax_rate_bp: 0, tax_inclusive: false, service_charge_bp: 0 };
const cash = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

test('add-ons are still priced when the quantity changes', () => {
  /**
   * The line was sold at the item price PLUS whatever was added to it, and the
   * unit price stored on the row is only the first half. Correcting three to
   * two on the item price alone would quietly refund the add-ons as well.
   */
  const withExtras = line({ addons: JSON.stringify([{ price_delta: 500, qty: 2 }, { price_delta: 250 }]) });
  assert.equal(storedUnitPrice(withExtras), 9500 + 1000 + 250);
  assert.equal(newLineTotal(withExtras, 3), (9500 + 1250) * 3);
});

test('a line whose add-ons cannot be read is still correctable', () => {
  /*
    Refusing the whole correction over one unreadable field would leave the
    figures carrying the original error, which is worse than pricing the line
    at the number it was almost certainly sold at.
  */
  assert.equal(storedUnitPrice(line({ addons: 'not json' })), 9500);
});

test('the corrected total goes through the same arithmetic as a fresh bill', () => {
  /**
   * Tax and service charge are worked out from the lines, in a set order, so a
   * corrected bill must not take a shortcut. Two sandwiches down to one, with
   * a service charge on top, is not simply "half".
   */
  const lines = [
    { $id: 'a', unit_price: 9500, qty: 2 },
    { $id: 'b', unit_price: 4000, qty: 1 },
  ];
  const settings = { tax_rate_bp: 1500, tax_inclusive: false, service_charge_bp: 1000 };
  const after = retotalOrder({ lines, quantities: { a: 1 }, settings });

  assert.equal(after.subtotal, 9500 + 4000);
  assert.equal(after.service_total, Math.round(13_500 * 0.1));
  const base = 13_500 + after.service_total;
  assert.equal(after.tax_total, Math.round(base * 0.15));
  assert.equal(after.total, base + after.tax_total);
});

test('a line corrected to nothing leaves the total, but not the order', () => {
  /*
    Nought of something costs nothing, so it drops out of the sum. It is still
    left ON the order at zero rather than deleted, because a line that
    disappears takes with it the fact that it was ever rung up — and that fact
    is the whole point of asking what happened.
  */
  const lines = [{ $id: 'a', unit_price: 9500, qty: 2 }, { $id: 'b', unit_price: 4000, qty: 1 }];
  assert.equal(retotalOrder({ lines, quantities: { a: 0 }, settings: plain }).total, 4000);
});

test('a voided line cannot be brought back by typing a number on it', () => {
  // Un-voiding by the back door is a different decision with a different
  // reason attached, and it must not happen as a side effect of a correction.
  assert.equal(lineIsEditable(line({ status: 'void' })), false);
  const lines = [{ $id: 'a', unit_price: 9500, qty: 0, status: 'void' }];
  assert.equal(retotalOrder({ lines, quantities: { a: 4 }, settings: plain }).total, 0);
});

test('a discount already given survives the correction', () => {
  const lines = [{ $id: 'a', unit_price: 10_000, qty: 3 }];
  const after = retotalOrder({ lines, quantities: { a: 2 }, discount: 1500, settings: plain });
  assert.equal(after.discount_total, 1500);
  assert.equal(after.total, 20_000 - 1500);
});

test('only the quantities that actually moved are reported', () => {
  const lines = [line({ $id: 'a', qty: 2 }), line({ $id: 'b', qty: 1 })];
  const moved = quantityChanges(lines, { a: 1, b: 1 });
  assert.deepEqual(moved.map((c) => [c.lineId, c.from, c.to, c.delta]), [['a', 2, 1, -1]]);
});

test('a maker already credited is not rewritten from a screen', () => {
  /**
   * The one hard refusal. Stock can be put back with a correcting movement,
   * and a payment can be refunded on purpose, but a consignor's credit is
   * somebody's money and it has already been told to them. Changing the sale
   * underneath it would leave their statement and the till disagreeing with
   * nobody told.
   */
  const order = { status: 'SERVED', payment_status: 'paid' };
  const problem = quantityEditProblem(order, { creditedLineIds: ['l1'] });
  assert.match(String(problem), /credited/);
  assert.match(String(problem), /consignor/);
  // And an ordinary bill is not caught by it.
  assert.equal(quantityEditProblem(order), null);
});

test('a cancelled order has nothing to correct', () => {
  assert.match(String(quantityEditProblem({ status: 'CANCELLED', payment_status: 'unpaid' })), /cancelled/);
  assert.match(String(quantityEditProblem({ status: 'REJECTED', payment_status: 'unpaid' })), /cancelled/);
});

test('a typed quantity is checked before it becomes money', () => {
  assert.equal(quantityProblem('3'), null);
  // Zero is a real answer: it was not sold at all.
  assert.equal(quantityProblem('0'), null);
  assert.match(String(quantityProblem('')), /0 if it was not sold/);
  assert.match(String(quantityProblem('2.5')), /Whole numbers/);
  assert.match(String(quantityProblem('-1')), /Whole numbers/);
  assert.match(String(quantityProblem('1000')), /more than anybody ordered/);
});

test('a bill left overpaid says so, because nobody else will', () => {
  /**
   * The quiet failure this exists to prevent. Correcting three coffees to two
   * on a settled bill leaves the customer owed money, and nothing anywhere
   * would have mentioned it — the order would simply have read "paid".
   */
  const words = moneyEffect(9000, 6000, cash);
  assert.match(String(words), /owed GH₵30\.00 back/);
  assert.match(String(words), /record the refund separately/);
});

test('a bill left short says so too, and where it will turn up', () => {
  const words = moneyEffect(6000, 9000, cash);
  assert.match(String(words), /GH₵30\.00 is still owed/);
  assert.match(String(words), /bill still to pay/);
});

test('nothing is said where nothing has changed hands, or nothing is left over', () => {
  assert.equal(moneyEffect(0, 9000, cash), null);
  assert.equal(moneyEffect(9000, 9000, cash), null);
});

test('the payment status follows the new total', () => {
  // A bill corrected downwards past what was taken is fully paid, not partly.
  assert.equal(paymentStatusAfter(9000, 6000), 'paid');
  assert.equal(paymentStatusAfter(6000, 9000), 'partial');
  assert.equal(paymentStatusAfter(9000, 9000), 'paid');
  /*
    Nothing taken means nothing to say. Writing "unpaid" back over "unpaid"
    would put a line in the audit log claiming a change that did not happen.
  */
  assert.equal(paymentStatusAfter(0, 9000), null);
});
