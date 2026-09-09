import test from 'node:test';
import assert from 'node:assert/strict';
import {
  waitingList, waitingCounts, waitingSummary, isShelfChange, SHELF_CHANGE_NOTE, refuseSpendWords, waitedWords,
} from '../waiting.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

const input = {
  barCounts: [
    { shiftId: 'sh1', phase: 'close' as const, at: '2026-09-03T22:10:00Z', worth: -4_500, changed: 3, pending: 3, countedBy: 'ama' },
    // Nothing pending on it: already decided, so not waiting.
    { shiftId: 'sh0', phase: 'open' as const, at: '2026-09-01T09:00:00Z', worth: -100, changed: 1, pending: 0 },
    { shiftId: 'store:cellar', phase: 'close' as const, at: '2026-09-05T10:00:00Z', worth: 900, changed: 1, pending: 1, countedBy: 'kofi' },
  ],
  shopCounts: [
    { $id: 'c1', counted_by: 'efua', counted_at: '2026-09-02T15:00:00Z', note: '', line_count: 40, missing_pieces: 2, missing_value: 12_000, surplus_pieces: 1 },
    { $id: 'c2', counted_by: 'efua', counted_at: '2026-09-06T15:00:00Z', note: SHELF_CHANGE_NOTE, line_count: 1, missing_pieces: 0, missing_value: 0, surplus_pieces: 2 },
  ],
  shelfLines: [{ countId: 'c2', name: 'Kente scarf · Blue', expected: 3, counted: 5 }],
  spends: [
    { $id: 'e1', amount: 2_500, payee: 'Taxi', category_key: 'transport', created_by: 'kofi', $createdAt: '2026-09-04T12:00:00Z' },
  ],
  tabShifts: [
    { $id: 'sh2', code: 'BIST-08', module: 'kitchen', venue_id: 'main', opened_at: '2026-09-07T08:00:00Z', tabOrders: 2, tabValue: 34_000 },
    { $id: 'sh3', code: 'BAR-02', opened_at: '2026-09-07T09:00:00Z', tabOrders: 0, tabValue: 0 },
  ],
  shiftCodes: { sh1: 'BAR-01' },
  storeNames: { cellar: 'Cellar' },
  categoryNames: { transport: 'Transport' },
  money,
};

test('one row each, oldest first, and nothing that is not actually waiting', () => {
  const items = waitingList(input);
  assert.deepEqual(items.map((i) => i.id), [
    'shop:c1', 'bar:sh1:close', 'spend:e1', 'bar:store:cellar:close', 'shelf:c2', 'tab:sh2',
  ]);
  assert.deepEqual(waitingCounts(items), { count: 3, spend: 1, shelf: 1, tab: 1 });
});

test('each row says what it is in the words of the person deciding it', () => {
  const items = waitingList(input);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by['bar:sh1:close'].title, 'Bar count, counted out on BAR-01');
  assert.match(by['bar:sh1:close'].detail, /3 lines differ .* worth GH₵45\.00/);
  assert.equal(by['bar:store:cellar:close'].title, 'Cellar count');
  assert.equal(by['shop:c1'].title, 'Shop stocktake, 40 pieces');
  assert.match(by['shop:c1'].detail, /2 pieces missing, 1 extra, worth GH₵120\.00/);
  assert.equal(by['shelf:c2'].title, 'Kente scarf · Blue: 3 → 5');
  assert.equal(by['spend:e1'].title, 'GH₵25.00 to Taxi · Transport');
  assert.equal(by['tab:sh2'].title, 'BIST-08 cannot close: 2 orders on tabs, GH₵340.00');
  assert.deepEqual(by['tab:sh2'].ref, { kind: 'tab', shiftId: 'sh2', module: 'kitchen', venueId: 'main' });
  // Who, so the screen can name them.
  assert.equal(by['spend:e1'].by, 'kofi');
  assert.equal(by['shop:c1'].by, 'efua');
});

test('a shelf change is a one-line count carrying the products page note, and nothing else is', () => {
  assert.equal(isShelfChange({ note: SHELF_CHANGE_NOTE, line_count: 1 }), true);
  assert.equal(isShelfChange({ note: `${SHELF_CHANGE_NOTE} `, line_count: 1 }), true);
  assert.equal(isShelfChange({ note: SHELF_CHANGE_NOTE, line_count: 2 }), false);
  assert.equal(isShelfChange({ note: 'Monthly count', line_count: 1 }), false);
  // A shelf change whose line cannot be found still shows, without the numbers.
  const items = waitingList({ ...input, shelfLines: [] });
  assert.equal(items.find((i) => i.id === 'shelf:c2')?.title, 'A shelf change');
});

test('a count that found nothing wrong still waits, and says so', () => {
  const items = waitingList({
    ...input, barCounts: [], spends: [], tabShifts: [],
    shopCounts: [{ $id: 'c3', counted_by: 'efua', counted_at: '2026-09-02T15:00:00Z', line_count: 12, missing_pieces: 0, missing_value: 0, surplus_pieces: 0 }],
  });
  assert.match(items[0].detail, /Everything counted matched the shelf/);
});

test('the heading counts what is there', () => {
  assert.equal(waitingSummary([]), 'Nothing is waiting for you.');
  assert.equal(waitingSummary(waitingList(input)), '6 things are waiting: 3 counts, 1 spends, 1 shelf changes, 1 tabs to release.');
  assert.equal(waitingSummary(waitingList({ ...input, barCounts: [], shopCounts: [], tabShifts: [] })), '1 thing is waiting: 1 spends.');
});

test('rows that never said when they started go last, not first', () => {
  const items = waitingList({ ...input, tabShifts: [{ $id: 'x', tabOrders: 1, tabValue: 100 }] });
  assert.equal(items[items.length - 1].id, 'tab:x');
});

test('refusing a spend says what it does to the drawer', () => {
  assert.match(refuseSpendWords('drawer', 'GH₵25.00'), /that shift will show short by it/);
  assert.match(refuseSpendWords(undefined, 'GH₵25.00'), /that shift will show short by it/);
  assert.match(refuseSpendWords('own', 'GH₵25.00'), /paid back some other way/);
  assert.match(refuseSpendWords('box', 'GH₵25.00'), /paid back some other way/);
});

test('how long it has waited, in plain words', () => {
  assert.equal(waitedWords(30_000), '1 minute');
  assert.equal(waitedWords(5 * 60_000), '5 minutes');
  assert.equal(waitedWords(3 * 3_600_000), '3 hours');
  assert.equal(waitedWords(26 * 3_600_000), '1 day');
  assert.equal(waitedWords(9 * 86_400_000), '9 days');
});
