import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countsForPhase, countsByPhase, phaseSummary, bothEndsWords, countsGapWords,
} from '../shift-counts.ts';

const cash = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

const entry = (over: Record<string, unknown> = {}) => ({
  itemId: 'i1',
  name: 'Guinness 330ml',
  phase: 'close' as const,
  counted: 5,
  expected: 5,
  varianceQty: 0,
  varianceValue: 0,
  ...over,
}) as Parameters<typeof countsForPhase>[0][number];

test('each count is set against its own expected figure, not against the other count', () => {
  /**
   * The question a count answers is "does what is on the shelf match what
   * should be there" — asked twice, with two different answers to "should be".
   * At the open it is what the shift before left; at the close it is that
   * opening figure less everything the tills sold.
   *
   * Setting the opening count against the CLOSING count answers a different
   * and less useful question: what left the shelf, without saying whether that
   * was right.
   */
  const { open, close } = countsByPhase([
    entry({ phase: 'open', counted: 12, expected: 14, varianceQty: -2, varianceValue: -600 }),
    entry({ phase: 'close', counted: 5, expected: 6, varianceQty: -1, varianceValue: -300 }),
  ]);

  assert.deepEqual(
    [open[0].counted, open[0].expected, open[0].varianceQty],
    [12, 14, -2],
  );
  assert.deepEqual(
    [close[0].counted, close[0].expected, close[0].varianceQty],
    [5, 6, -1],
  );
});

test('one end counted is still shown, and the other is empty rather than nought', () => {
  // Half a record is a great deal better than none, but a missing count is
  // missing — treating it as zero would invent a shelf that emptied.
  const { open, close } = countsByPhase([entry({ phase: 'open', counted: 12 })]);
  assert.equal(open.length, 1);
  assert.equal(close.length, 0);
});

test('a line left blank is blank, not nought', () => {
  // Somebody who did not count a shelf has not said it is empty.
  const [row] = countsForPhase([entry({ counted: null })], 'close');
  assert.equal(row.counted, null);
});

test('a thing counted twice at one end takes the correction', () => {
  const [row] = countsForPhase([
    entry({ counted: 5, varianceQty: -1 }),
    entry({ counted: 6, varianceQty: 0 }),
  ], 'close');
  assert.equal(row.counted, 6);
  assert.equal(row.varianceQty, 0);
});

test('worst first, because a page sorted by name buries the one that matters', () => {
  const rows = countsForPhase([
    entry({ itemId: 'a', name: 'Amarula', varianceQty: 0, varianceValue: 0 }),
    entry({ itemId: 'z', name: 'Zonin', varianceQty: -9, varianceValue: -4300 }),
    entry({ itemId: 'm', name: 'Malt', varianceQty: -1, varianceValue: -500 }),
  ], 'close');
  assert.deepEqual(rows.map((r) => r.name), ['Zonin', 'Malt', 'Amarula']);
});

test('the summary separates short from over and nets them', () => {
  const rows = countsForPhase([
    entry({ itemId: 'a', name: 'A', varianceQty: -3, varianceValue: -900 }),
    entry({ itemId: 'b', name: 'B', varianceQty: 2, varianceValue: 600 }),
    entry({ itemId: 'c', name: 'C', varianceQty: 0, varianceValue: 0 }),
  ], 'close');
  const s = phaseSummary(rows);
  assert.equal(s.short, 1);
  // Positive, because it is a loss and a negative loss reads backwards.
  assert.equal(s.shortValue, 900);
  assert.equal(s.over, 1);
  assert.equal(s.overValue, 600);
  // So a sheet that balances out reads as balanced rather than as two problems.
  assert.equal(s.netValue, 300);
  assert.equal(s.counted, 3);
});

test('a count an admin took back is not totalled as a shortage', () => {
  const rows = countsForPhase([
    entry({ varianceQty: -9, varianceValue: -4300, undone: true }),
  ], 'close');
  assert.equal(rows[0].undone, true, 'still shown, and marked');
  assert.equal(phaseSummary(rows).short, 0);
  assert.equal(phaseSummary(rows).shortValue, 0);
});

test('a shift that opened short inherited the problem, and is told so', () => {
  /**
   * The reason both ends are reported rather than only the close. Read alone a
   * closing shortage accuses whoever worked the shift; read against the
   * opening one it may be something they walked into.
   */
  const open = phaseSummary(countsForPhase([entry({ phase: 'open', varianceQty: -3, varianceValue: -900 })], 'open'));
  const closed = phaseSummary(countsForPhase([entry({ phase: 'close' })], 'close'));
  const words = String(bothEndsWords(open, closed, cash));
  assert.match(words, /opened GH₵9\.00 short/);
  assert.match(words, /before this shift started/);
});

test('a shift that opened square and closed short made the problem', () => {
  const open = phaseSummary(countsForPhase([entry({ phase: 'open' })], 'open'));
  const closed = phaseSummary(countsForPhase([entry({ varianceQty: -3, varianceValue: -900 })], 'close'));
  const words = String(bothEndsWords(open, closed, cash));
  assert.match(words, /closed GH₵9\.00 short/);
  assert.match(words, /happened on this shift/);
});

test('both ends off says to read one against the other', () => {
  const open = phaseSummary(countsForPhase([entry({ phase: 'open', varianceQty: -2, varianceValue: -600 })], 'open'));
  const closed = phaseSummary(countsForPhase([entry({ varianceQty: -3, varianceValue: -900 })], 'close'));
  const words = String(bothEndsWords(open, closed, cash));
  assert.match(words, /opened GH₵6\.00 short and closed GH₵9\.00 short/);
  assert.match(words, /rather than on its own/);
});

test('a night where both ends agreed says nothing', () => {
  // A notice on a shift that did everything right is a notice people learn to
  // scroll past on the one that did not.
  const clean = phaseSummary(countsForPhase([entry()], 'close'));
  assert.equal(bothEndsWords(clean, clean, cash), null);
});

test('over is named as over, not as a shortage', () => {
  const open = phaseSummary(countsForPhase([entry({ phase: 'open' })], 'open'));
  const closed = phaseSummary(countsForPhase([entry({ varianceQty: 4, varianceValue: 1200 })], 'close'));
  assert.match(String(bothEndsWords(open, closed, cash)), /closed GH₵12\.00 over/);
});

test('a missing end of the shift is said, not left to be inferred', () => {
  const rows = countsForPhase([entry()], 'close');
  assert.match(String(countsGapWords([], rows)), /never counted in/);
  assert.match(String(countsGapWords([], rows)), /the shift before it left behind/);
  assert.match(String(countsGapWords(rows, [])), /never counted out/);
  assert.equal(countsGapWords(rows, rows), null);
  assert.equal(countsGapWords([], []), null);
});
