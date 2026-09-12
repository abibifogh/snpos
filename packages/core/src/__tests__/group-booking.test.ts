import test from 'node:test';
import assert from 'node:assert/strict';
import {
  packFeeFor, portionsOn, mealTotals, bookingTotals, bookingProblem, mealWords, packWords,
  slotsByDay, timesTaken, timeIsTaken, freeTimesOn, FULFILMENT_WORDS,
  mealMoment, momentProblem, dayInput, timeInput, BOOKING_OPENS, BOOKING_CLOSES,
  serviceOf, mealServiceWords, SERVICE_WORDS, emailLooksReal,
} from '../pricing.ts';
import type { GroupMeal } from '../pricing.ts';

const settings = { tax_rate_bp: 0, tax_inclusive: false, service_charge_bp: 0 };
const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

const line = (key: string, price: number, qty: number) => ({
  key, menu_item_id: key, name: key, unit_price: price, qty, addons: [],
});

const meal = (at: string, fulfilment: 'dine_in' | 'takeaway', lines = [line('jollof', 5_000, 2)]): GroupMeal =>
  ({ key: at, at, fulfilment, lines });

test('packing is charged once per portion, and only on a meal that is taken away', () => {
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
  const t = mealTotals(meal('2026-09-14T12:00:00Z', 'takeaway', [line('jollof', 10_000, 2)]), taxed, 500);
  assert.equal(t.packFee, 1_000);
  assert.equal(t.subtotal, 20_000);
  // VAT on the food and the containers together: 21,000 × 15%.
  assert.equal(t.tax_total, 3_150);
  assert.equal(t.total, 24_150);
});

test('a booking is the sum of its meals, so the tickets add up to the quote', () => {
  const meals = [
    meal('2026-09-15T12:00:00Z', 'takeaway', [line('jollof', 5_000, 4)]),
    meal('2026-09-14T12:00:00Z', 'dine_in', [line('jollof', 5_000, 2)]),
  ];
  const b = bookingTotals(meals, settings, 250);
  // Earliest first, whatever order the meals were added in.
  assert.deepEqual(b.meals.map((m) => m.meal.at), ['2026-09-14T12:00:00Z', '2026-09-15T12:00:00Z']);
  assert.equal(b.subtotal, 30_000);
  assert.equal(b.packFees, 1_000);
  assert.equal(b.portions, 6);
  assert.equal(b.total, 31_000);
  // And the whole equals the parts, which is the point of pricing day by day.
  assert.equal(b.total, b.meals.reduce((n, m) => n + m.totals.total, 0));
});

test('a meal switched to eating here loses its packing charge', () => {
  const packed = bookingTotals([meal('2026-09-14T12:00:00Z', 'takeaway')], settings, 300);
  const eaten = bookingTotals([meal('2026-09-14T12:00:00Z', 'dine_in')], settings, 300);
  assert.equal(packed.packFees, 600);
  assert.equal(eaten.packFees, 0);
  assert.equal(packed.total - eaten.total, 600);
});

test('a booking says the one thing stopping it, earliest first', () => {
  const ok = {
    reference: 'R1', needReference: true, referenceLabel: 'Booking ref',
    size: 10, minSize: 6, contactName: 'Ama', email: 'ama@example.com',
  };
  assert.match(String(bookingProblem([], ok)), /Add a meal/);

  const some = [meal('2026-09-14T12:00:00Z', 'dine_in'), meal('2026-09-15T12:00:00Z', 'dine_in', [])];
  assert.match(String(bookingProblem(some, ok)), /has nothing on it/);

  const full = [meal('2026-09-14T12:00:00Z', 'dine_in')];
  assert.match(String(bookingProblem(full, { ...ok, contactName: ' ' })), /give a name/);
  assert.match(String(bookingProblem(full, { ...ok, reference: '' })), /booking ref/);
  assert.equal(bookingProblem(full, { ...ok, reference: '', needReference: false }), null);
  assert.match(String(bookingProblem(full, { ...ok, size: 2 })), /6 people or more/);
  assert.equal(bookingProblem(full, ok), null);
});

