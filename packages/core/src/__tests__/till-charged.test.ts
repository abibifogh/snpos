import test from 'node:test';
import assert from 'node:assert/strict';
import { restorePlan, rewritesByOrder, restoreWords } from '../till-charged.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
const log = (orderId: string, ...corrections: string[]) => ({ entity_id: orderId, after: JSON.stringify({ corrections }) });
const order = (over: Record<string, unknown> = {}) => ({
  $id: 'o1', order_no: 'ORD1070', status: 'CLOSED', channel: 'counter', total: 2_500, shift_id: 'sh1', ...over,
});
const line = (over: Record<string, unknown> = {}) => ({
  $id: 'l1', order_id: 'o1', name_snapshot: 'Club · Large', qty: 1, line_total: 2_500, status: 'served', ...over,
});
const paid = (amount: number, over: Record<string, unknown> = {}) => ({ order_id: 'o1', amount, ...over });

test('a Club · Large the till charged GH₵30 for, paid GH₵30, goes back to GH₵30', () => {
  const plan = restorePlan({
    logs: [log('o1', 'Club · Large: sent 3000, actual 2500')],
    orders: [order()], lines: [line()], payments: [paid(3_000)],
  });
  assert.deepEqual(plan, [{
    lineId: 'l1', orderId: 'o1', orderNo: 'ORD1070', shiftId: 'sh1', name: 'Club · Large', qty: 1, from: 2_500, to: 3_000,
  }]);
  assert.match(restoreWords(plan, money), /^1 bill, 1 sold \(Club · Large\), GH₵5\.00 of sales/);
});

test('any product, several on a line, several lines on a bill', () => {
  const plan = restorePlan({
    logs: [log('o1', 'Club · Large: sent 9000, actual 7500', 'Kelewele: sent 4000, actual 3500')],
    orders: [order({ total: 11_000 })],
    lines: [line({ qty: 3, line_total: 7_500 }), line({ $id: 'l2', name_snapshot: 'Kelewele', line_total: 3_500 })],
    payments: [paid(10_000), paid(3_000)],
  });
  assert.deepEqual(plan.map((p) => [p.name, p.from, p.to]), [['Club · Large', 7_500, 9_000], ['Kelewele', 3_500, 4_000]]);
});

test('nothing is put back that the payments do not vouch for', () => {
  const base = { logs: [log('o1', 'Club · Large: sent 3000, actual 2500')], lines: [line()] };
  // Paid at the lower figure: that customer was charged less, truthfully.
  assert.deepEqual(restorePlan({ ...base, orders: [order()], payments: [paid(2_500)] }), []);
  // Paid, then the payment voided.
  assert.deepEqual(restorePlan({ ...base, orders: [order()], payments: [paid(3_000, { status: 'voided' })] }), []);
  // A phone order: the server correcting it was the guard doing its job.
  assert.deepEqual(restorePlan({ ...base, orders: [order({ channel: 'qr' })], payments: [paid(3_000)] }), []);
  // Cancelled.
  assert.deepEqual(restorePlan({ ...base, orders: [order({ status: 'CANCELLED' })], payments: [paid(3_000)] }), []);
});

test('a line changed since, or already put right, is left alone', () => {
  const logs = [log('o1', 'Club · Large: sent 3000, actual 2500')];
  const payments = [paid(3_000)];
  assert.deepEqual(restorePlan({ logs, orders: [order({ total: 3_000 })], lines: [line({ line_total: 3_000 })], payments }), [], 'already right');
  assert.deepEqual(restorePlan({ logs, orders: [order()], lines: [line({ list_price: 3_000 })], payments }), [], 'repriced by hand at the till');
  assert.deepEqual(restorePlan({ logs, orders: [order()], lines: [line({ status: 'void' })], payments }), []);
});

test('a till that charged less than the menu is not raised', () => {
  // The money that came in was the lower figure; the bill must not claim more.
  assert.deepEqual(restorePlan({
    logs: [log('o1', 'Club · Large: sent 2000, actual 2500')],
    orders: [order()], lines: [line()], payments: [paid(2_500)],
  }), []);
  assert.equal(rewritesByOrder([{ entity_id: 'o1', after: 'not json' }]).size, 0);
  assert.match(restoreWords([], money), /Nothing to put back/);
});
