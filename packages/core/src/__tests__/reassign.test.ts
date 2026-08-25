import { belongsToShift, shiftDay, shiftsOnDay, dayMoveProblem, backdatedWindow } from '../shift-move.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REASSIGN_MODES, movesStock, movesHistory, needsSplit, inWindow,
  reassignProblem, describeReassign,
} from '../reassign.ts';

const names = { from: 'Ama', to: 'Kofi' };
const counts = { entries: 0, paidOut: 0, moves: 0, onHand: 0 };

test('the four modes differ along the two axes that matter', () => {
  // Stock on the shelf now, and sales already made. Anything that agreed on
  // both would be the same choice offered twice.
  const shape = REASSIGN_MODES.map((m) => `${m.value}:${movesStock(m.value)}/${movesHistory(m.value)}`);
  assert.equal(new Set(shape.map((s) => s.split(':')[1])).size >= 3, true, shape.join(' '));
});

test('only the split leaves the shelf where it is', () => {
  assert.equal(movesStock('split'), false);
  assert.equal(movesStock('future_and_stock'), true);
  assert.equal(movesStock('all_time'), true);
  assert.equal(movesStock('period'), true);
});

test('only all-time and a period touch what is already recorded', () => {
  assert.equal(movesHistory('all_time'), true);
  assert.equal(movesHistory('period'), true);
  assert.equal(movesHistory('future_and_stock'), false);
  assert.equal(movesHistory('split'), false);
});

test('only the split needs a second product row', () => {
  // A product row has one owner, so leaving the old stock with the old maker
  // means the shelf has to become two products. Nothing else does.
  assert.equal(needsSplit('split'), true);
  for (const m of ['future_and_stock', 'all_time', 'period'] as const) {
    assert.equal(needsSplit(m), false, m);
  }
});

test('every record is in the window when the mode takes everything', () => {
  assert.equal(inWindow('all_time', undefined), true);
  assert.equal(inWindow('future_and_stock', '2020-01-01'), true);
});

test('a period includes both of its days', () => {
  // Somebody typing the day the supplier changed means that whole day. A
  // window stopping at midnight the night before leaves a day behind with
  // nothing on screen to say so.
  const from = '2026-08-01T00:00:00.000Z';
  const to = '2026-08-31T23:59:59.999Z';
  assert.equal(inWindow('period', '2026-08-01T00:00:00.000Z', from, to), true);
  assert.equal(inWindow('period', '2026-08-31T23:59:59.000Z', from, to), true);
  assert.equal(inWindow('period', '2026-07-31T23:59:59.999Z', from, to), false);
  assert.equal(inWindow('period', '2026-09-01T00:00:00.000Z', from, to), false);
});

test('a record with no date is not swept into a period', () => {
  assert.equal(inWindow('period', undefined, '2026-08-01', '2026-08-31'), false);
});

test('the obvious mistakes are refused', () => {
  assert.match(reassignProblem({ mode: 'all_time', fromId: 'a' }) ?? '', /Choose the supplier/);
  assert.match(reassignProblem({ mode: 'all_time', fromId: 'a', toId: 'a' }) ?? '', /already the supplier/);
  assert.match(reassignProblem({ mode: 'period', fromId: 'a', toId: 'b' }) ?? '', /both dates/);
  assert.match(
    reassignProblem({ mode: 'period', fromId: 'a', toId: 'b', from: '2026-09-01', to: '2026-08-01' }) ?? '',
    /after the second/,
  );
  assert.equal(reassignProblem({ mode: 'all_time', fromId: 'a', toId: 'b' }), null);
});

test('the split says both suppliers keep what is theirs', () => {
  const said = describeReassign('split', names, { ...counts, onHand: 4 });
  assert.match(said, /second "Kofi" product is created/);
  assert.match(said, /4 on the shelf stay with Ama/);
  assert.match(said, /Ama is still paid/);
});