test('the empty meal named is the earliest one, named by day and time', () => {
  const meals = [
    meal('2026-09-16T12:00:00Z', 'dine_in', []),
    meal('2026-09-14T12:30:00', 'dine_in', []),
  ];
  const said = String(bookingProblem(meals, {
    reference: 'R', needReference: false, referenceLabel: 'ref', size: 9, minSize: 0,
    contactName: 'Ama', email: 'ama@example.com',
  }));
  assert.match(said, /14 September, 12:30/);
});

test('the times offered are gathered into the days they fall on', () => {
  const slots = [
    new Date('2026-09-14T12:00:00'), new Date('2026-09-14T12:30:00'), new Date('2026-09-15T19:00:00'),
  ];
  const grouped = slotsByDay(slots);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].times.length, 2);
  assert.equal(grouped[1].times.length, 1);
});

test('lunch and dinner on one day are two meals, and only the same time is a duplicate', () => {
  const noon = new Date('2026-09-14T12:00:00');
  const half = new Date('2026-09-14T12:30:00');
  const evening = new Date('2026-09-14T19:00:00');
  const taken = timesTaken([meal(noon.toISOString(), 'takeaway'), meal(evening.toISOString(), 'dine_in')]);

  // The same moment twice is refused.
  assert.equal(timeIsTaken(taken, noon), true);
  assert.equal(timeIsTaken(taken, evening), true);
  // Another time on the same day is not.
  assert.equal(timeIsTaken(taken, half), false);
  assert.deepEqual(freeTimesOn([noon, half, evening], taken), [half]);

  // And the two sittings are priced apart: packed lunch, dinner eaten here.
  const b = bookingTotals(
    [meal(noon.toISOString(), 'takeaway'), meal(evening.toISOString(), 'dine_in')],
    settings, 300,
  );
  assert.equal(b.meals.length, 2);
  assert.equal(b.packFees, 600);
});

test('a meal and the charge say what they are in words', () => {
  const t = mealTotals(meal('2026-09-14T12:00:00Z', 'takeaway', [line('jollof', 5_000, 3)]), settings, 200);
  const said = mealWords(t, money);
  assert.match(said, /3 portions/);
  assert.match(said, /of that packing/);

  assert.match(packWords(200, money), /GH₵2\.00 a portion/);
  assert.match(packWords(0, money), /Nothing extra/);
  assert.equal(FULFILMENT_WORDS.takeaway, 'Packed to take away');
});

test('a meal can be booked on any day, at any time the kitchen could serve', () => {
  /*
    The picker used to offer only the slots walk-ins are served in, read from
    the opening hours. A party books weeks ahead and the kitchen opens for
    them, and a venue whose hours were never filled in could offer nothing at
    all — a booking form that refused every date for a reason it never gave.
  */
  const at = mealMoment('2026-11-04', '19:30');
  assert.equal(at?.getFullYear(), 2026);
  assert.equal(at?.getMonth(), 10);
  assert.equal(at?.getDate(), 4);
  assert.equal(at?.getHours(), 19);
  assert.equal(at?.getMinutes(), 30);
  // Built locally, never parsed as UTC: a booking three hours out is a party
  // standing in an empty restaurant.
  assert.equal(dayInput(at as Date), '2026-11-04');
  assert.equal(timeInput(at as Date), '19:30');
});

test('half-filled boxes are not a moment', () => {
  assert.equal(mealMoment('', '19:30'), null);
  assert.equal(mealMoment('2026-11-04', ''), null);
  assert.equal(mealMoment('4 November', '19:30'), null);
  assert.equal(mealMoment('2026-11-04', '25:00'), null);
  assert.equal(mealMoment('2026-11-04', '19:70'), null);
  assert.match(String(momentProblem(null)), /Choose a day and a time/);
});

