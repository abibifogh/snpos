import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROUTINES, deepToday, listFor, byArea, cleanProgress, needsReview, reviewWords, readItems,
  routineFrom, routineRow, readTemp, tempOut, rangeWords, isoDay, cleanDay,
} from '../cleaning.ts';

const monday = new Date(2026, 10, 2, 8, 30); // Mon 2 Nov 2026
const sunday = new Date(2026, 10, 1, 22, 0); // Sun 1 Nov 2026
const tuesday = new Date(2026, 10, 3, 8, 30);

test('every routine starts switched off, for the kitchen and the bar', () => {
  for (const side of ['kitchen', 'bar'] as const) {
    const r = DEFAULT_ROUTINES[side];
    assert.equal(r.active, false);
    assert.equal(r.hold, 'hold');
    assert.ok(r.open.length > 5 && r.close.length > 5 && r.deep.length > 3);
    // Ids are unique across the three lists, so history follows a check.
    const ids = [...r.open, ...r.close, ...r.deep].map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
  }
  // Nothing saved yet: the defaults, still off.
  assert.equal(routineFrom('bar', null).active, false);
});

test('the deep clean joins the opening list on its day, or the closing list the night before', () => {
  const r = { ...DEFAULT_ROUTINES.kitchen, deepDay: 1, deepWhen: 'before' as const };
  assert.equal(isoDay(monday), 1);
  assert.equal(deepToday(r, 'open', monday), true);
  assert.equal(deepToday(r, 'open', tuesday), false);
  assert.equal(deepToday(r, 'close', sunday), false);
  assert.equal(listFor(r, 'open', monday).length, r.open.length + r.deep.length);
  assert.ok(listFor(r, 'open', monday).slice(-1)[0].deep);

  const after = { ...r, deepWhen: 'after' as const };
  assert.equal(deepToday(after, 'close', sunday), true, 'Sunday night, for a Monday deep clean');
  assert.equal(deepToday(after, 'open', monday), false);
  assert.equal(listFor(after, 'close', sunday).length, r.close.length + r.deep.length);
  // A Sunday deep clean after closing is done on Saturday night.
  assert.equal(deepToday({ ...after, deepDay: 7 }, 'close', new Date(2026, 9, 31)), true);
  // No deep-clean day at all.
  assert.equal(deepToday({ ...r, deepDay: 0 }, 'open', monday), false);
});

test('temperatures: typed loosely, judged against the safe range', () => {
  assert.equal(readTemp('4,5'), 4.5);
  assert.equal(readTemp('−18'), -18);
  assert.equal(readTemp(''), null);
  assert.equal(readTemp('cold'), null);
  const fridge = { min: 0, max: 5 };
  const freezer = { min: -40, max: -18 };
  assert.equal(tempOut(fridge, 5), false);
  assert.equal(tempOut(fridge, 6), true);
  assert.equal(tempOut(freezer, -12), true);
  assert.equal(tempOut(freezer, -20), false);
  assert.equal(rangeWords(0, 5), 'Safe at 0 to 5 °C');
  assert.equal(rangeWords(-40, -18), 'Safe at −18 °C or colder');
});

test('a list goes to Approvals only when something was missed, skipped or out of range', () => {
  const a = (done: boolean, required = true, out = false) => ({ done, required, out });
  assert.equal(needsReview([a(true), a(false, false)], false), false, 'an optional check left is fine');
  assert.equal(needsReview([a(true), a(false)], false), true);
  assert.equal(needsReview([a(true), a(true, true, true)], false), true);
  assert.equal(needsReview([a(true)], true), true, 'skipped with a reason');
  assert.deepEqual(cleanProgress([a(true), a(false), a(false, false), a(true, true, true)]), {
    done: 2, of: 4, requiredLeft: 1, outOfRange: 1,
  });
  const words = reviewWords({
    side: 'kitchen', kind: 'open', skipReason: 'Delivery came early',
    answers: [
      { id: '1', text: 'Floor', area: 'Floor', required: true, kind: 'tick', done: false },
      { id: '2', text: 'Walk-in fridge', area: 'Fridges', required: true, kind: 'temp', done: true, value: 7, out: true },
    ],
  });
  assert.equal(words.title, 'Kitchen opening clean: 1 of 2 done');
  assert.match(words.detail, /^1 required check not done; outside the safe range: Walk-in fridge at 7 °C; reason given/);
});

test('a routine survives being saved and read back, and junk in a stored list is dropped', () => {
  const r = { ...DEFAULT_ROUTINES.bar, active: true, hold: 'show' as const, deepDay: 5, deepWhen: 'after' as const };
  const back = routineFrom('bar', routineRow(r));
  assert.deepEqual(back, r);
  assert.deepEqual(readItems('[{"text":"  Wipe the till  "},{"nope":1},{"text":""}]'), [
    { id: 'i0', area: 'Other', text: 'Wipe the till', required: true, kind: 'tick' },
  ]);
  assert.equal(readItems('not json'), null);
  // A list that cannot be read keeps the defaults rather than emptying the routine.
  assert.equal(routineFrom('kitchen', { open_items: 'oops' }).open.length, DEFAULT_ROUTINES.kitchen.open.length);
  assert.deepEqual(byArea([{ area: 'A', n: 1 }, { area: 'B', n: 2 }, { area: 'A', n: 3 }]).map(([a, l]) => [a, l.length]), [['A', 2], ['B', 1]]);
  assert.equal(cleanDay(monday), '2026-11-02');
});
