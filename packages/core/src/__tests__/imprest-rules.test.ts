import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boxBalance, spentSince, topUpNeeded, overBy, healthOf, countBox, countProblem,
  needsExplaining, spendProblem, withoutReceipt, IMPREST_LOW_BP, IMPREST_TOLERANCE,
  holdsBox, canFundBoxes, canUseBox, boxesFor,
  type ImprestMovement,
} from '../imprest-rules.ts';

const m = (amount: number, over: Partial<ImprestMovement> = {}): ImprestMovement => ({
  amount, kind: amount > 0 ? 'top_up' : 'spend', ...over,
});

test('the balance is the sum of what went in and out, never a stored figure', () => {
  /**
   * A running total kept as a field drifts the first time a write half fails,
   * and once it has drifted nothing in the system can say so. Summed from the
   * movements it cannot be wrong — only incomplete, and incomplete is visible.
   */
  assert.equal(boxBalance([m(50_000), m(-1_200), m(-3_400), m(20_000)]), 65_400);
  assert.equal(boxBalance([]), 0);
});

test('expected cash is not assumed to be the fixed amount', () => {
  /**
   * The textbook says a box is always restored to its level, so expected cash
   * is "fixed minus receipts". In a real kitchen somebody tops up half of it
   * on a Friday because that is what was in the safe. Deriving expected from
   * what actually moved describes both; assuming the textbook reports a
   * shortage every day until the other half turns up.
   */
  const half = [m(25_000), m(-4_000)];
  assert.equal(boxBalance(half), 21_000);
  const count = countBox({ fixedAmount: 50_000, balance: boxBalance(half), counted: 21_000 });
  assert.equal(count.variance, 0, 'a half-funded box that adds up is not short');
  assert.equal(count.toRestore, 29_000, 'but it is still 29,000 below its level');
});

test('a top-up figure is never negative, because that is a different act', () => {
  // A box holding more than its level does not need topping up by a negative
  // number. It needs money taking out of it, which has its own name.
  assert.equal(topUpNeeded(50_000, 70_000), 0);
  assert.equal(overBy(50_000, 70_000), 20_000);
  assert.equal(overBy(50_000, 10_000), 0);
});

test('a box says when it is running low, before somebody is sent to the market', () => {
  assert.equal(healthOf(50_000, 50_000), 'ok');
  assert.equal(healthOf(50_000, 30_000), 'ok');
  // A quarter left is the line. Low enough not to nag at a box simply being
  // used, high enough to hear about it before there is nothing to spend.
  assert.equal(IMPREST_LOW_BP, 2_500);
  assert.equal(healthOf(50_000, 12_500), 'low');
  assert.equal(healthOf(50_000, 0), 'empty');
  assert.equal(healthOf(50_000, -500), 'empty', 'overdrawn is not "low", it is empty');
  assert.equal(healthOf(50_000, 60_000), 'over');
});

test('the count answers two different questions with two different numbers', () => {
  /**
   * "Is any money missing" is measured against the movements. "How much do I
   * put back" is measured against the fixed amount. Answering both with one
   * figure is what makes petty cash arguments unresolvable.
   */
  const r = countBox({ fixedAmount: 50_000, balance: 21_000, counted: 19_500 });
  assert.equal(r.expected, 21_000);
  assert.equal(r.variance, -1_500, 'short by what is not there');
  assert.equal(r.toRestore, 30_500, 'and restored from what IS there, not from the book');
});

test('a box counted over is over, not quietly ignored', () => {
  const r = countBox({ fixedAmount: 50_000, balance: 21_000, counted: 23_000 });
  assert.equal(r.variance, 2_000);
  assert.equal(r.toRestore, 27_000);
});

test('a blank count is refused; a counted nought is an answer', () => {
  // Saving a blank would write the box down to empty and post the whole float
  // to cash short, which is a serious accusation to make out of an unanswered
  // box.
  assert.match(countProblem('') ?? '', /blank is not the same as nothing/);
  assert.match(countProblem('   ') ?? '', /blank is not the same as nothing/);
  assert.equal(countProblem('0'), null);
  assert.match(countProblem('-5') ?? '', /less than nothing/);
});

test('small change is not worth stopping anybody over', () => {
  // Petty cash is petty. A threshold that fires on any difference fires every
  // week, and teaches people to type whatever balances.
  assert.equal(needsExplaining(500), false);
  assert.equal(needsExplaining(-IMPREST_TOLERANCE), false, 'the line itself is inside it');
  assert.equal(needsExplaining(-1_001), true);
});

test('a box cannot pay out what it does not hold, unless somebody insists', () => {
  const over = { amount: 30_000, balance: 21_000, categoryKey: 'transport' };
  assert.match(spendProblem(over) ?? '', /more than the box holds/);
  /*
    Allowed on purpose when it is asked for. Somebody may genuinely have made
    up the difference out of their own pocket and be owed it back, and a system
    that cannot record what really happened gets worked around rather than
    corrected.
  */
  assert.equal(spendProblem({ ...over, allowOverdraw: true }), null);
});

