import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorised, readRange, readLimit, readModule, summarise,
  shapeOrder, shapePayment, shapeShift,
  // Plain JavaScript, deliberately importing nothing at runtime so it can be
  // tested from here without a database. Typed by the JSDoc it carries.
} from '../../../../functions/notify/src/report-shape.js';

/**
 * The reporting API is the only part of this system the outside world can
 * reach, so the parts that decide who gets in and what they are handed are
 * checked here rather than by pointing something at a live database.
 */

test('a reporting request without the right key gets nowhere', () => {
  const key = 'a-long-enough-secret-key';
  assert.equal(authorised(`Bearer ${key}`, key), true);
  assert.equal(authorised(key, key), true, 'the Bearer prefix is optional');
  assert.equal(authorised(`  Bearer   ${key}  `, key), true, 'whitespace is not a password');

  assert.equal(authorised('Bearer wrong', key), false);
  assert.equal(authorised(`Bearer ${key}x`, key), false);
  assert.equal(authorised('', key), false);
  assert.equal(authorised(undefined, key), false);
});

test('no key set means the door is shut, not open', () => {
  // The failure that matters. A reporting endpoint that serves everything
  // because nobody configured it is a copy of the takings on the internet.
  assert.equal(authorised('Bearer anything', ''), false);
  assert.equal(authorised('Bearer anything', undefined), false);
  assert.equal(authorised('Bearer ', ''), false);
  // And a key too short to be worth anything is treated as no key.
  assert.equal(authorised('Bearer short', 'short'), false);
});

test('a plain date means the whole of that day', () => {
  const { from, to } = readRange({ from: '2026-08-01', to: '2026-08-12' });
  assert.equal(from, '2026-08-01T00:00:00.000Z');
  // The bug this pins: ending at midnight silently loses the last day.
  assert.equal(to, '2026-08-12T23:59:59.999Z');
});

test('a request with no dates gets the last month, not the whole history', () => {
  const now = new Date('2026-08-12T09:00:00.000Z');
  const { from, to } = readRange({}, now);
  assert.equal(to, now.toISOString());
  assert.equal(from, '2026-07-13T09:00:00.000Z');
});

test('dates the wrong way round are a typo, not a request for nothing', () => {
  const { from, to } = readRange({ from: '2026-08-12', to: '2026-08-01' });
  assert.ok(from < to);
  assert.equal(from, '2026-08-01T23:59:59.999Z');
});

test('a page is bounded however much is asked for', () => {
  assert.equal(readLimit(undefined), 100);
  assert.equal(readLimit('50'), 50);
  assert.equal(readLimit('100000'), 500, 'one call cannot ask for everything');
  assert.equal(readLimit('0'), 100);
  assert.equal(readLimit('-5'), 100);
  assert.equal(readLimit('abc'), 100);
});

test('only the two real sides are accepted as a filter', () => {
  assert.equal(readModule('kitchen'), 'kitchen');
  assert.equal(readModule('CRAFT'), 'craft');
  assert.equal(readModule('everything'), null, 'an unknown side filters nothing rather than nothing at all');
  assert.equal(readModule(undefined), null);
});

test('nothing personal leaves the building', () => {
  const row = shapeOrder({
    $id: 'o1',
    $createdAt: '2026-08-12T10:00:00.000Z',
    order_no: 'B-0041',
    total: 4500,
    customer_name: 'Ama',
    customer_email: 'ama@example.com',
    customer_phone: '+233200000000',
    delivery_address: '12 Some Street',
  });

  assert.equal(row.customer_name, 'Ama', 'a name is analysis');
  assert.equal('customer_email' in row, false);
  assert.equal('customer_phone' in row, false);
  assert.equal('delivery_address' in row, false);
});

test('money comes out as it is stored, and missing figures are zero not undefined', () => {
  const row = shapeOrder({ $id: 'o1', total: 4500 });
  assert.equal(row.total, 4500, 'minor units, never divided');
  assert.equal(row.tax_total, 0);
  assert.equal(row.subtotal, 0);
  assert.equal(row.module, 'kitchen', 'rows from before the split are the restaurant');
});

test('a shift arrives with its counts as numbers, not as a string of JSON', () => {
  const row = shapeShift({
    $id: 's1',
    code: 'BIST20260812-ab12',
    opening_floats: '{"cash":10000}',
    counted: '{"cash":24500}',
    variance: 'not json at all',
  });
  assert.deepEqual(row.opening_floats, { cash: 10000 });
  assert.deepEqual(row.counted, { cash: 24500 });
  assert.deepEqual(row.variance, {}, 'a malformed figure is empty, never a crash');
});

test('the summary counts what sold, and what was taken for it', () => {
  const orders = [
    { status: 'CLOSED', payment_status: 'paid', module: 'kitchen', total: 5000, guest_count: 2, discount_total: 0, tax_total: 250, service_total: 0 },
    { status: 'CLOSED', payment_status: 'partial', module: 'craft', total: 3000, guest_count: 0, discount_total: 500, tax_total: 0, service_total: 0 },
    // Neither of these sold anything and neither may be counted.
    { status: 'CANCELLED', payment_status: 'unpaid', module: 'kitchen', total: 9999, guest_count: 4, discount_total: 0, tax_total: 0, service_total: 0 },
    { status: 'SCHEDULED', payment_status: 'unpaid', module: 'kitchen', total: 7777, guest_count: 1, discount_total: 0, tax_total: 0, service_total: 0 },
  ].map((o) => shapeOrder({ $id: Math.random().toString(), ...o }));

  const payments = [
    { method_kind_snapshot: 'cash', amount: 5000, tip: 200, status: 'captured' },
    { method_kind_snapshot: 'card', amount: 1000, tip: 0, status: 'captured' },
    // Voided money was never taken.
    { method_kind_snapshot: 'cash', amount: 9999, tip: 0, status: 'voided' },
  ].map((p) => shapePayment({ $id: Math.random().toString(), ...p }));

  const expenses = [{ amount: 1200, $id: 'e1' }, { amount: 300, $id: 'e2' }];

  const s = summarise({ orders, payments, expenses });

  assert.equal(s.orders, 2, 'a cancelled ticket and a pre-order sold nothing');
  assert.equal(s.orders_paid, 1);
  assert.equal(s.orders_unpaid, 1);
  assert.equal(s.covers, 2);
  assert.equal(s.gross_sales, 8000);
  assert.equal(s.discounts, 500);
  assert.equal(s.takings, 6000, 'the voided payment is not money');
  assert.equal(s.tips, 200);
  assert.equal(s.expenses, 1500);
  assert.equal(s.net_sales, 4500, 'what came in, less what went back out');
  assert.equal(s.average_order, 4000);
  assert.deepEqual(s.by_method, { cash: 5000, card: 1000 });
  assert.deepEqual(s.by_module, {
    kitchen: { orders: 1, total: 5000 },
    craft: { orders: 1, total: 3000 },
  });
});

test('a summary of nothing is zeroes, not a crash and not a division by zero', () => {
  const s = summarise({});
  assert.equal(s.orders, 0);
  assert.equal(s.average_order, 0);
  assert.equal(s.net_sales, 0);
  assert.deepEqual(s.by_method, {});
});
