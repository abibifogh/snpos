import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isUnpaidBill, unpaidBillsFor, withBill, billPlace, billWho, unpaidWords, parksAfterSend,
} from '../unpaid-bills.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
const bill = (over: Record<string, unknown> = {}) => ({
  $id: 'o1', $createdAt: '2026-09-26T18:00:00.000Z', order_no: 'ORD1096', status: 'PENDING',
  payment_status: 'unpaid', module: 'bar', table_id: '', channel: 'counter', total: 6_000, ...over,
});

test('a bar sale rung up and not paid is on the list without anybody parking it', () => {
  // ORD1096: 2× Club · Large, sent from the bar with no table.
  assert.equal(isUnpaidBill(bill()), true);
  assert.equal(isUnpaidBill(bill({ payment_status: 'partial' })), true, 'half paid is still owed');
});

test('paid, cancelled, closed, on a tab or not yet released is not waiting for a cashier', () => {
  assert.equal(isUnpaidBill(bill({ payment_status: 'paid' })), false);
  assert.equal(isUnpaidBill(bill({ status: 'CANCELLED' })), false);
  assert.equal(isUnpaidBill(bill({ status: 'REJECTED' })), false);
  assert.equal(isUnpaidBill(bill({ status: 'CLOSED' })), false);
  assert.equal(isUnpaidBill(bill({ status: 'SCHEDULED' })), false);
  assert.equal(isUnpaidBill(bill({ tab_id: 't1' })), false, 'Settle a tab takes that money');
});

test('each side sees its own, the one waiting longest first', () => {
  const list = unpaidBillsFor([
    bill({ $id: 'b', order_no: 'ORD1096', $createdAt: '2026-09-26T19:00:00.000Z' }),
    bill({ $id: 'a', order_no: 'ORD1086', $createdAt: '2026-09-25T19:00:00.000Z' }),
    bill({ $id: 'k', order_no: 'K0101', module: undefined }),
    bill({ $id: 'p', order_no: 'ORD1090', payment_status: 'paid' }),
  ], 'bar');
  assert.deepEqual(list.map((o) => o.order_no), ['ORD1086', 'ORD1096']);
  assert.deepEqual(unpaidBillsFor([bill({ module: undefined })], 'kitchen').length, 1, 'no side is the kitchen');
});

test('the live feed adds a new bill and drops one paid on another till', () => {
  let list = unpaidBillsFor([bill()], 'bar');
  list = withBill(list, bill({ $id: 'o2', order_no: 'ORD1097', $createdAt: '2026-09-26T18:05:00.000Z' }), 'bar');
  assert.deepEqual(list.map((o) => o.order_no), ['ORD1096', 'ORD1097']);
  list = withBill(list, bill({ payment_status: 'paid' }), 'bar');
  assert.deepEqual(list.map((o) => o.order_no), ['ORD1097']);
  list = withBill(list, bill({ $id: 'k1', module: 'kitchen' }), 'bar');
  assert.deepEqual(list.map((o) => o.order_no), ['ORD1097'], 'another side\'s bill does not land here');
});

test('where and who, in the words on the floor', () => {
  assert.equal(billPlace(bill()), 'Bar');
  assert.equal(billPlace(bill({ module: 'craft' })), 'Counter');
  assert.equal(billPlace(bill({ module: 'kitchen' })), 'Takeaway');
  assert.equal(billPlace(bill({ module: 'kitchen', table_id: 't4' }), { t4: '4' }), 'Table 4');
  assert.equal(billPlace(bill({ module: 'kitchen', channel: 'qr', fulfilment: 'takeaway' })), 'Phone order · takeaway');
  assert.equal(billWho(bill({ customer_name: ' Ama ' })), 'Ama');
  assert.equal(billWho(bill({ placed_by: 'Kofi' })), 'rung up by Kofi');
  assert.equal(unpaidWords([bill(), bill({ total: 2_500 })], money), '2 unpaid · GH₵85.00');
  assert.equal(unpaidWords([], money), '');
});

test('a counter sale goes to Unpaid on its own only when nobody here can take the money', () => {
  assert.equal(parksAfterSend({ counterSale: true, canTakePayment: false }), true);
  assert.equal(parksAfterSend({ counterSale: true, canTakePayment: true }), false);
  assert.equal(parksAfterSend({ counterSale: false, canTakePayment: false }), false, 'a table holds its own bill');
});
