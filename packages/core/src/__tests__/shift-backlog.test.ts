import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTLE_GRACE_MS, backlogState, needsSettling, settlementBacklog, agedWords, stateWords,
  backlogSummary, isClosedShift, isSettledShift,
} from '../shift-backlog.ts';
import type { BacklogShift } from '../shift-backlog.ts';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const shift = (id: string, over: Partial<BacklogShift> = {}): BacklogShift => ({
  $id: id, code: id, status: 'closed', closed_at: daysAgo(5), module: 'kitchen', ...over,
});

test('a closed shift nobody settled is outstanding, and old enough is overdue', () => {
  const old = shift('a', { closed_at: daysAgo(5) });
  assert.equal(backlogState(old, [old], NOW), 'overdue');
  assert.equal(needsSettling('overdue'), true);
});

test('a shift closed last night is waiting, not a warning', () => {
  /**
   * A shift closed at midnight is not a problem at nine the next morning, and
   * flagging it red would put a warning on the screen every single day — which
   * is how a warning stops being read by the time it means something.
   */
  const fresh = shift('a', { closed_at: new Date(NOW - 6 * 3_600_000).toISOString() });
  assert.equal(backlogState(fresh, [fresh], NOW), 'waiting');
  assert.equal(needsSettling('waiting'), false);
  // And the edge: just past the grace is overdue, just inside it is not.
  const edge = (ms: number) => backlogState(
    shift('a', { closed_at: new Date(NOW - ms).toISOString() }), [], NOW,
  );
  assert.equal(edge(SETTLE_GRACE_MS - 1000), 'waiting');
  assert.equal(edge(SETTLE_GRACE_MS + 1000), 'overdue');
});

test('a shift jumped over while later ones were settled is called that', () => {
  /**
   * The case the suggested rule was about, and it keeps its own name: "you
   * skipped this one" and "you are a fortnight behind" are two different
   * conversations with two different fixes.
   */
  const skipped = shift('mid', { closed_at: daysAgo(5) });
  const after = shift('later', { closed_at: daysAgo(2), locked_at: daysAgo(1) });
  assert.equal(backlogState(skipped, [skipped, after], NOW), 'skipped');
  assert.match(
    stateWords({ shift: skipped, state: 'skipped', ageMs: 5 * 86_400_000 }),
    /shifts that closed AFTER it have been/,
  );
});

test('THE HOLE IN "settled before and after": a growing backlog flags nothing', () => {
  /**
   * The reported screen, exactly. Five nights closed and unsettled with
   * everything older settled and nothing newer settled at all — which is what
   * a fortnight of not settling looks like, and is the commonest backlog
   * there is.
   *
   * Under "the one before AND after are settled" not one of these five would
   * be flagged, because nothing after them is settled. The rule would be
   * silent on exactly the fortnight it was wanted for.
   */
  const settledOlder = shift('0829', { closed_at: daysAgo(6), locked_at: daysAgo(6) });
  const unsettled = [5, 4, 3, 2, 1].map((d, i) => shift(`u${i}`, { closed_at: daysAgo(d) }));
  const all = [settledOlder, ...unsettled];

  // The suggested rule, written out, finds nothing.
  const sandwiched = unsettled.filter((s) => {
    const before = all.filter((x) => (x.closed_at ?? '') < (s.closed_at ?? ''));
    const after = all.filter((x) => (x.closed_at ?? '') > (s.closed_at ?? ''));
    return before.some(isSettledShift) && after.some(isSettledShift);
  });
  assert.deepEqual(sandwiched, []);

  // The rule actually used finds all five, and calls four of them overdue.
  const rows = settlementBacklog(all, NOW);
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((r) => r.state),
    ['overdue', 'overdue', 'overdue', 'overdue', 'waiting'],
  );
});

