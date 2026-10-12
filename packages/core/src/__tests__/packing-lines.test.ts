import test from 'node:test';
import assert from 'node:assert/strict';
import { packingWords, packFeeFor } from '../pricing.ts';
import * as fn from '../../../../functions/notify/src/words.js';
import { bookingSheetPdf } from '../../../../functions/notify/src/booking-sheet.js';
import { receiptPdf, portionsOf } from '../../../../functions/notify/src/receipt-pdf.js';

const money = (n: number) => `GHS ${(n / 100).toFixed(2)}`;
const asText = (bytes: Uint8Array): string => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

test('packing is named, counted and priced each, wherever it divides evenly', () => {
  assert.deepEqual(packingWords(35_000, 35, money), { label: 'Takeaway packing', count: 35, each: 'GHS 10.00' });
  // A dish taken off after the fee was set: the amount alone, still named.
  assert.deepEqual(packingWords(35_000, 34, money), { label: 'Takeaway packing' });
  assert.equal(packingWords(0, 35, money), null);
  // The fee it names is the one charged: once a portion, on takeaway only.
  const lines = [{ qty: 35 }] as Parameters<typeof packFeeFor>[0]['lines'];
  assert.equal(packFeeFor({ fulfilment: 'takeaway', lines }, 1_000), 35_000);
  assert.equal(packFeeFor({ fulfilment: 'dine_in', lines }, 1_000), 0);
});

test('the emailed receipt words packing exactly as the apps do', () => {
  for (const [fee, portions] of [[35_000, 35], [35_000, 34], [0, 10], [500, 1]] as const) {
    assert.deepEqual(fn.packingWords(fee, portions, money), packingWords(fee, portions, money));
  }
});

// Sitting 2 of the Cross Your Borders booking: three dishes and 35 boxes.
const takeaway = {
  order: { order_no: 'ORD0843', scheduled_for: '2026-10-12T09:00:00.000Z', fulfilment: 'takeaway', total: 358_500, pack_fee: 35_000 },
  lines: [
    { qty: 1, name: 'Fried rice', variant: '', total: 8_000, choices: ['Vegetables'], omissions: ['No soy sauce'], notes: '', diets: ['Vegetarian'], cautions: [], unknown: [], lost: false },
    { qty: 29, name: 'Club sandwich', variant: '', total: 275_500, choices: [], omissions: [], notes: '', diets: ['Nut free'], cautions: [], unknown: [], lost: false },
    { qty: 5, name: 'Veggie sandwich', variant: '', total: 40_000, choices: [], omissions: [], notes: '', diets: ['Vegetarian'], cautions: [], unknown: [], lost: false },
  ],
};
const dineIn = {
  order: { order_no: 'ORD0844', scheduled_for: '2026-10-12T19:00:00.000Z', fulfilment: 'dine_in', total: 385_000, pack_fee: 0 },
  lines: [{ qty: 70, name: 'Red red', variant: '', total: 385_000, choices: [], omissions: [], notes: '', diets: [], cautions: [], unknown: [], lost: false }],
};
const booking = {
  $id: 'b1', contact_name: 'Ivy Koelman', reference: 'Cross Your Borders', total: 743_500,
  first_at: takeaway.order.scheduled_for, last_at: dineIn.order.scheduled_for, order_nos: 'ORD0843, ORD0844',
};

test('the booking sheet shows the packing under a takeaway sitting, and in the total', () => {
  const pdf = asText(bookingSheetPdf({
    settings: { currency_code: 'GHS', currency_decimals: 2 }, booking, sittings: [takeaway, dineIn],
  }));
  assert.match(pdf, /35 × +Takeaway packing/);
  assert.ok(pdf.includes('A container for each portion, GHS 10.00 each'));
  assert.ok(pdf.includes('Of which packing'));
  assert.ok(pdf.includes('Includes GHS 350.00 takeaway packing; the food is GHS 7085.00.'));
  // Under the dishes, before the sitting total.
  assert.ok(pdf.indexOf('Veggie sandwich') < pdf.indexOf('Takeaway packing'));
  assert.ok(pdf.indexOf('Takeaway packing') < pdf.indexOf('Sitting total'));
  // Once: the dine-in sitting has none.
  assert.equal(pdf.split('A container for each portion').length - 1, 1);
});

test('the kitchen copy carries no packing money', () => {
  const pdf = asText(bookingSheetPdf({ settings: {}, booking, sittings: [takeaway], prices: false }));
  assert.ok(!pdf.includes('Takeaway packing'));
  assert.ok(!pdf.includes('Of which packing'));
});

test('the emailed receipt PDF names the packing between the food and the total', () => {
  const items = [
    { name_snapshot: 'Fried rice', qty: 1, unit_price: 8_000, line_total: 8_000 },
    { name_snapshot: 'Club sandwich', qty: 29, unit_price: 9_500, line_total: 275_500 },
    { name_snapshot: 'Veggie sandwich', qty: 5, unit_price: 8_000, line_total: 40_000 },
    { name_snapshot: 'Taken off', qty: 2, unit_price: 1_000, line_total: 2_000, status: 'void' },
  ];
  assert.equal(portionsOf(items), 35);
  const pdf = asText(receiptPdf({
    settings: { currency_code: 'GHS', currency_decimals: 2, restaurant_name: 'Abibifo' },
    venue: null,
    order: { order_no: 'ORD0843', subtotal: 323_500, pack_fee: 35_000, total: 358_500, tax_total: 0, $createdAt: '2026-10-12T09:00:00.000Z', payment_status: 'unpaid' },
    items, payments: [], methods: [],
  }));
  assert.ok(pdf.includes('Takeaway packing'));
  assert.ok(pdf.includes('35 @ GHS 10.00'));
  assert.ok(pdf.indexOf('Sub Total') < pdf.indexOf('Takeaway packing'));
  assert.ok(pdf.indexOf('Takeaway packing') < pdf.indexOf('TOTAL'));
});
