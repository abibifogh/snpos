import test from 'node:test';
import assert from 'node:assert/strict';
import {
  packFeeFor, portionsOn, mealTotals, bookingTotals, bookingProblem, mealWords, packWords,
  slotsByDay, timesTaken, timeIsTaken, freeTimesOn, FULFILMENT_WORDS, linesByCategory, portionsIn, UNGROUPED,
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
  const ok = { reference: 'R1', needReference: true, referenceLabel: 'Booking ref', size: 10, minSize: 6, contactName: 'Ama' };
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
    reference: 'R', needReference: false, referenceLabel: 'ref', size: 9, minSize: 0, contactName: 'Ama',
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

test('a meal’s dishes read under the headings they came from, in menu order', () => {
  const lines = [
    line('club', 3_000, 2),
    line('chicken-wrap', 4_000, 5),
    line('jollof', 5_000, 3),
    line('beef-wrap', 4_500, 1),
  ];
  const of = (id: string) => ({
    'chicken-wrap': 'Wraps', 'beef-wrap': 'Wraps', 'club': 'Sandwiches', 'jollof': 'Mains',
  }[id] ?? '');

  const groups = linesByCategory(lines, of, ['Wraps', 'Sandwiches', 'Mains']);
  assert.deepEqual(groups.map((g) => g.category), ['Wraps', 'Sandwiches', 'Mains']);
  // Not alphabetical, and not the order the dishes happened to be tapped in.
  assert.deepEqual(groups[0].lines.map((l) => l.name), ['chicken-wrap', 'beef-wrap']);
  assert.equal(portionsIn(groups[0]), 6);
  assert.equal(portionsIn(groups[2]), 3);
});

test('a dish whose heading is gone is shown, not lost', () => {
  const groups = linesByCategory([line('mystery', 1_000, 1), line('jollof', 5_000, 2)],
    (id) => (id === 'jollof' ? 'Mains' : ''), ['Mains']);
  assert.deepEqual(groups.map((g) => g.category), ['Mains', UNGROUPED]);
  assert.equal(portionsIn(groups[1]), 1);
});

test('a heading the menu order never mentioned still comes before the catch-all', () => {
  const groups = linesByCategory(
    [line('a', 100, 1), line('b', 100, 1), line('c', 100, 1)],
    (id) => ({ a: 'Mains', b: 'Specials' }[id] ?? ''),
    ['Mains'],
  );
  assert.deepEqual(groups.map((g) => g.category), ['Mains', 'Specials', UNGROUPED]);
});
