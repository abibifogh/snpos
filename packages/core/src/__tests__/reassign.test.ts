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
