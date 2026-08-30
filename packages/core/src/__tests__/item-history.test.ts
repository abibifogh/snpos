import test from 'node:test';
import assert from 'node:assert/strict';
import {
  historyRows, historyTotals, byDay, byPerson, emptyHistoryWords, daysBetween,
} from '../item-history.ts';

const line = (over: Record<string, unknown> = {}) => ({
  $id: 'l1', order_id: 'o1', menu_item_id: 'm1', name_snapshot: 'Club sandwich',
  qty: 2, line_total: 19_000, ...over,
}) as Parameters<typeof historyRows>[0][number];

const order = (over: Record<string, unknown> = {}) => ({
  $id: 'o1', $createdAt: '2026-08-28T18:29:25.000Z', order_no: 'ORD0336',
  status: 'SERVED', payment_status: 'paid', placed_by: 'u1', ...over,
}) as Parameters<typeof historyRows>[1][number];

const names: Record<string, string> = { u1: 'Stephanie', u2: 'Chichi' };
const nameOf = (id?: string) => (id ? names[id] ?? id : 'Unknown');

test('every row names the order, the moment, the person and the money', () => {
  /**
   * The four things asked in the follow-up question, put on the screen before
   * it has to be asked. A bare count invites the wrong argument: twelve sold
   * is a statistic, twelve sold by one person on one evening is a fact.
   */
  const [row] = historyRows([line()], [order()], nameOf);
  assert.equal(row.orderNo, 'ORD0336');
  assert.equal(row.at, '2026-08-28T18:29:25.000Z');
  assert.equal(row.soldBy, 'Stephanie');
  assert.equal(row.paymentStatus, 'paid');
  assert.equal(row.qty, 2);
  assert.equal(row.value, 19_000);
});

test('the name is the one it was sold under, and its size', () => {
  /*
    Not today's name. A dish renamed last month did not retrospectively change
    what was on the bill, and a history that says otherwise is a history nobody
    can match against a printed receipt.
  */
  const rows = historyRows(
    [line({ name_snapshot: 'Club sandwich (old)', variant_label: 'Large' })],
    [order()],
    nameOf,
  );
  assert.equal(rows[0].name, 'Club sandwich (old) · Large');
});

test('newest first', () => {
  const rows = historyRows(
    [line({ $id: 'a', order_id: 'old' }), line({ $id: 'b', order_id: 'new' })],
    [
      order({ $id: 'old', $createdAt: '2026-08-01T10:00:00.000Z', order_no: 'ORD0001' }),
      order({ $id: 'new', $createdAt: '2026-08-28T10:00:00.000Z', order_no: 'ORD0336' }),
    ],
    nameOf,
  );
  assert.deepEqual(rows.map((r) => r.orderNo), ['ORD0336', 'ORD0001']);
});

test('a voided line is kept and marked, never dropped', () => {
  /**
   * "It was rung up and then taken off" is a different fact from "it was never
   * rung up", and it is the more interesting of the two — a line voided four
   * times in a week is exactly what somebody opened this screen to find.
   */
  const rows = historyRows([line({ status: 'void' })], [order()], nameOf);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].voided, true);

  const totals = historyTotals(rows);
  assert.equal(totals.qty, 0, 'a voided line did not sell');
  assert.equal(totals.voidedQty, 2, 'but it is counted, apart');
});

test('a line whose bill is not in the period is left out, not shown blank', () => {
  // With no order there is no date and no number, so the row would sort to
  // nowhere and read as a line of dashes.
  assert.deepEqual(historyRows([line({ order_id: 'gone' })], [order()], nameOf), []);
});

test('a cancelled bill sold nothing, whatever is written on it', () => {
  const rows = historyRows([line()], [order({ status: 'CANCELLED' })], nameOf);
  assert.equal(historyTotals(rows).qty, 0);
  assert.equal(historyTotals(rows).bills, 0);
});

test('what has gone out and not been paid for is counted on its own', () => {
  /*
    The figure worth having beside the total. Ten sold and four unpaid is a
    different day from ten sold, and the second number is the one that goes
    looking for a bill somebody forgot to settle.
  */
  const rows = historyRows(
    [line({ $id: 'a', order_id: 'paid' }), line({ $id: 'b', order_id: 'owing', qty: 1, line_total: 9500 })],
    [order({ $id: 'paid' }), order({ $id: 'owing', payment_status: 'unpaid' })],
    nameOf,
  );
  const totals = historyTotals(rows);
  assert.equal(totals.qty, 3);
  assert.equal(totals.value, 28_500);
  assert.equal(totals.unpaidQty, 1);
  assert.equal(totals.unpaidValue, 9500);
  // Two lines, two bills. The count is of bills, not of lines.
  assert.equal(totals.bills, 2);
});

test('a refund is not counted as still owing', () => {
  // The money was taken and given back on purpose. Listing it as unpaid would
  // send somebody chasing a customer who owes nothing.
  const rows = historyRows([line()], [order({ payment_status: 'refunded' })], nameOf);
  assert.equal(historyTotals(rows).unpaidQty, 0);
});

test('the same bill twice is one bill', () => {
  const rows = historyRows(
    [line({ $id: 'a' }), line({ $id: 'b', qty: 1, line_total: 9500 })],
    [order()],
    nameOf,
  );
  assert.equal(historyTotals(rows).bills, 1);
  assert.equal(historyTotals(rows).qty, 3);
});

test('by day, oldest first, with the dead lines out', () => {
  const rows = historyRows(
    [
      line({ $id: 'a', order_id: 'd1' }),
      line({ $id: 'b', order_id: 'd2', qty: 1, line_total: 9500 }),
      line({ $id: 'c', order_id: 'd2', status: 'void' }),
    ],
    [
      order({ $id: 'd2', $createdAt: '2026-08-28T09:00:00.000Z' }),
      order({ $id: 'd1', $createdAt: '2026-08-26T09:00:00.000Z' }),
    ],
    nameOf,
  );
  assert.deepEqual(byDay(rows), [
    { day: '2026-08-26', qty: 2, value: 19_000 },
    { day: '2026-08-28', qty: 1, value: 9500 },
  ]);
});

test('who sold it, most first', () => {
  const rows = historyRows(
    [line({ $id: 'a', order_id: 'x' }), line({ $id: 'b', order_id: 'y', qty: 5, line_total: 47_500 })],
    [order({ $id: 'x', placed_by: 'u1' }), order({ $id: 'y', placed_by: 'u2' })],
    nameOf,
  );
  assert.deepEqual(byPerson(rows), [
    { who: 'Chichi', qty: 5, value: 47_500 },
    { who: 'Stephanie', qty: 2, value: 19_000 },
  ]);
});

test('nothing found says which of the two it might be', () => {
  /**
   * An empty table is ambiguous in a way that matters: it could mean this
   * never sells, or it could mean the period is wrong, and those lead
   * somewhere completely different.
   */
  const words = emptyHistoryWords(30);
  assert.match(words, /30 days/);
  assert.match(words, /the period is not the one you meant/);
  assert.match(emptyHistoryWords(1), /the day chosen/);
});

test('the period is counted inclusively, both ends', () => {
  // One day chosen is one day, not nought. Somebody looking at a single date
  // is asking about that date.
  assert.equal(daysBetween('2026-08-28', '2026-08-28'), 1);
  assert.equal(daysBetween('2026-08-01', '2026-08-31'), 31);
  // Backwards, or unreadable, is nothing rather than a negative sentence.
  assert.equal(daysBetween('2026-08-31', '2026-08-01'), 0);
  assert.equal(daysBetween('not a date', '2026-08-01'), 0);
});
