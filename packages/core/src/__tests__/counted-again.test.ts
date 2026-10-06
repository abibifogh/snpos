import test from 'node:test';
import assert from 'node:assert/strict';
import {
  replacedLines, olderWaiting, liveCount, shelfKey, replacedWords, filedCounts, storeCountId, type FiledCheck,
} from '../bar-count.ts';
import { barReviewLines } from '../waiting-lines.ts';
import { waitingList } from '../waiting.ts';
import { countDifferencesHtml } from '../count-report.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
const line = (over: Partial<FiledCheck>): FiledCheck => ({
  $id: 'x', $createdAt: '2026-10-01T22:00:00.000Z', shift_id: 'sh1', phase: 'close', ingredient_id: 'malt', module: 'bar',
  theoretical_qty: 12, counted_qty: 10, variance_qty: -2, variance_value: -2_000, applied: false, ...over,
});

// The shelf said 12, 10 were found at close, and nobody approved it. The next
// opening found 10 against the same 12: the same −2, a second time.
const closeOne = line({ $id: 'a' });
const openTwo = line({ $id: 'b', shift_id: 'sh2', phase: 'open', $createdAt: '2026-10-02T08:00:00.000Z' });

test('a waiting line counted again later is replaced by the later one', () => {
  const r = replacedLines([closeOne, openTwo], []);
  assert.equal(r.get('a')?.$id, 'b');
  // The newest is never replaced: it is the one that holds the gap.
  assert.equal(r.has('b'), false);
});

test('the newest later line replaces, whatever state it is in', () => {
  const third = line({ $id: 'c', shift_id: 'sh2', phase: 'close', $createdAt: '2026-10-02T22:00:00.000Z', variance_qty: 0, applied: true });
  const r = replacedLines([closeOne, openTwo], [third]);
  // Counted right the third time: both earlier gaps are out of date.
  assert.equal(r.get('a')?.$id, 'c');
  assert.equal(r.get('b')?.$id, 'c');
});

test('only the same bottle on the same shelf, on another count, filed later', () => {
  const otherBottle = line({ $id: 'o1', ingredient_id: 'club', shift_id: 'sh2', $createdAt: '2026-10-02T08:00:00.000Z' });
  const kitchen = line({ $id: 'o2', module: 'kitchen', shift_id: 'sh2', $createdAt: '2026-10-02T08:00:00.000Z' });
  const store = line({ $id: 'o3', shift_id: storeCountId('cellar'), $createdAt: '2026-10-02T08:00:00.000Z' });
  const earlier = line({ $id: 'o4', shift_id: 'sh0', $createdAt: '2026-09-30T22:00:00.000Z' });
  const sameCount = line({ $id: 'o5', $createdAt: '2026-10-01T22:00:05.000Z' });
  assert.equal(replacedLines([closeOne], [otherBottle, kitchen, store, earlier, sameCount]).size, 0);
  // Rows from before sides were recorded are the bar's.
  assert.equal(shelfKey({ ingredient_id: 'malt', shift_id: 'sh1' }), shelfKey(closeOne));
});

test('a later count refused or taken back replaces nothing', () => {
  const refused = { ...openTwo, rejected_at: '2026-10-02T09:00:00.000Z' };
  const undone = { ...openTwo, applied: true, undone_at: '2026-10-02T09:00:00.000Z' };
  assert.equal(replacedLines([closeOne], [refused]).size, 0);
  assert.equal(replacedLines([closeOne], [undone]).size, 0);
  // And a line already decided is not "waiting" to be replaced.
  assert.equal(replacedLines([{ ...closeOne, applied: true }], [openTwo]).size, 0);
});

test('applying a line sets aside the older waiting ones of the same bottle', () => {
  const unrelated = line({ $id: 'u', ingredient_id: 'club' });
  assert.deepEqual(olderWaiting(openTwo, [closeOne, openTwo, unrelated]).map((l) => l.$id), ['a']);
  assert.deepEqual(olderWaiting(closeOne, [closeOne, openTwo]), []);
});

test('the list leaves replaced lines out of what a count is worth, and says so', () => {
  const club = line({ $id: 'c1', ingredient_id: 'club', variance_qty: -1, variance_value: -3_000 });
  const [count] = filedCounts([closeOne, club]);
  const live = liveCount(count!, new Set(['a']));
  assert.deepEqual([live.pending, live.changed, live.worth, live.replaced], [1, 1, 3_000, 1]);

  const [item] = waitingList({ barCounts: [{ ...live, side: 'bar' }], shopCounts: [], spends: [], tabShifts: [], money });
  assert.match(item!.detail, /1 line differs .* worth GH₵30\.00.*1 more line was counted again later and will be set aside/);

  // Everything replaced: still listed, so it can be cleared.
  const all = liveCount(filedCounts([closeOne])[0]!, new Set(['a']));
  const [only] = waitingList({ barCounts: [{ ...all, side: 'bar' }], shopCounts: [], spends: [], tabShifts: [], money });
  assert.match(only!.detail, /Every line here was counted again/);
});

test('a replaced line is shown, worth nothing, and says why; the PDF says not applied', () => {
  const words = replacedWords('2 Oct 2026, 08:00', 'BAR-12');
  assert.equal(words, 'Counted again on 2 Oct 2026, 08:00 (BAR-12), which already covers this. It will not be applied.');
  const lines = barReviewLines([closeOne], () => 'Malt', () => 1_000, (id) => (id === 'a' ? words : undefined));
  assert.equal(lines[0]!.replaced, true);
  assert.equal(lines[0]!.worth, 0);
  assert.equal(lines[0]!.note, words);
  const html = countDifferencesHtml({
    business: 'Bistro', counts: [{ title: 'Bar count', countedBy: 'Ama', at: '2026-10-01T22:00:00.000Z', lines }],
    money, madeAt: '2026-10-06T09:00:00.000Z', when: (i) => i,
  });
  assert.match(html, /Not applied/);
  assert.match(html, /Short GH₵0\.00/);
});
