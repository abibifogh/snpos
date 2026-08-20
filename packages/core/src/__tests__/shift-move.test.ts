import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftChoices, moveProblem, moveEffects, describeMove, isSettled,
  type MovableShift, type MovableOrder,
} from '../shift-move.ts';

const shift = (over: Partial<MovableShift> = {}): MovableShift => ({
  $id: 's1', code: 'BIST-01', status: 'closed', venue_id: 'main', module: 'kitchen',
  opened_at: '2026-08-18T17:00:00.000Z', ...over,
});

const order = (over: Partial<MovableOrder> = {}): MovableOrder => ({
  $id: 'o1', order_no: 'A-0042', venue_id: 'main', shift_id: 's1', module: 'kitchen', status: 'CLOSED', ...over,
});

test('the shift it is already on is not offered', () => {
  const choices = shiftChoices(order(), [shift(), shift({ $id: 's2', code: 'BIST-02' })]);
  assert.deepEqual(choices.map((s) => s.$id), ['s2']);
});

test('only shifts on the same side of the business', () => {
  /**
   * A bar sale filed under a kitchen shift would put drink takings into the
   * bistro's drawer figures and its books. The two sides keep separate shifts
   * precisely so the money never mixes, and a dropdown offering the other
   * side's would undo that with one tap.
   */
  const barSale = order({ $id: 'o2', shift_id: '', module: 'bar' });
  const choices = shiftChoices(barSale, [
    shift({ $id: 'k', module: 'kitchen', code: 'BIST-09' }),
    shift({ $id: 'b', module: 'bar', code: 'BAR-03' }),
    shift({ $id: 'c', module: 'craft', code: 'CRAF-02' }),
  ]);
  assert.deepEqual(choices.map((s) => s.$id), ['b']);
});

test('a shift with no side on it is the kitchen, like everywhere else', () => {
  // Shifts opened before the split carry no module. Reading them as anything
  // but the kitchen would hide every one of them from the kitchen's own list.
  const choices = shiftChoices(order({ shift_id: '' }), [shift({ $id: 'old', module: undefined })]);
  assert.deepEqual(choices.map((s) => s.$id), ['old']);
});

test('another venue is never a candidate', () => {
  assert.deepEqual(shiftChoices(order({ shift_id: '' }), [shift({ $id: 'x', venue_id: 'branch' })]), []);
});

test('the newest shift comes first, because it is nearly always the one meant', () => {
  const choices = shiftChoices(order({ shift_id: '' }), [
    shift({ $id: 'a', opened_at: '2026-08-16T17:00:00.000Z' }),
    shift({ $id: 'c', opened_at: '2026-08-19T17:00:00.000Z' }),
    shift({ $id: 'b', opened_at: '2026-08-17T17:00:00.000Z' }),
  ]);
  assert.deepEqual(choices.map((s) => s.$id), ['c', 'b', 'a']);
});

test('a closed shift is a perfectly good destination', () => {
  /**
   * Almost every wrong filing is noticed after the fact — that is what makes
   * it noticeable. Offering only open shifts would answer a question nobody
   * has.
   */
  assert.equal(moveProblem(order(), shift({ $id: 's2', status: 'closed' })), null);
  assert.equal(isSettled(shift({ status: 'closed' })), true);
  assert.equal(isSettled(shift({ status: 'open' })), false);
});

test('moving a sale to the shift it is already on is refused, by name', () => {
  const problem = moveProblem(order(), shift({ $id: 's1', code: 'BIST-01' }));
  assert.match(problem ?? '', /A-0042 is already counted under BIST-01/);
});

test('crossing sides is refused in words that say why', () => {
  const problem = moveProblem(order({ module: 'bar' }), shift({ $id: 's9', module: 'kitchen', code: 'BIST-04' }));
  assert.match(problem ?? '', /bar sale/);
  assert.match(problem ?? '', /BIST-04 is a kitchen shift/);
  assert.match(problem ?? '', /own takings/);
});

test('nothing picked is a prompt, not an error about the order', () => {
  assert.match(moveProblem(order(), null) ?? '', /Pick the shift/);
});

test('the money that moves is the money actually taken, tips included', () => {
  const effects = moveEffects({
    from: shift({ status: 'open' }),
    to: shift({ $id: 's2', status: 'open' }),
    payments: [{ amount: 4_000, tip: 500 }, { amount: 1_000 }],
  });
  assert.equal(effects.amount, 5_500);
  assert.equal(effects.payments, 2);
  // Both shifts still open, so there is nothing that will not follow.
  assert.deepEqual(effects.warnings, []);
});

test('a closed shift at either end is warned about, and named', () => {
  /**
   * The honest half of this feature. A closed shift is not a live figure; it
   * is a night a person counted and signed off, and no amount of correcting
   * rows afterwards puts the cash back into the right drawer.
   */
  const effects = moveEffects({
    from: shift({ code: 'BIST-07', status: 'closed' }),
    to: shift({ $id: 's2', code: 'BIST-08', status: 'closed' }),
    payments: [{ amount: 9_000 }],
  });
  assert.equal(effects.warnings.length, 2);
  assert.match(effects.warnings[0], /BIST-07 and BIST-08/);
  assert.match(effects.warnings[0], /physically in the drawer that night does not change/);
  // The books follow the sale now, so this says what WILL happen rather than
  // warning about what will not. See repostShiftAccounts.
  assert.match(effects.warnings[1], /posted again from the corrected figures/);
  assert.match(effects.warnings[1], /old ones reversed/);
  assert.match(effects.warnings[1], /closed off/);
});

test('an order that was on no shift is told what its money is about to do', () => {
  const effects = moveEffects({
    from: null,
    to: shift({ $id: 's2', code: 'BIST-08', status: 'open' }),
    payments: [{ amount: 9_000 }],
  });
  assert.equal(effects.warnings.length, 1);
  assert.match(effects.warnings[0], /has not been part of anybody's takings/);
  assert.match(effects.warnings[0], /BIST-08/);
});

test('an unpaid order moving onto a shift raises nothing about money', () => {
  // There is none to talk about, and a warning that does not apply is one
  // people learn to click past.
  const effects = moveEffects({ from: null, to: shift({ status: 'open' }), payments: [] });
  assert.deepEqual(effects.warnings, []);
  assert.equal(effects.amount, 0);
});

test('the move reads the same on the button as in the log a year later', () => {
  assert.equal(
    describeMove(order(), shift({ code: 'BIST-01' }), shift({ $id: 's2', code: 'BIST-02' })),
    'A-0042 moves from BIST-01 to BIST-02.',
  );
  assert.equal(
    describeMove(order({ shift_id: '' }), null, shift({ $id: 's2', code: 'BIST-02' })),
    'A-0042 is filed under BIST-02.',
  );
});
