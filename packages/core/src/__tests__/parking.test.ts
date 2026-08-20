import test from 'node:test';
import assert from 'node:assert/strict';
import {
  park, unpark, parkProblem, parkedTotal, parkedCount, parkedAgo, describeParked,
  autoLabel, isStale, parkKey, MAX_PARKED, STALE_AFTER_MS,
  type ParkedSale, type ParkedLine,
} from '../parking.ts';

const line = (over: Partial<ParkedLine> = {}): ParkedLine => ({
  key: 'k1', menu_item_id: 'm1', name: 'Club beer', unit_price: 1_500, qty: 1, ...over,
});

const sale = (over: Partial<ParkedSale> = {}): ParkedSale => ({
  id: 's1', label: '', lines: [line()], parkedAt: '2026-08-20T10:00:00.000Z', ...over,
});

const money = (n: number) => `GH¢${(n / 100).toFixed(2)}`;

test('a parked sale totals what is in it, add-ons included', () => {
  const s = sale({
    lines: [
      line({ qty: 2, unit_price: 1_500 }),
      line({
        key: 'k2', name: 'Cocktail', unit_price: 4_000,
        addons: [{ option_id: 'o1', group_id: 'g1', name: 'Double', price_delta: 2_000 }],
      }),
    ],
  });
  assert.equal(parkedTotal(s), 3_000 + 6_000);
  assert.equal(parkedCount(s), 3);
});

test('the newest parked sale is first, because it is the one wanted back', () => {
  // A list in the order they were parked puts the one somebody just put down
  // at the bottom, and grows away from them.
  const list = park(park([], sale({ id: 'a' })), sale({ id: 'b' }));
  assert.deepEqual(list.map((s) => s.id), ['b', 'a']);
});

test('parking the same sale twice moves it rather than duplicating it', () => {
  // Otherwise a basket edited and re-parked appears in two places, and one of
  // them is stale the moment it is written.
  const list = park(park([], sale({ id: 'a', label: 'first' })), sale({ id: 'a', label: 'second' }));
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'second');
});

test('a till will not hold more baskets than anybody can find', () => {
  /**
   * Not a technical limit. A counter with nine baskets behind it is one where
   * the wrong basket gets picked up, and at that point they have stopped being
   * parked sales and started being lost ones.
   */
  assert.equal(MAX_PARKED, 8);
  const full = Array.from({ length: MAX_PARKED }, (_, i) => sale({ id: `s${i}` }));
  assert.match(parkProblem([line()], full) ?? '', /already parked on this till/);
  assert.equal(parkProblem([line()], full.slice(1)), null);
});

test('an empty sale cannot be parked', () => {
  assert.match(parkProblem([], []) ?? '', /nothing on this sale to park/);
});

test('picking one back up takes it off the list', () => {
  const list = [sale({ id: 'a' }), sale({ id: 'b' })];
  const { sale: got, rest } = unpark(list, 'a');
  assert.equal(got?.id, 'a');
  assert.deepEqual(rest.map((s) => s.id), ['b']);
  // Asking for one that is not there is not a crash; it is an empty answer.
  assert.equal(unpark(list, 'nope').sale, null);
});

test('a basket is named by what is in it, not by a number', () => {
  /**
   * A customer is remembered by what they were buying. A numbered list of
   * anonymous baskets is one where the wrong basket gets picked up.
   */
  assert.equal(autoLabel([line({ name: 'Club beer' })]), 'Club beer');
  assert.equal(autoLabel([line({ name: 'Club beer' }), line({ key: 'k2' })]), 'Club beer and 1 more');
  assert.equal(autoLabel([]), 'Empty sale');
});

test('how long ago is said the way a person says it', () => {
  const at = (iso: string) => new Date(iso);
  const s = sale({ parkedAt: '2026-08-20T10:00:00.000Z' });
  assert.equal(parkedAgo(s, at('2026-08-20T10:00:30.000Z')), 'just now');
  assert.equal(parkedAgo(s, at('2026-08-20T10:01:00.000Z')), '1 minute ago');
  assert.equal(parkedAgo(s, at('2026-08-20T10:40:00.000Z')), '40 minutes ago');
  assert.equal(parkedAgo(s, at('2026-08-20T13:00:00.000Z')), '3 hours ago');
  assert.equal(parkedAgo(s, at('2026-08-22T10:00:00.000Z')), '2 days ago');
  // A clock that has gone backwards is not an error worth showing anybody.
  assert.equal(parkedAgo(s, at('2026-08-20T09:00:00.000Z')), 'just now');
});

test('a basket sitting since yesterday is flagged, one from an hour ago is not', () => {
  /**
   * Long enough that a customer who went to the cashpoint is not nagged about;
   * short enough that yesterday's abandoned basket is not still on the till at
   * opening looking like a live sale.
   */
  assert.equal(STALE_AFTER_MS, 4 * 3_600_000);
  const s = sale({ parkedAt: '2026-08-20T10:00:00.000Z' });
  assert.equal(isStale(s, new Date('2026-08-20T11:00:00.000Z')), false);
  assert.equal(isStale(s, new Date('2026-08-20T15:00:00.000Z')), true);
});

test('the bar and the shop park separately', () => {
  // A bar tab and a craft basket are not the same queue, and one till showing
  // the other's baskets is how the wrong one gets paid for.
  assert.notEqual(parkKey('main', 'bar'), parkKey('main', 'craft'));
});

test('the list line says what somebody needs to pick the right basket', () => {
  const s = sale({ lines: [line({ qty: 2 })], parkedAt: '2026-08-20T10:00:00.000Z' });
  assert.equal(
    describeParked(s, money, new Date('2026-08-20T10:05:00.000Z')),
    '2 items · GH¢30.00 · 5 minutes ago',
  );
});

test('an add-on keeps its ids, not just its price', () => {
  /**
   * A basket picked back up must be the one that was put down. Losing the
   * option and group would produce a bill that looks right on screen and
   * orders the wrong thing — a double poured as a single, charged as a double.
   */
  const addon = { option_id: 'o1', group_id: 'g1', name: 'Double', price_delta: 2_000, qty: 2 };
  const list = park([], sale({ lines: [line({ unit_price: 4_000, addons: [addon] })] }));
  assert.deepEqual(list[0].lines[0].addons?.[0], addon);
  // And it is charged for what it is: two doubles on one drink.
  assert.equal(parkedTotal(list[0]), 4_000 + 4_000);
});
