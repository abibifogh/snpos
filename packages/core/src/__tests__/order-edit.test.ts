import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quantityEditProblem, lineIsEditable, lineEditProblem, removalEffects, storedUnitPrice, newLineTotal,
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
  const credited = new Set(['l1']);
  const line = { $id: 'l1', name_snapshot: 'Basket', unit_price: 100, qty: 1, status: 'queued' };
  assert.equal(lineIsEditable(line, credited), false);
  const problem = String(lineEditProblem(line, credited));
  assert.match(problem, /credited/);
  assert.match(problem, /consignor/);
});

test('but one credited piece no longer locks the whole bill', () => {
  /**
   * The reported gap. One basket on a bill of six refused the lot, so the way
   * to take a mis-rung jollof off that table was to cancel the whole order and
   * ring it again — which nobody does, so the figures kept the error. That is
   * the reasoning this file opens with, applied to the wrong thing.
   */
  const order = { status: 'SERVED', payment_status: 'paid' };
  const lines = [
    { $id: 'l1', name_snapshot: 'Basket', unit_price: 100, qty: 1, status: 'queued' },
    { $id: 'l2', name_snapshot: 'Jollof rice', unit_price: 8000, qty: 1, status: 'queued' },
  ];
  assert.equal(quantityEditProblem(order, { creditedLineIds: ['l1'], lines }), null);
  // And the credited line is still out of reach, on its own.
  const credited = new Set(['l1']);
  assert.deepEqual(
    quantityChanges(lines, { l1: 0, l2: 0 }, credited).map((c) => c.lineId),
    ['l2'],
  );
});

test('a bill with nothing changeable left says so once', () => {
  // Rather than offering an editor where every row refuses.
  const order = { status: 'SERVED', payment_status: 'paid' };
  const lines = [
    { $id: 'l1', name_snapshot: 'Basket', unit_price: 100, qty: 1, status: 'queued' },
    { $id: 'l2', name_snapshot: 'Bowl', unit_price: 100, qty: 1, status: 'void' },
  ];
  assert.match(
    String(quantityEditProblem(order, { creditedLineIds: ['l1'], lines })),
    /nothing here that can be changed/,
  );
});

test('taking a line off says what it does before it does it', () => {
  /**
   * Every one of these is a consequence somebody has been surprised by, and
   * the surprise always arrives later — at a count, at a close, or in the
   * books a month on.
   */
  const said = removalEffects({
    removed: ['Jollof rice'],
    newTotal: 7000,
    taken: 15000,
    shiftClosed: true,
    format: (n) => `GHS ${(n / 100).toFixed(2)}`,
  }).join(' ');
  assert.match(said, /Jollof rice comes off the bill/);
  assert.match(said, /goes back/);
  assert.match(said, /already closed/);
  assert.match(said, /GHS 80.00 has been taken against this bill and is now owed back/);
  assert.match(said, /stays on the bill at nothing/);
});

test('on an open shift it says the shift expects less, not that it was reposted', () => {
  const said = removalEffects({
    removed: ['Club'], newTotal: 0, taken: 0, shiftClosed: false, format: (n) => String(n),
  }).join(' ');
  assert.match(said, /expects less money/);
  assert.doesNotMatch(said, /owed back/);
});

test('changing a quantity without removing anything says none of that', () => {
  assert.deepEqual(removalEffects({
    removed: [], newTotal: 100, taken: 100, shiftClosed: true, format: String,
  }), []);
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
