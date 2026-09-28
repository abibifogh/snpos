import test from 'node:test';
import assert from 'node:assert/strict';
import { shelfTrail, trailWarning } from '../shelf-trail.ts';

const bar = 'bar';
const places = { [bar]: 'The bar', store: 'Store room' };

test('each movement shows what the place held straight after, worked back from now', () => {
  // Malt: 30 on the bar this morning after one sold last night from 31.
  const rows = shelfTrail({
    moves: [
      { $id: 'm1', $createdAt: '2026-09-25T20:00:00.000Z', type: 'sale_depletion', qty_delta: -1, location_id: bar, note: 'Malt' },
      { $id: 'm2', $createdAt: '2026-09-25T10:00:00.000Z', type: 'transfer', qty_delta: 12, location_id: bar },
      { $id: 'm3', $createdAt: '2026-09-25T10:00:00.000Z', type: 'transfer', qty_delta: -12, location_id: 'store' },
    ],
    checks: [],
    levels: { [bar]: 30, store: 24 },
    total: 54,
    placeNames: places,
  });
  const sold = rows.find((r) => r.id === 'm1');
  assert.deepEqual([sold?.what, sold?.change, sold?.after, sold?.where], ['Sold', -1, 30, 'The bar']);
  assert.equal(rows.find((r) => r.id === 'm2')?.after, 31);
  assert.equal(rows.find((r) => r.id === 'm3')?.after, 24);
});

test('a count still waiting is shown as the reason the figure has not moved', () => {
  /*
    Counted 30 when the shelf said 31: held for approval, so the shelf stays
    at 31, one sells, and the next count expects 30 instead of 29.
  */
  const rows = shelfTrail({
    moves: [{ $id: 'm1', $createdAt: '2026-09-25T20:00:00.000Z', type: 'sale_depletion', qty_delta: -1, location_id: bar }],
    checks: [{
      $id: 'c1', $createdAt: '2026-09-25T18:00:00.000Z', shift_id: 'sh1', phase: 'open',
      counted_qty: 30, theoretical_qty: 31, variance_qty: -1, applied: false,
    }],
    levels: { [bar]: 30 },
    total: 30,
    placeNames: places,
    shiftCodes: { sh1: 'BAR20260925-8ds8' },
  });
  const count = rows.find((r) => r.id === 'c1');
  assert.equal(count?.what, 'Counted in on BAR20260925-8ds8');
  assert.match(count?.note ?? '', /Found 30, the shelf said 31 \(-1\): WAITING FOR APPROVAL/);
  assert.equal(count?.waiting, true);
  assert.match(trailWarning(rows) ?? '', /waiting for approval/);
});

test('decided counts say how they were decided, and are not a warning', () => {
  const base = { $createdAt: '2026-09-25T18:00:00.000Z', counted_qty: 30, theoretical_qty: 31, variance_qty: -1 };
  const rows = shelfTrail({
    moves: [],
    checks: [
      { ...base, $id: 'a', applied: true },
      { ...base, $id: 'b', applied: false, rejected_at: '2026-09-26T09:00:00.000Z' },
      { ...base, $id: 'c', applied: true, charge_id: 'ch1' },
      { ...base, $id: 'd', variance_qty: 0, counted_qty: 31 },
    ],
    levels: {}, total: 0, placeNames: {},
  });
  const note = (id: string) => rows.find((r) => r.id === id)?.note ?? '';
  assert.match(note('a'), /: applied\.$/);
  assert.match(note('b'), /refused/);
  assert.match(note('c'), /charged to a person/);
  assert.match(note('d'), /matched/);
  assert.equal(trailWarning(rows), null);
});

test('one place only: its own movements, its level, and the counts taken there', () => {
  const input = {
    moves: [
      { $id: 'sold', $createdAt: '2026-09-27T20:00:00.000Z', type: 'sale_depletion', qty_delta: -1, location_id: bar },
      { $id: 'in', $createdAt: '2026-09-27T10:00:00.000Z', type: 'transfer', qty_delta: 12, location_id: bar },
      { $id: 'out', $createdAt: '2026-09-27T10:00:00.000Z', type: 'transfer', qty_delta: -12, location_id: 'store' },
    ],
    checks: [
      { $id: 'shiftcount', $createdAt: '2026-09-27T18:00:00.000Z', shift_id: 'sh1', counted_qty: 11, theoretical_qty: 11, variance_qty: 0 },
      { $id: 'storecount', $createdAt: '2026-09-27T09:00:00.000Z', shift_id: 'store:store', counted_qty: 36, theoretical_qty: 36, variance_qty: 0 },
    ],
    levels: { [bar]: 11, store: 24 },
    total: 35,
    placeNames: places,
  };
  const atBar = shelfTrail({ ...input, onlyAt: { locationId: bar, shiftCounts: true } });
  assert.deepEqual(atBar.map((r) => r.id), ['sold', 'shiftcount', 'in']);
  assert.deepEqual(atBar.filter((r) => r.after !== undefined).map((r) => r.after), [11, 12]);

  const inStore = shelfTrail({ ...input, onlyAt: { locationId: 'store', shiftCounts: false } });
  assert.deepEqual(inStore.map((r) => r.id), ['out', 'storecount']);
  assert.equal(inStore[0]?.after, 24);
});