test('a spend with no category is refused, because it would land nowhere', () => {
  assert.match(spendProblem({ amount: 500, balance: 9_000 }) ?? '', /right account/);
  assert.match(spendProblem({ amount: 0, balance: 9_000, categoryKey: 'x' }) ?? '', /what was spent/);
});

test('spending since a moment counts only spending', () => {
  // Top-ups and count corrections are not receipts. Folding them in would make
  // the reimbursement figure the wrong amount in both directions at once.
  const rows = [
    m(-1_000, { kind: 'spend', occurred_at: '2026-08-01T10:00:00Z' }),
    m(-2_000, { kind: 'spend', occurred_at: '2026-08-20T10:00:00Z' }),
    m(50_000, { kind: 'top_up', occurred_at: '2026-08-21T10:00:00Z' }),
    m(-300, { kind: 'adjust', occurred_at: '2026-08-22T10:00:00Z' }),
  ];
  assert.equal(spentSince(rows), 3_000);
  assert.equal(spentSince(rows, '2026-08-15T00:00:00Z'), 2_000);
});

test('a top-up is not a spend missing its receipt', () => {
  /**
   * Only a spend has a third party who could have issued one. A top-up is a
   * transfer between two places the business already owns, and counting those
   * as undocumented would report every funded box as half missing — a warning
   * that is always on is one nobody reads.
   */
  const rows = [
    { kind: 'top_up' as const, ref_type: 'top_up', ref_id: '' },
    { kind: 'adjust' as const, ref_type: 'count', ref_id: '' },
    { kind: 'spend' as const, ref_type: 'expense', ref_id: 'e1' },
    { kind: 'spend' as const, ref_type: 'expense', ref_id: 'e2' },
  ];
  const missing = withoutReceipt(rows, { e1: 'file-1' });
  assert.deepEqual(missing.map((m) => m.ref_id), ['e2']);
});

test('a spend pointing at nothing counts as missing, not as filed', () => {
  // A movement with no expense behind it cannot have a receipt, and reading
  // that as "documented" is how a gap becomes invisible.
  const rows = [{ kind: 'spend' as const, ref_type: 'expense', ref_id: '' }];
  assert.equal(withoutReceipt(rows, {}).length, 1);
});

/* ------------------------------------------------- who may do what with a box */

const holder = (over: Record<string, unknown> = {}) => ({ $id: 'p1', role: 'cashier', ...over });
const box = (over: Record<string, unknown> = {}) => ({ custodian_id: 'p1', ...over });

test('holding a box and funding it are separate jobs', () => {
  /**
   * The only real control the whole feature has. Recording a top-up credits
   * the till's cash and debits the box, so a custodian who could invent one
   * could top their own box back up on paper and no count would ever find the
   * shortage.
   */
  const custodian = holder();
  assert.equal(holdsBox(custodian, box()), true);
  assert.equal(canUseBox(custodian, box()), true, 'they may spend from it and count it');
  assert.equal(canFundBoxes(custodian), false, 'and may not decide how much is in it');
});

test('an admin may do both, and so may anybody handed it by name', () => {
  assert.equal(canFundBoxes(holder({ role: 'admin' })), true);
  assert.equal(canFundBoxes(holder({ can_fund_petty_cash: true })), true);
  // Not by job title. A manager is trusted with a great deal and still has to
  // be given this one deliberately.
  assert.equal(canFundBoxes(holder({ role: 'manager' })), false);
  assert.equal(canFundBoxes(null), false);
});

test('a custodian sees the box they hold and no others', () => {
  const boxes = [
    { $id: 'a', custodian_id: 'p1' },
    { $id: 'b', custodian_id: 'p2' },
    { $id: 'c' },
  ];
  assert.deepEqual(boxesFor(holder(), boxes).map((b) => b.$id), ['a']);
  // Anybody who may fund boxes sees all of them: setting one up and moving
  // money between them cannot be done from a list that hides most of them.
  assert.deepEqual(boxesFor(holder({ role: 'admin' }), boxes).map((b) => b.$id), ['a', 'b', 'c']);
});

test('a box belongs to nobody until somebody is named on it', () => {
  // A blank custodian must never match a blank profile id, or every box with
  // no holder would belong to everybody who has no profile.
  assert.equal(holdsBox(holder({ $id: '' }), { custodian_id: '' }), false);
  assert.equal(holdsBox(holder(), { custodian_id: '' }), false);
  assert.equal(holdsBox(null, box()), false);
  assert.equal(canUseBox(holder({ $id: 'someone-else' }), box()), false);
});
