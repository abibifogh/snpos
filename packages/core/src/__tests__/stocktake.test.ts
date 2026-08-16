import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wasCounted, differencesIn, summariseCount, countWarnings, MOVE_FOR_REASON,
  type CountLine,
} from '../stocktake.ts';

const line = (over: Partial<CountLine> = {}): CountLine => ({
  menuItemId: 'p1', name: 'Raffia basket', onHand: 5, unitPrice: 12000, ...over,
});

test('blank is not nought', () => {
  /**
   * The single most expensive mistake this screen could make. Somebody counting
   * forty pieces gets through eleven, walks away, and every line they never
   * reached says "0 counted" — which would write off the whole shop in one
   * save. A line with nothing typed was not counted, and nothing is written
   * for it.
   */
  assert.equal(wasCounted(line()), false, 'nothing typed');
  assert.equal(wasCounted(line({ countedText: '' })), false);
  assert.equal(wasCounted(line({ countedText: '   ' })), false);
  assert.equal(wasCounted(line({ countedText: 'x' })), false, 'not a number');
  assert.equal(wasCounted(line({ countedText: '-1' })), false, 'a shelf cannot hold less than none');

  // Nought, deliberately typed, IS a count and means the shelf is empty.
  assert.equal(wasCounted(line({ countedText: '0' })), true);

  const summary = summariseCount([line(), line({ countedText: '0' })]);
  assert.equal(summary.uncountedLines, 1);
  assert.equal(summary.countedLines, 1);
  assert.equal(summary.differences.length, 1, 'only the line somebody actually counted');
});

test('a line that matched writes nothing', () => {
  // A zero movement for every piece in the shop would bury the four that
  // matter under four hundred that do not.
  assert.deepEqual(differencesIn([line({ countedText: '5' })]), []);
});

test('a shortage carries the reason it was given', () => {
  const found = differencesIn([
    line({ countedText: '3', reason: 'damaged' }),
    line({ menuItemId: 'p2', name: 'Beaded necklace', onHand: 4, countedText: '2', reason: 'returned' }),
  ]);

  assert.equal(found[0].delta, -2);
  assert.equal(found[0].reason, 'damaged');
  assert.equal(found[0].value, 24000, 'two pieces at 120.00');
  assert.equal(MOVE_FOR_REASON[found[0].reason], 'damaged');

  assert.equal(found[1].reason, 'returned');
  assert.equal(MOVE_FOR_REASON[found[1].reason], 'return_to_consignor');
});

test('finding MORE than expected can only be a miscount', () => {
  /**
   * "Two extra pieces, because they were damaged" is not a sentence. A damaged
   * movement with a positive quantity would add stock to the shelf and put a
   * loss on the maker's statement in the same breath, which is two wrong
   * things at once.
   */
  const found = differencesIn([line({ countedText: '8', reason: 'damaged' })]);
  assert.equal(found[0].delta, 3);
  assert.equal(found[0].reason, 'counted', 'the dropdown is overruled');
  assert.equal(MOVE_FOR_REASON[found[0].reason], 'adjustment');
});

test('the summary separates a breakage from a disappearance', () => {
  /**
   * The reason the reason is asked for at all. A history that records every
   * loss as "adjustment" cannot answer the only question worth asking of it:
   * is this breakage, or is somebody taking things.
   */
  const summary = summariseCount([
    line({ countedText: '3', reason: 'damaged' }),                                     // −2
    line({ menuItemId: 'p2', name: 'Bowl', onHand: 6, countedText: '2', reason: 'lost' }), // −4
    line({ menuItemId: 'p3', name: 'Mat', onHand: 1, countedText: '3' }),               // +2 surplus
  ]);

  assert.equal(summary.missingPieces, 6);
  assert.equal(summary.surplusPieces, 2);
  assert.equal(summary.missingValue, 24000 + 48000);
  // Dearest loss first, because that is the one to ask about.
  assert.deepEqual(summary.byReason.map((r) => r.reason), ['lost', 'damaged']);
  assert.equal(summary.byReason[0].pieces, 4);
});

test('warnings warn and never refuse', () => {
  /**
   * A shop that has genuinely lost a third of a shelf needs to record that,
   * and a system that argues with the person holding the clipboard is one they
   * stop using. What it can do is make sure nobody saves a catastrophe by
   * accident.
   */
  const emptied = countWarnings([line({ onHand: 9, countedText: '0' })]);
  assert.match(emptied.join(' '), /counted to nothing/);

  const unexplained = countWarnings([line({ countedText: '2' })]);
  assert.match(unexplained.join(' '), /recorded as a miscount/);

  const halfDone = countWarnings([line({ countedText: '5' }), line({ menuItemId: 'p2' })]);
  assert.match(halfDone.join(' '), /left blank/);

  // A clean count says nothing at all.
  assert.deepEqual(countWarnings([line({ countedText: '5' })]), []);
});
