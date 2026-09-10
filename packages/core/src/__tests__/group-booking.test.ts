import test from 'node:test';
import assert from 'node:assert/strict';
import {
  packFeeFor, portionsOn, dayTotals, bookingTotals, bookingProblem, dayWords, packWords,
  slotsByDay, daysTaken, dayKeyOf, FULFILMENT_WORDS,
} from '../pricing.ts';
import type { GroupDay } from '../pricing.ts';

const settings = { tax_rate_bp: 0, tax_inclusive: false, service_charge_bp: 0 };
const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

const line = (key: string, price: number, qty: number) => ({
  key, menu_item_id: key, name: key, unit_price: price, qty, addons: [],
});

const day = (at: string, fulfilment: 'dine_in' | 'takeaway', lines = [line('jollof', 5_000, 2)]): GroupDay =>
  ({ key: at, at, fulfilment, lines });

test('packing is charged once per portion, and only on a day that is taken away', () => {
  const lines = [line('jollof', 5_000, 12), line('salad', 2_000, 8)];
  assert.equal(portionsOn({ lines }), 20);
  assert.equal(packFeeFor({ fulfilment: 'takeaway', lines }, 200), 4_000);
  // Eating here uses the restaurant's own plates.
  assert.equal(packFeeFor({ fulfilment: 'dine_in', lines }, 200), 0);
  // No fee set means no fee, whatever the day says.
  assert.equal(packFeeFor({ fulfilment: 'takeaway', lines }, 0), 0);
});

test('the fee is taxed like a sale and is not eaten by a discount', () => {
  const taxed = { tax_rate_bp: 1500, tax_inclusive: false, service_charge_bp: 0 };
  const t = dayTotals(day('2026-09-14T12:00:00Z', 'takeaway', [line('jollof', 10_000, 2)]), taxed, 500);
  assert.equal(t.packFee, 1_000);
  assert.equal(t.subtotal, 20_000);
  // VAT on the food and the containers together: 21,000 × 15%.
  assert.equal(t.tax_total, 3_150);
  assert.equal(t.total, 24_150);
});

test('a booking is the sum of its days, so the tickets add up to the quote', () => {
  const days = [
    day('2026-09-15T12:00:00Z', 'takeaway', [line('jollof', 5_000, 4)]),
    day('2026-09-14T12:00:00Z', 'dine_in', [line('jollof', 5_000, 2)]),
  ];
  const b = bookingTotals(days, settings, 250);
  // Earliest first, whatever order the days were added in.
  assert.deepEqual(b.days.map((d) => d.day.at), ['2026-09-14T12:00:00Z', '2026-09-15T12:00:00Z']);
  assert.equal(b.subtotal, 30_000);
  assert.equal(b.packFees, 1_000);
  assert.equal(b.portions, 6);
  assert.equal(b.total, 31_000);
  // And the whole equals the parts, which is the point of pricing day by day.
  assert.equal(b.total, b.days.reduce((n, d) => n + d.totals.total, 0));
});

test('a day switched to eating here loses its packing charge', () => {
  const packed = bookingTotals([day('2026-09-14T12:00:00Z', 'takeaway')], settings, 300);
  const eaten = bookingTotals([day('2026-09-14T12:00:00Z', 'dine_in')], settings, 300);
  assert.equal(packed.packFees, 600);
  assert.equal(eaten.packFees, 0);
  assert.equal(packed.total - eaten.total, 600);
});

test('a booking says the one thing stopping it, earliest first', () => {
  const ok = { reference: 'R1', needReference: true, referenceLabel: 'Booking ref', size: 10, minSize: 6, contactName: 'Ama' };
  assert.match(String(bookingProblem([], ok)), /Add a day/);

  const days = [day('2026-09-14T12:00:00Z', 'dine_in'), day('2026-09-15T12:00:00Z', 'dine_in', [])];
  assert.match(String(bookingProblem(days, ok)), /has nothing on it/);

  const full = [day('2026-09-14T12:00:00Z', 'dine_in')];
  assert.match(String(bookingProblem(full, { ...ok, contactName: ' ' })), /give a name/);
  assert.match(String(bookingProblem(full, { ...ok, reference: '' })), /booking ref/);
  assert.equal(bookingProblem(full, { ...ok, reference: '', needReference: false }), null);
  assert.match(String(bookingProblem(full, { ...ok, size: 2 })), /6 people or more/);
  assert.equal(bookingProblem(full, ok), null);
});

test('the empty day named is the earliest one, not whichever was added last', () => {
  const days = [
    day('2026-09-16T12:00:00Z', 'dine_in', []),
    day('2026-09-14T12:00:00Z', 'dine_in', []),
  ];
  const said = String(bookingProblem(days, {
    reference: 'R', needReference: false, referenceLabel: 'ref', size: 9, minSize: 0, contactName: 'Ama',
  }));
  assert.match(said, /14 September/);
});

test('the times offered are gathered into the days they fall on', () => {
  const slots = [
    new Date('2026-09-14T12:00:00'), new Date('2026-09-14T12:30:00'), new Date('2026-09-15T19:00:00'),
  ];
  const grouped = slotsByDay(slots);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].times.length, 2);
  assert.equal(grouped[1].times.length, 1);
  // A day already booked is not offered again.
  const taken = daysTaken([day(slots[0].toISOString(), 'dine_in')]);
  assert.equal(taken.has(dayKeyOf(slots[0])), true);
  assert.equal(taken.has(dayKeyOf(slots[2])), false);
});

test('a day and the charge say what they are in words', () => {
  const t = dayTotals(day('2026-09-14T12:00:00Z', 'takeaway', [line('jollof', 5_000, 3)]), settings, 200);
  const said = dayWords(t, money);
  assert.match(said, /3 portions/);
  assert.match(said, /of that packing/);

  assert.match(packWords(200, money), /GH₵2\.00 a portion/);
  assert.match(packWords(0, money), /Nothing extra/);
  assert.equal(FULFILMENT_WORDS.takeaway, 'Packed to take away');
});