test('the worst first, then the oldest, not simply by date', () => {
  /*
    A list ordered by date alone buries the one shift somebody jumped over
    behind a fortnight of ordinary backlog — and that is the row that most
    needs a person to look at it. So: skipped, then overdue, oldest first
    within each.

    The settled shift in the middle is what makes the older one "skipped" and
    leaves the newer one merely overdue. Anything closed before a settled
    shift was passed over; anything after it simply has not been reached.
  */
  const rows = settlementBacklog([
    shift('newer-unsettled', { closed_at: daysAgo(3) }),
    shift('older-passed-over', { closed_at: daysAgo(9) }),
    shift('sealed', { closed_at: daysAgo(6), locked_at: daysAgo(5) }),
  ], NOW);
  assert.deepEqual(rows.map((r) => [r.shift.$id, r.state]), [
    ['older-passed-over', 'skipped'],
    ['newer-unsettled', 'overdue'],
  ]);
});

test('everything closed before a settled shift counts as passed over', () => {
  /*
    Settling last night while nine days sit unsettled behind it is not "not
    reached yet" — the later one was reached. Calling all nine skipped is the
    honest reading and is what puts them at the top.
  */
  const rows = settlementBacklog([
    shift('a', { closed_at: daysAgo(9) }),
    shift('b', { closed_at: daysAgo(5) }),
    shift('sealed', { closed_at: daysAgo(2), locked_at: daysAgo(1) }),
  ], NOW);
  assert.deepEqual(rows.map((r) => [r.shift.$id, r.state]), [['a', 'skipped'], ['b', 'skipped']]);
});

test('a bar night is not skipped because somebody settled the kitchen after it', () => {
  /**
   * A bar and a kitchen are settled by different people on different days.
   * Reading across the sides would flag every unsettled bar shift the moment
   * anybody settled a kitchen one, which is a warning that means nothing.
   */
  const bar = shift('bar', { module: 'bar', closed_at: daysAgo(5) });
  const kitchenLater = shift('kit', { module: 'kitchen', closed_at: daysAgo(2), locked_at: daysAgo(1) });
  assert.equal(backlogState(bar, [bar, kitchenLater], NOW), 'overdue');

  const barLater = shift('bar2', { module: 'bar', closed_at: daysAgo(2), locked_at: daysAgo(1) });
  assert.equal(backlogState(bar, [bar, barLater], NOW), 'skipped');
});

test('a shift still trading is not outstanding, because there is nothing to settle', () => {
  const open = shift('now', { status: 'open', closed_at: undefined, opened_at: daysAgo(0) });
  assert.equal(isClosedShift(open), false);
  assert.equal(backlogState(open, [open], NOW), 'open');
  assert.deepEqual(settlementBacklog([open], NOW), []);
});

test('a reopened shift is closed again as far as settling is concerned', () => {
  // Reopening a night to change one figure does not make it a night still
  // being traded, and leaving it out would hide the one somebody was editing.
  const reopened = shift('r', { status: 'reopened', closed_at: daysAgo(4) });
  assert.equal(backlogState(reopened, [reopened], NOW), 'overdue');
});

test('the summary says how many, of which kind, and how long the worst has waited', () => {
  const rows = settlementBacklog([
    shift('skip', { closed_at: daysAgo(9) }),
    shift('sealed', { closed_at: daysAgo(6), locked_at: daysAgo(5) }),
    shift('late', { closed_at: daysAgo(3) }),
  ], NOW);
  const words = String(backlogSummary(rows));
  assert.match(words, /2 shifts are closed and not settled/);
  assert.match(words, /1 was passed over while later shifts were settled/);
  assert.match(words, /1 has been sitting closed too long/);
  assert.match(words, /oldest has been waiting 9 days/);
});

test('nothing outstanding says nothing at all', () => {
  // A banner that appears every day is one nobody reads on the day it matters.
  assert.equal(backlogSummary([]), null);
  assert.equal(backlogSummary(settlementBacklog([
    shift('a', { closed_at: daysAgo(4), locked_at: daysAgo(3) }),
  ], NOW)), null);
  // And a shift closed this morning is not worth a banner either.
  assert.equal(backlogSummary(settlementBacklog([
    shift('b', { closed_at: new Date(NOW - 3_600_000).toISOString() }),
  ], NOW)), null);
});

test('how long it has been, in the words somebody would use', () => {
  assert.equal(agedWords(9 * 86_400_000), '9 days');
  assert.equal(agedWords(86_400_000), '1 day');
  assert.equal(agedWords(5 * 3_600_000), '5 hours');
  assert.equal(agedWords(60_000), '1 hour');
});
