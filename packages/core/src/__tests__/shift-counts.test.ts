import test from 'node:test';
import assert from 'node:assert/strict';
import { pairCounts, countsSummary, countsGapWords } from '../shift-counts.ts';

const entry = (over: Record<string, unknown> = {}) => ({
  itemId: 'i1',
  name: 'Guinness 330ml',
  phase: 'close' as const,
  counted: 5,
  expected: 5,
  varianceQty: 0,
  varianceValue: 0,
  ...over,
}) as Parameters<typeof pairCounts>[0][number];

test('both ends of the shift land on one row', () => {
  /**
   * The whole point. Both counts were already recorded and only ever readable
   * one at a time, so the question people actually ask afterwards — what did
   * they take on, what did they hand over — meant reading two lists and
   * subtracting in your head.
   */
  const [pair] = pairCounts([
    entry({ phase: 'open', counted: 12 }),
    entry({ phase: 'close', counted: 5 }),
  ]);
  assert.equal(pair.opened, 12);
  assert.equal(pair.closed, 5);
  assert.equal(pair.went, 7);
});

test('what left the shelf is not called sold', () => {
  /*
    Opening minus closing is everything that went for any reason — sold,
    spilt, broken, taken — which is exactly why it is worth putting beside
    what the tills say was sold rather than being labelled as though it
    already agreed with them.
  */
  const [pair] = pairCounts([
    entry({ phase: 'open', counted: 10 }),
    entry({ phase: 'close', counted: 3 }),
  ]);
  assert.equal(pair.went, 7);
  assert.ok(!('sold' in pair), 'nothing here claims to be a sales figure');
});

test('one end counted still shows, and never reads as zero at the other', () => {
  /**
   * Half a record is a great deal better than none, but a missing count is
   * missing — treating it as nought would invent a shelf that emptied
   * completely or one that started empty.
   */
  const [opened] = pairCounts([entry({ phase: 'open', counted: 12 })]);
  assert.equal(opened.opened, 12);
  assert.equal(opened.closed, null);
  assert.equal(opened.went, null, 'nothing can be worked out from one end');

  const [closed] = pairCounts([entry({ phase: 'close', counted: 5 })]);
  assert.equal(closed.opened, null);
  assert.equal(closed.went, null);
});

test('a line left blank is blank, not nought', () => {
  // Somebody who did not count a shelf has not said it is empty.
  const [pair] = pairCounts([
    entry({ phase: 'open', counted: null }),
    entry({ phase: 'close', counted: 4 }),
  ]);
  assert.equal(pair.opened, null);
  assert.equal(pair.went, null);
});

test('only the close carries a variance', () => {
  /*
    An opening count SETS the shelf rather than disagreeing with it, so a
    variance recorded against one would be a disagreement with the shift
    before — somebody else's argument, on this shift's row.
  */
  const [pair] = pairCounts([
    entry({ phase: 'open', counted: 12, varianceQty: -3, varianceValue: 900 }),
    entry({ phase: 'close', counted: 5, varianceQty: -1, varianceValue: 300 }),
  ]);
  assert.equal(pair.varianceQty, -1);
  assert.equal(pair.varianceValue, 300);
});

test('worst first, because a page sorted by name buries the one that matters', () => {
  const pairs = pairCounts([
    entry({ itemId: 'a', name: 'Amarula', varianceQty: 0, varianceValue: 0 }),
    entry({ itemId: 'z', name: 'Zonin', varianceQty: -9, varianceValue: 4300 }),
    entry({ itemId: 'm', name: 'Malt', varianceQty: -1, varianceValue: 500 }),
  ]);
  assert.deepEqual(pairs.map((p) => p.name), ['Zonin', 'Malt', 'Amarula']);
});

test('a thing renamed since keeps the name somebody will recognise', () => {
  const [pair] = pairCounts([
    entry({ phase: 'open', name: 'Club small' }),
    entry({ phase: 'close', name: 'Club 330ml' }),
  ]);
  assert.equal(pair.name, 'Club 330ml');
});

test('the summary separates short from over, and prices only the shortage', () => {
  const pairs = pairCounts([
    entry({ itemId: 'a', name: 'A', varianceQty: -3, varianceValue: -900 }),
    entry({ itemId: 'b', name: 'B', varianceQty: 2, varianceValue: 600 }),
    entry({ itemId: 'c', name: 'C', varianceQty: 0, varianceValue: 0 }),
  ]);
  const s = countsSummary(pairs);
  assert.equal(s.short, 1);
  // Positive, because it is a loss and a negative loss reads backwards.
  assert.equal(s.shortValue, 900);
  assert.equal(s.over, 1);
  assert.equal(s.items, 3);
});

test('a count an admin took back is not counted as a shortage', () => {
  /**
   * It happened — somebody stood at the shelf and wrote a number, and the
   * shelf moved because of it — so the row stays. But the figure has been
   * withdrawn, and adding it to a shortage would total a number that is no
   * longer claimed by anybody.
   */
  const pairs = pairCounts([
    entry({ itemId: 'a', name: 'A', varianceQty: -9, varianceValue: -4300, undone: true }),
  ]);
  assert.equal(pairs[0].undone, true, 'still shown, and marked');
  assert.equal(countsSummary(pairs).short, 0);
  assert.equal(countsSummary(pairs).shortValue, 0);
});

test('a missing end of the shift is said, not left to be inferred', () => {
  const inOnly = countsSummary(pairCounts([entry({ phase: 'open', counted: 12 })]));
  assert.match(String(countsGapWords(inOnly)), /never counted out/);

  const outOnly = countsSummary(pairCounts([entry({ phase: 'close', counted: 5 })]));
  assert.match(String(countsGapWords(outOnly)), /never counted in/);
  // And why it matters: the closing figures are measured against the wrong
  // thing, which is the argument this sentence exists to prevent.
  assert.match(String(countsGapWords(outOnly)), /the shift before it left behind/);
});

test('a complete pair, or nothing counted at all, says nothing', () => {
  // A notice on a shift that did everything right is a notice people learn to
  // scroll past on the one that did not.
  const both = countsSummary(pairCounts([
    entry({ phase: 'open', counted: 12 }), entry({ phase: 'close', counted: 5 }),
  ]));
  assert.equal(countsGapWords(both), null);
  assert.equal(countsGapWords(countsSummary([])), null);
});
