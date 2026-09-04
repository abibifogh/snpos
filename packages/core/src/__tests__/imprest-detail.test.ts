import test from 'node:test';
import assert from 'node:assert/strict';
import {
  movementTitle, movementRows, expenseRows, amountDisagreesWords, noDetailWords, whenWords,
} from '../imprest-detail.ts';
import type { DetailNames } from '../imprest-detail.ts';

const money = (n: number) => `GH¢${(n / 100).toFixed(2)}`;
const names: DetailNames = {
  people: { u1: 'Regina', u2: 'Betty' },
  suppliers: { s1: 'Kaneshie Market' },
  categories: { food: 'Food and provisions' },
  shifts: { sh1: 'Tuesday evening' },
};

const spend = {
  $id: 'm1', kind: 'spend', amount: -156000, occurred_at: '2026-08-30T10:00:00.000Z',
  note: 'BISTRO-26/08/2026', created_by: 'u1', ref_type: 'expense', ref_id: 'e1', entry_id: 'j1',
};

test('the panel opens with the figure and which way it went', () => {
  /**
   * The row that was clicked said "Spent · BISTRO-26/08/2026 · GH¢1,560.00",
   * which is a note somebody typed in a hurry. What the money was, who spent
   * it and whether it reached the books was all recorded and none of it was
   * reachable from the screen it belongs on.
   */
  const rows = movementRows({ movement: spend, kindLabel: 'Spent', names, money });
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.label, r.value]), [
    ['Out of the box', 'GH¢1560.00'],
    ['What', 'Spent'],
  ]);
  assert.equal(movementTitle(spend, 'Spent'), 'Spent · out of the box');
  assert.ok(rows.some((r) => r.label === 'Recorded by' && r.value === 'Regina'));
  assert.ok(rows.some((r) => r.label === 'Note on the movement' && r.value === 'BISTRO-26/08/2026'));
});

test('money in reads as money in, not as a negative amount out', () => {
  const rows = movementRows({
    movement: { $id: 'm2', kind: 'top_up', amount: 200000 }, kindLabel: 'Topped up', money,
  });
  assert.deepEqual([rows[0].label, rows[0].value], ['Into the box', 'GH¢2000.00']);
  assert.equal(movementTitle({ $id: 'm2', kind: 'top_up', amount: 200000 }, 'Topped up'), 'Topped up · into the box');
});

test('a spend that never reached the books says so on its own line', () => {
  /**
   * Money out of a box that the accounts have never heard of will not appear
   * in any report the owner reads. A missing line is exactly how that stays
   * unnoticed, so it gets a line saying no.
   */
  const rows = movementRows({ movement: { ...spend, entry_id: '' }, kindLabel: 'Spent', money });
  const books = rows.find((r) => r.label === 'In the books');
  assert.equal(books?.value, 'No entry was posted');
  assert.match(String(books?.hint), /accounts have no record of it/);

  const posted = movementRows({ movement: spend, kindLabel: 'Spent', money })
    .find((r) => r.label === 'In the books');
  assert.equal(posted?.value, 'Yes');
});

test('a top-up is not asked whether it reached the books', () => {
  // It is a transfer between two places the business already owns. Asking
  // would put a question mark on a row that has no answer to give.
  const rows = movementRows({
    movement: { $id: 'm2', kind: 'top_up', amount: 200000 }, kindLabel: 'Topped up', money,
  });
  assert.equal(rows.some((r) => r.label === 'In the books'), false);
});