test('moving from now on says the past is untouched', () => {
  const said = describeReassign('future_and_stock', names, { ...counts, onHand: 2 });
  assert.match(said, /becomes Kofi's/);
  assert.match(said, /2 on the shelf move to Kofi/);
  assert.match(said, /Sales already made stay with Ama/);
});

test('moving history says how much money is changing hands', () => {
  // "23 records will be updated" tells nobody whether their supplier is about
  // to be paid for a year of somebody else's baskets.
  const said = describeReassign('all_time', names, { entries: 12, paidOut: 0, moves: 5, onHand: 1 });
  assert.match(said, /12 statement entries and 5 stock movements move from Ama to Kofi/);
});

test('entries already paid for are named as staying put', () => {
  const said = describeReassign('all_time', names, { entries: 12, paidOut: 3, moves: 5, onHand: 0 });
  assert.match(said, /3 cannot move because Ama has already been paid/);
});

test('one of something reads as one', () => {
  const said = describeReassign('all_time', names, { entries: 1, paidOut: 1, moves: 1, onHand: 1 });
  assert.match(said, /1 statement entry and 1 stock movement/);
  assert.match(said, /1 cannot move .* it stays where it is/);
});

/* ---------------------------------------------- moving an order by date */

test('an order stamped to a shift belongs to that one and no other', () => {
  /*
    THE FAULT UNDER THE WHOLE FEATURE.

    "Stamped to me OR rung up while I was open" means an order moved to
    another shift still answers yes to the second for ever — so a sale moved
    to the night it belonged to was counted on BOTH, and the two shifts
    disagreed from then on.
  */
  const order = { shift_id: 'tuesday', module: 'bar', $createdAt: '2026-08-24T20:00:00.000Z' };
  const monday = { $id: 'monday', module: 'bar', opened_at: '2026-08-24T18:00:00.000Z', closed_at: '2026-08-25T01:00:00.000Z' };
  assert.equal(belongsToShift(order, monday), false);
  assert.equal(belongsToShift(order, { ...monday, $id: 'tuesday' }), true);
});

test('an order with no stamp falls back to the clock', () => {
  // Orders written before shifts were stamped, and guest orders that arrive
  // with none at all. Without the fallback a night's takings would vanish.
  const order = { module: 'bar', $createdAt: '2026-08-24T20:00:00.000Z' };
  const shift = { $id: 'monday', module: 'bar', opened_at: '2026-08-24T18:00:00.000Z', closed_at: '2026-08-25T01:00:00.000Z' };
  assert.equal(belongsToShift(order, shift), true);
  assert.equal(belongsToShift({ ...order, $createdAt: '2026-08-24T17:00:00.000Z' }, shift), false);
});

test('a window catches the building, so the side is still checked', () => {
  const order = { module: 'kitchen', $createdAt: '2026-08-24T20:00:00.000Z' };
  const bar = { $id: 'b', module: 'bar', opened_at: '2026-08-24T18:00:00.000Z', closed_at: '2026-08-25T01:00:00.000Z' };
  assert.equal(belongsToShift(order, bar), false);
});

test('a shift is reported under the day it opened', () => {
  /*
    Not the day it closed. A bar that opens at six and closes at two did one
    night's trading, and filing it under the following day puts every late
    night in the wrong month.
  */
  const evening = new Date('2026-08-24T20:00:00');
  const shift = { opened_at: evening.toISOString() };
  assert.equal(shiftDay(shift), evening.toLocaleDateString('en-CA'));
  assert.equal(shiftDay({}), '');
});

test('a day can hold more than one shift, and they come back in order', () => {
  // A bar handed over at eight and closed at two is two shifts and one night.
  const day = new Date('2026-08-24T12:00:00').toLocaleDateString('en-CA');
  const base = { code: 'X', status: 'closed', venue_id: 'main' };
  const early = { ...base, $id: 'early', module: 'bar', opened_at: new Date('2026-08-24T10:00:00').toISOString() };
  const late = { ...base, $id: 'late', module: 'bar', opened_at: new Date('2026-08-24T18:00:00').toISOString() };
  const other = { ...base, $id: 'kitchen', module: 'kitchen', opened_at: new Date('2026-08-24T10:00:00').toISOString() };
  assert.deepEqual(shiftsOnDay([late, early, other], day, 'bar').map((s) => s.$id), ['early', 'late']);
});

test('a sale cannot be filed under a day that has not happened', () => {
  // Money in a period nobody will look at until it is far too late to notice.
  const order = {
    $id: 'o', order_no: 'ORD1', venue_id: 'main', status: 'CLOSED',
    $createdAt: '2026-08-24T20:00:00.000Z',
  };
  assert.match(dayMoveProblem(order, '2026-09-01', '2026-08-25') ?? '', /has not happened yet/);
  assert.match(dayMoveProblem(order, '', '2026-08-25') ?? '', /Pick the day/);
  assert.equal(dayMoveProblem(order, '2026-08-20', '2026-08-25'), null);
});

test('a back-dated shift covers the whole of its day', () => {
  // So anything moved onto it falls inside its window however late it was
  // rung up, and it is created closed: an open shift on a past day would be
  // found by every till as the one to sell against.
  const { openedAt, closedAt } = backdatedWindow('2026-08-20');
  assert.equal(new Date(openedAt).toLocaleDateString('en-CA'), '2026-08-20');
  assert.equal(new Date(closedAt).toLocaleDateString('en-CA'), '2026-08-20');
  assert.ok(openedAt < closedAt);
});
