import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tabIsOpen, tabOwing, postProblem, tabSummaryWords,
  tabOrdersOnShift, releaseWords, closeCodeProblem, codeUsable, makeCloseCode,
  CLOSE_CODE_LENGTH, CLOSE_CODE_GOOD_FOR_MS,
} from '../tabs.ts';

const cash = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

const tab = (over: Record<string, unknown> = {}) => ({
  $id: 't1', name: 'Room 12', status: 'open', ...over,
}) as Parameters<typeof postProblem>[0] & { $id: string };

const order = (over: Record<string, unknown> = {}) => ({
  $id: 'o1', $createdAt: '2026-08-30T18:00:00.000Z', order_no: 'ORD0400',
  tab_id: 't1', total: 9000, status: 'SERVED', payment_status: 'unpaid',
  module: 'bar', shift_id: 's1', ...over,
}) as Parameters<typeof tabOwing>[0][number];

test('a tab owes the sum of what is on it', () => {
  assert.equal(tabOwing([order(), order({ $id: 'o2', total: 4500 })]), 13_500);
});

test('nothing sold is nothing owed', () => {
  /*
    A cancelled order is not a debt. Chasing a customer for a plate that was
    called off is how a tab stops being trusted.
  */
  assert.equal(tabOwing([order({ status: 'CANCELLED' }), order({ $id: 'x', status: 'REJECTED' })]), 0);
  assert.equal(tabOwing([order({ payment_status: 'refunded' })]), 0);
});

test('a part-paid order still owes the rest', () => {
  // The remainder must not vanish because something was recorded against it.
  assert.equal(tabOwing([order({ total: 9000 })], () => 4000), 5000);
  // And an over-payment does not turn into a credit on the next line.
  assert.equal(tabOwing([order({ total: 9000 })], () => 12_000), 0);
});

test('a limit that is only drawn is not a limit', () => {
  /**
   * Checked here rather than at the button, so the till, the kitchen and
   * anything later all refuse for the same reason in the same words.
   */
  const limited = tab({ limit_amount: 20_000 });
  assert.equal(postProblem(limited, 5000, 9000, cash), null);
  const problem = postProblem(limited, 15_000, 9000, cash);
  assert.match(String(problem), /limited to GH₵200\.00/);
  assert.match(String(problem), /already owes GH₵150\.00/);
  // And it says both ways out, because one of them is not the cashier's to do.
  assert.match(String(problem), /settling first, or an admin can raise/);
});

test('no limit means no limit', () => {
  // Most tabs have none, and inventing one would refuse ordinary trade.
  assert.equal(postProblem(tab(), 500_000, 9000, cash), null);
  assert.equal(postProblem(tab({ limit_amount: 0 }), 500_000, 9000, cash), null);
});

test('a settled tab takes nothing more, and says who can help', () => {
  const problem = postProblem(tab({ status: 'settled' }), 0, 9000, cash);
  assert.match(String(problem), /settled and closed/);
  assert.match(String(problem), /admin/);
  assert.equal(tabIsOpen(tab({ status: 'settled' })), false);
});

test('no tab chosen is asked for, not blamed', () => {
  assert.match(String(postProblem(null, 0, 9000, cash)), /Choose which tab/);
});

test('a tab reads without being opened', () => {
  const words = tabSummaryWords(tab({ limit_amount: 20_000 }), 15_000, 3, cash);
  assert.match(words, /3 orders/);
  assert.match(words, /GH₵150\.00 owing/);
  // What is LEFT, which is the number somebody about to add to it wants.
  assert.match(words, /GH₵50\.00 left of GH₵200\.00/);
  assert.match(tabSummaryWords(tab(), 0, 0, cash), /Nothing on it yet/);
});

/* ------------------------------------------------- the closing gate */

test('only this shift, this side, and only what is still owed', () => {
  /**
   * By the shift because the question is what THIS person is handing over. A
   * tab order from last week is somebody else's conversation, and holding the
   * close over it would teach staff that the gate is noise.
   */
  const rows = [
    order({ $id: 'mine' }),
    order({ $id: 'other-shift', shift_id: 's2' }),
    order({ $id: 'other-side', module: 'craft' }),
    order({ $id: 'not-a-tab', tab_id: undefined }),
    order({ $id: 'cancelled', status: 'CANCELLED' }),
    // Settled during the shift, so nothing is going home unpaid on it.
    order({ $id: 'already-paid', payment_status: 'paid' }),
  ];
  assert.deepEqual(tabOrdersOnShift(rows, 's1', 'bar').map((o) => o.$id), ['mine']);
});