test('the hours are a rule, not just a hint to the box', () => {
  const now = new Date('2026-11-01T09:00:00');
  const on = (time: string) => momentProblem(mealMoment('2026-11-04', time), now);
  // The edges are in.
  assert.equal(on(BOOKING_OPENS), null);
  assert.equal(on(BOOKING_CLOSES), null);
  assert.equal(on('12:45'), null);
  // Outside them, said in the words of whoever typed it.
  assert.match(String(on('08:59')), /between 09:00 and 22:00/);
  assert.match(String(on('22:01')), /between 09:00 and 22:00/);
  assert.match(String(on('03:00')), /between 09:00 and 22:00/);
});

test('a time that has gone is refused before the booking is sent', () => {
  const now = new Date('2026-11-04T13:00:00');
  assert.match(String(momentProblem(mealMoment('2026-11-04', '12:00'), now)), /already gone/);
  // Later the same day is fine: a group can book lunch for this evening.
  assert.equal(momentProblem(mealMoment('2026-11-04', '19:00'), now), null);
});

test('a sitting eaten here says whether it is plated or a buffet', () => {
  /*
    Forty covers plated and forty as a buffet are the same food and two
    different days of work: forty plates leaving together at a promised time,
    against chafing dishes set out beforehand and topped up. The kitchen used
    to find out which when the party arrived.
  */
  assert.equal(serviceOf({ fulfilment: 'dine_in', service: 'buffet' }), 'buffet');
  // Plated unless somebody says otherwise, which is what a restaurant does.
  assert.equal(serviceOf({ fulfilment: 'dine_in' }), 'plated');
  // And the question is not asked of food going into boxes.
  assert.equal(serviceOf({ fulfilment: 'takeaway', service: 'buffet' }), null);

  assert.match(mealServiceWords({ fulfilment: 'dine_in', service: 'buffet' }), /Eating here · buffet/);
  assert.equal(mealServiceWords({ fulfilment: 'takeaway' }), 'Packed to take away');
  assert.equal(SERVICE_WORDS.plated, 'Served to each guest');
});

test('a booking is not sent without somewhere to send it', () => {
  /*
    Required here and optional on an ordinary order, and the difference is the
    situation. A walk-in who would rather not give an address is standing in
    the room. A party of forty booked three weeks ahead has nothing to hold:
    the arrangement was made on a screen they closed, and on the day the only
    record of what they asked for is in the kitchen.
  */
  const full = [meal('2026-09-14T12:00:00Z', 'dine_in')];
  const base = {
    reference: 'R1', needReference: false, referenceLabel: 'ref',
    size: 10, minSize: 6, contactName: 'Ama',
  };
  assert.match(String(bookingProblem(full, { ...base, email: '' })), /give an email address/);
  assert.match(String(bookingProblem(full, { ...base, email: 'ama' })), /give an email address/);
  assert.match(String(bookingProblem(full, { ...base, email: 'ama@example' })), /give an email address/);
  assert.equal(bookingProblem(full, { ...base, email: 'ama@example.com' }), null);
  // Trimmed, because a pasted address arrives with a space on it.
  assert.equal(bookingProblem(full, { ...base, email: '  ama@example.com ' }), null);
});

test('what counts as an address is a blank-box check, not a specification', () => {
  // Rejecting real addresses to look thorough is how a booking gets lost.
  assert.equal(emailLooksReal('a.b+tag@sub.domain.co.uk'), true);
  assert.equal(emailLooksReal("o'brien@example.com"), true);
  assert.equal(emailLooksReal(''), false);
  assert.equal(emailLooksReal('   '), false);
  assert.equal(emailLooksReal('no-at-sign.com'), false);
  assert.equal(emailLooksReal('two@@example.com'), false);
  assert.equal(emailLooksReal(undefined), false);
});