test('the expense shows people rather than ids', () => {
  const rows = expenseRows({
    expense: {
      $id: 'e1', amount: 156000, category_key: 'food', supplier_id: 's1',
      module: 'kitchen', shift_id: 'sh1', created_by: 'u1', note: 'Vegetables',
    },
    names,
    money,
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel['What for'], 'Food and provisions');
  assert.equal(byLabel['Paid to'], 'Kaneshie Market');
  assert.equal(byLabel.Shift, 'Tuesday evening');
  assert.equal(byLabel['Spent by'], 'Regina');
  assert.equal(byLabel['Note on the expense'], 'Vegetables');
});

test('an id that no longer resolves says that, rather than showing the id', () => {
  /*
    A raw id on a screen is worse than nothing: it looks like data, so somebody
    tries to make sense of it. Saying the person is gone is the true answer and
    is actionable in a way "u9" is not.
  */
  const rows = expenseRows({
    expense: { $id: 'e1', created_by: 'u9', paid_to_staff_id: 'u9' }, names, money,
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel['Spent by'], 'Somebody no longer on the staff list');
  assert.equal(byLabel['Paid to'], 'Somebody no longer on the staff list');
});

test('a payee typed by hand is used where there is no supplier or staff member', () => {
  const rows = expenseRows({ expense: { $id: 'e1', payee: 'Trotro fare' }, names, money });
  assert.equal(rows.find((r) => r.label === 'Paid to')?.value, 'Trotro fare');
});

test('approval is shown only where it says something', () => {
  /**
   * "Not required" on every row trains somebody to skip the line, which is a
   * habit they then have on the one day it says "waiting".
   */
  const quiet = expenseRows({
    expense: { $id: 'e1', approval_status: 'not_required' }, names, money,
  });
  assert.equal(quiet.some((r) => r.label === 'Approval'), false);

  const waiting = expenseRows({ expense: { $id: 'e1', approval_status: 'pending' }, names, money });
  assert.match(String(waiting.find((r) => r.label === 'Approval')?.value), /Waiting/);

  const done = expenseRows({
    expense: { $id: 'e1', approval_status: 'approved', approved_by: 'u2' }, names, money,
  });
  assert.equal(done.find((r) => r.label === 'Approval')?.value, 'Betty');
});

test('a movement and its expense disagreeing is explained, not left as a discrepancy', () => {
  /**
   * An expense corrected after the fact leaves the original movement written
   * and a correcting one beside it — deliberately, so the box's history adds
   * up. Somebody reading one of the pair sees a figure that does not match the
   * expense it names, and will go looking for a fault that is not there.
   */
  const words = String(amountDisagreesWords(spend, { $id: 'e1', amount: 100000 }, money));
  assert.match(words, /took GH¢1560.00 out of the box/);
  assert.match(words, /expense now says GH¢1000.00/);
  assert.match(words, /what a correction looks like/);

  // And when they agree, nothing is said at all.
  assert.equal(amountDisagreesWords(spend, { $id: 'e1', amount: 156000 }, money), null);
});

test('the four reasons there is nothing more to show are four different sentences', () => {
  /**
   * "No detail" on a top-up is correct and unremarkable. On a spend it means a
   * record has gone missing. Those two must not read the same, or the second
   * one never gets noticed.
   */
  assert.match(String(noDetailWords({ $id: 'm', kind: 'top_up', amount: 1 }, false)), /already owns/);
  assert.match(String(noDetailWords({ $id: 'm', kind: 'return', amount: -1 }, false)), /taken back out/);
  assert.match(String(noDetailWords({ $id: 'm', kind: 'adjust', amount: -1 }, false)), /what a count found/);
  assert.match(
    String(noDetailWords({ $id: 'm', kind: 'spend', amount: -1 }, false)),
    /straight against the box, with no expense behind it/,
  );
  assert.match(
    String(noDetailWords({ $id: 'm', kind: 'spend', amount: -1, ref_id: 'e1' }, false)),
    /could not be found/,
  );
  // And a spend whose expense IS there has nothing to apologise for.
  assert.equal(noDetailWords({ $id: 'm', kind: 'spend', amount: -1, ref_id: 'e1' }, true), null);
});

test('a time that cannot be read is shown as it was stored, not as Invalid Date', () => {
  assert.equal(whenWords(undefined, undefined), 'Not recorded');
  assert.equal(whenWords('not a date'), 'not a date');
  assert.equal(
    whenWords('2026-08-30T10:00:00.000Z', undefined, (d) => d.toISOString()),
    '2026-08-30T10:00:00.000Z',
  );
});