test('an order with no module counts as the kitchen, as it always has', () => {
  assert.equal(tabOrdersOnShift([order({ module: undefined })], 's1', 'kitchen').length, 1);
});

test('the gate says the figure out loud', () => {
  /*
    The whole point of the code. Somebody who can see the business is looking
    at "GH₵450 is going home unpaid tonight" while the person who let it happen
    is still standing there.
  */
  const words = releaseWords([order({ total: 30_000 }), order({ $id: 'b', total: 15_000 })], cash);
  assert.match(words, /2 orders/);
  assert.match(words, /GH₵450\.00 is going home unpaid/);
  assert.match(words, /ask them for the code/);
});

test('a code of the wrong shape is named as such', () => {
  /**
   * Checked before it is compared. A cashier who typed five digits told "that
   * code is wrong" goes back to the admin for a code that was correct all
   * along.
   */
  assert.equal(closeCodeProblem('123456'), null);
  assert.match(String(closeCodeProblem('')), /Enter the code/);
  assert.match(String(closeCodeProblem('12345')), /6 digits/);
  assert.match(String(closeCodeProblem('12a456')), /digits only/);
  // Spaces from a phone call read out loud are not the cashier's mistake.
  assert.equal(closeCodeProblem('  123456  '), null);
});

const issued = (over: Record<string, unknown> = {}) => ({
  shift_id: 's1', module: 'bar', issued_at: '2026-08-30T18:00:00.000Z', ...over,
}) as Parameters<typeof codeUsable>[0];

const NOW = Date.parse('2026-08-30T18:05:00.000Z');

test('a fresh code for this shift works', () => {
  assert.equal(codeUsable(issued(), 's1', 'bar', NOW), null);
});

test('a code is for one shift and one use', () => {
  /*
    Both matter. One that works twice is a code somebody keeps for next time,
    and one that works on any shift stops meaning "an admin looked at THIS".
  */
  assert.match(String(codeUsable(issued(), 's2', 'bar', NOW)), /different shift/);
  assert.match(String(codeUsable(issued(), 's1', 'craft', NOW)), /different side/);
  assert.match(
    String(codeUsable(issued({ used_at: '2026-08-30T18:01:00.000Z' }), 's1', 'bar', NOW)),
    /already been used/,
  );
});

test('a code expires, because one that never does gets kept', () => {
  const old = NOW + CLOSE_CODE_GOOD_FOR_MS + 1;
  assert.match(String(codeUsable(issued(), 's1', 'bar', old)), /expired/);
  // And is good right up to the edge.
  assert.equal(
    codeUsable(issued(), 's1', 'bar', Date.parse('2026-08-30T18:00:00.000Z') + CLOSE_CODE_GOOD_FOR_MS),
    null,
  );
});

test('no code at all points at the person who can give one', () => {
  assert.match(String(codeUsable(null, 's1', 'bar', NOW)), /Ask an admin/);
});

test('an unreadable or future stamp is refused rather than trusted', () => {
  // A tablet whose clock was wrong and then corrected. The cautious reading is
  // the only safe one for the thing guarding money going out unpaid.
  assert.match(String(codeUsable(issued({ issued_at: 'nonsense' }), 's1', 'bar', NOW)), /cannot be read/);
  assert.match(
    String(codeUsable(issued({ issued_at: '2026-08-30T19:00:00.000Z' }), 's1', 'bar', NOW)),
    /cannot be read/,
  );
});

test('the code is six digits and comes from real randomness', () => {
  /**
   * Not Math.random. This is the one thing standing between a cashier and
   * closing a shift over money going home unpaid, and a predictable six digits
   * is not standing anywhere.
   */
  const code = makeCloseCode((n) => Uint8Array.from({ length: n }, (_, i) => 10 + i));
  assert.equal(code.length, CLOSE_CODE_LENGTH);
  assert.match(code, /^\d{6}$/);
  // Every byte contributes; a run of identical bytes must not collapse.
  assert.equal(code, '012345');
});
