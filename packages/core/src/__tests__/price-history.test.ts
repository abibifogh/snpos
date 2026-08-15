import test from 'node:test';
import assert from 'node:assert/strict';
import { priceHistory, priceMoveNote, type PurchaseRow } from '../price-history.ts';

const buy = (at: string, qty: number, unitCost: number): PurchaseRow => ({ at, qty, unitCost });

test('a price reads in the order it moved, whatever order it arrives in', () => {
  /**
   * The database hands these back newest first, which is right for a screen
   * and wrong for arithmetic: "up 18% since March" has to know which one March
   * was. Sorting here means no caller can get it backwards and report a rise
   * as a fall.
   */
  const h = priceHistory([
    buy('2026-06-01', 5, 12000),
    buy('2026-03-01', 5, 10000),
    buy('2026-04-15', 10, 11000),
  ]);

  assert.deepEqual(h.points.map((p) => p.unitCost), [10000, 11000, 12000]);
  assert.equal(h.first, 10000);
  assert.equal(h.latest, 12000);
  assert.equal(h.moveBp, 2000, 'up 20%');
  assert.equal(h.cheapest, 10000);
  assert.equal(h.dearest, 12000);
});

test('each purchase is measured against the one before it', () => {
  const h = priceHistory([buy('2026-01-01', 1, 10000), buy('2026-02-01', 1, 11000), buy('2026-03-01', 1, 9900)]);
  assert.equal(h.points[0].changeFromPrevious, null, 'nothing came before the first');
  assert.equal(h.points[0].changeBp, null);
  assert.equal(h.points[1].changeFromPrevious, 1000);
  assert.equal(h.points[1].changeBp, 1000, 'up 10%');
  assert.equal(h.points[2].changeBp, -1000, 'down 10% from 11000');
});

test('the average is weighted by how much was bought', () => {
  /**
   * Five sacks at 100 and one at 200 is not an average of 150. A plain mean of
   * the prices lets one small emergency purchase at a corner shop drag the
   * figure every recipe is costed against.
   */
  const h = priceHistory([buy('2026-01-01', 5, 10000), buy('2026-02-01', 1, 20000)]);
  assert.equal(h.totalQty, 6);
  assert.equal(h.totalSpent, 70000);
  assert.equal(h.averageUnitCost, Math.round(70000 / 6));
  // Which is not the mean of 10000 and 20000.
  assert.notEqual(h.averageUnitCost, 15000);
});

test('a movement with no price is not a free delivery', () => {
  /**
   * A stock movement can carry a zero cost — a count correction, an
   * adjustment, an ingredient added before anybody knew what it cost.
   * Averaging those in would report that rice gets cheaper every time somebody
   * recounts the shelf.
   */
  const h = priceHistory([
    buy('2026-01-01', 5, 10000),
    buy('2026-01-05', 3, 0),
    { at: 'not a date', qty: 2, unitCost: 9000 },
    buy('2026-01-09', -4, 10000),
  ]);
  assert.equal(h.points.length, 1);
  assert.equal(h.averageUnitCost, 10000);
  assert.equal(h.totalQty, 5);
});

test('nothing bought yet says nothing rather than nought', () => {
  const h = priceHistory([]);
  assert.deepEqual(h.points, []);
  assert.equal(h.first, null);
  assert.equal(h.latest, null);
  assert.equal(h.averageUnitCost, null);
  assert.equal(h.moveBp, null);
  assert.equal(priceMoveNote(h), null);
});

test('one purchase has not moved', () => {
  // A single price is not a trend, and calling it one would put "Up 0%" in
  // front of somebody who has bought a thing once.
  const h = priceHistory([buy('2026-01-01', 5, 10000)]);
  assert.equal(h.moveBp, null);
  assert.equal(priceMoveNote(h), null);
});

test('the note holds its tongue about a wobble', () => {
  /**
   * Prices move by rounding and by which market somebody went to. Calling half
   * a percent a rise makes this line cry wolf until nobody reads it — and the
   * one time it matters, it will be the line they have learned to skip.
   */
  const steady = priceHistory([buy('2026-01-01', 1, 10000), buy('2026-02-01', 1, 10050)]);
  assert.equal(priceMoveNote(steady), 'The price has held steady.');

  const risen = priceHistory([buy('2026-01-01', 1, 10000), buy('2026-02-01', 1, 11800)]);
  assert.match(priceMoveNote(risen) ?? '', /^Up 18% since the first of 2 purchases\.$/);

  const fallen = priceHistory([buy('2026-01-01', 1, 10000), buy('2026-02-01', 1, 8000)]);
  assert.match(priceMoveNote(fallen) ?? '', /^Down 20%/);
});
