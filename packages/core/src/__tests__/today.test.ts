import test from 'node:test';
import assert from 'node:assert/strict';
import {
  takingsOf, against, percentWords, byHour, tradingHours, topSellers, openForWords, compareDays, dayKey, sidesOn,
} from '../today.ts';

const methods = [{ $id: 'm-cash', kind: 'cash' }, { $id: 'm-card', kind: 'card' }, { $id: 'm-momo', kind: 'mobile_money' }];
const orders = [
  { $id: 'o1', module: 'kitchen', payment_status: 'paid', guest_count: 3 },
  { $id: 'o2', module: 'bar', payment_status: 'paid' },
  { $id: 'o3', module: 'craft', payment_status: 'paid' },
  { $id: 'o4', module: 'kitchen', payment_status: 'unpaid', guest_count: 2 },
  { $id: 'o5', payment_status: 'paid', guest_count: 1 },
];
const at = (h: number) => new Date(2026, 8, 9, h, 15).toISOString();
const payments = [
  { order_id: 'o1', method_id: 'm-cash', amount: 3_000, $createdAt: at(12) },
  { order_id: 'o1', method_id: 'm-card', amount: 240, $createdAt: at(12) },
  { order_id: 'o2', method_id: 'm-momo', amount: 1_880, $createdAt: at(19) },
  { order_id: 'o3', method_id: 'm-cash', amount: 640, $createdAt: at(15) },
  { order_id: 'o2', method_id: 'm-cash', amount: 500, status: 'voided', $createdAt: at(19) },
  { order_id: 'o5', method_id: 'm-cash', amount: 100, $createdAt: at(20) },
  { order_id: 'gone', method_id: 'm-cash', amount: 50, $createdAt: at(21) },
];

test('takings come from the payments, sided through their orders, tips and voids left out', () => {
  const t = takingsOf(orders, payments, methods);
  assert.deepEqual(t.bySide, { kitchen: 3_390, bar: 1_880, craft: 640 });
  assert.equal(t.total, 5_910);
  assert.deepEqual(t.byKind, { cash: 3_790, card: 240, mobile_money: 1_880, other: 0 });
  // Covers count paid bistro orders only; an order with no side is the bistro.
  assert.equal(t.covers, 4);
  assert.deepEqual(t.orders, { kitchen: 2, bar: 1, craft: 1 });
});

test('against last week is a proportion, and nothing when last week was nothing', () => {
  assert.equal(against(1_120, 1_000), 0.12);
  assert.equal(against(910, 1_000), -0.09);
  assert.equal(against(500, 0), null);
  assert.equal(percentWords(0.12), '+12%');
  assert.equal(percentWords(-0.09), '−9%');
  assert.equal(percentWords(0), '0%');
  assert.equal(percentWords(null), '');
});

test('by the hour, in the reader’s clock, and the chart spans the hours that traded', () => {
  const hours = byHour(payments);
  assert.equal(hours[12], 3_240);
  assert.equal(hours[19], 1_880);
  assert.equal(hours[21], 50);
  assert.equal(hours.reduce((s, v) => s + v, 0), 5_910);
  assert.deepEqual(tradingHours(hours, new Array(24).fill(0)), [12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  // A quiet day still draws something.
  assert.deepEqual(tradingHours(new Array(24).fill(0), new Array(24).fill(0)), [11, 12, 13, 14]);
  // One busy hour is padded to four so it does not become one bar.
  const one = new Array(24).fill(0); one[22] = 5;
  assert.deepEqual(tradingHours(one, new Array(24).fill(0)), [20, 21, 22, 23]);
});

test('what sold most, by count, void lines left out, sizes named', () => {
  const lines = [
    { order_id: 'o1', name_snapshot: 'Jollof', qty: 2 },
    { order_id: 'o2', name_snapshot: 'Club', variant_label: 'Large', qty: 14 },
    { order_id: 'o1', name_snapshot: 'Jollof', qty: 16 },
    { order_id: 'o3', name_snapshot: 'Kente stole', qty: 2 },
    { order_id: 'o4', name_snapshot: 'Banku', qty: 40, status: 'void' },
  ];
  assert.deepEqual(topSellers(lines, 2), [{ name: 'Jollof', qty: 18 }, { name: 'Club · Large', qty: 14 }]);
});

test('how long a shift has been open, and which days to compare', () => {
  assert.equal(openForWords('2026-09-09T17:05:00Z', '2026-09-09T20:17:00Z'), '3h 12m');
  assert.equal(openForWords('2026-09-09T20:05:00Z', '2026-09-09T20:17:00Z'), '12m');
  assert.equal(openForWords('bad', '2026-09-09T20:17:00Z'), '');
  const now = new Date(2026, 8, 9, 20, 17);
  assert.deepEqual(compareDays(now), { today: '2026-09-09', yesterday: '2026-09-08', lastWeek: '2026-09-02' });
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.deepEqual(sidesOn({ kitchen: true, bar: false, craft: true }), ['kitchen', 'craft']);
});
