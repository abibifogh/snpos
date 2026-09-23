import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSealed, sealProblem, sealBlock, lockedProblem, orderIsSettled, lockWords, describeSeal,
  sealOrder, bulkSealPlan, bulkSealProblem, bulkSealWords, bulkSealOutcome,
  type LockableShift, type SealCandidate,
} from '../shift-lock.ts';

const shift = (over: Partial<LockableShift> = {}): LockableShift =>
  ({ code: 'BIST-07', status: 'closed', ...over });

let n = 0;
const pick = (over: Partial<SealCandidate> = {}): SealCandidate => {
  n += 1;
  return { $id: `s${n}`, code: `BAR-${n}`, status: 'closed', closed_at: '2026-09-18T22:00:00.000Z', ...over };
};

test('closed is not settled, and that difference is the whole point', () => {
  /**
   * Closing a shift ends it. It does not finish it: the close time can still
   * be corrected, an order moved onto or off it, a payment voided. All of
   * those are deliberate and needed. Settling is the separate statement that
   * this night has been reported on.
   */
  assert.equal(isSealed(shift()), false);
  assert.equal(isSealed(shift({ locked_at: '2026-08-20T09:00:00.000Z' })), true);
  assert.equal(isSealed(null), false);
  assert.equal(isSealed(undefined), false);
});

test('a shift still trading cannot be settled', () => {
  // Not a house rule: sealing an open shift would stop the till taking money
  // against a night that has not stopped happening, and the first person to
  // find out would be a cashier at eleven with a customer waiting.
  assert.match(sealProblem(shift({ status: 'open' })) ?? '', /still open/);
  assert.match(sealProblem(shift({ status: 'open' })) ?? '', /Close it from the till first/);
  assert.equal(sealProblem(shift()), null);
});

test('settling twice is refused rather than silently repeated', () => {
  const sealed = shift({ locked_at: '2026-08-20T09:00:00.000Z' });
  assert.match(sealProblem(sealed) ?? '', /already settled/);
});

test('the refusal names the shift and offers the way out', () => {
  /**
   * One sentence, written once, so every screen refuses in the same words.
   * Six screens each phrasing it themselves is six chances to imply the
   * change went through when it did not.
   */
  const msg = lockedProblem(shift({ locked_at: '2026-08-20T09:00:00.000Z' }), 'the close time');
  assert.match(msg ?? '', /BIST-07 was settled/);
  assert.match(msg ?? '', /the close time cannot be changed/);
  assert.match(msg ?? '', /An admin can reopen it/);
});

test('an unsettled shift refuses nothing', () => {
  assert.equal(lockedProblem(shift(), 'the close time'), null);
  assert.equal(lockedProblem(null), null);
  assert.equal(orderIsSettled(shift()), false);
  assert.equal(orderIsSettled(shift({ locked_at: '2026-08-20T09:00:00.000Z' })), true);
});

test('the badge says settled, and carries the reason where there is one', () => {
  assert.equal(lockWords(shift()).label, 'Open to corrections');
  const words = lockWords(shift({ locked_at: '2026-08-20T09:00:00.000Z', lock_reason: 'Given to the accountant' }));
  assert.equal(words.label, 'Settled');
  assert.equal(words.detail, 'Given to the accountant');
  // No reason is not an empty reason: an empty string on screen reads as a
  // missing value rather than as nothing to say.
  assert.equal(lockWords(shift({ locked_at: 'x', lock_reason: '' })).detail, undefined);
});

test('both directions read the same way in the log a year later', () => {
  assert.match(describeSeal(shift(), true), /BIST-07 is settled/);
  assert.match(describeSeal(shift(), true), /Nothing in it can be changed until it is reopened/);
  assert.match(describeSeal(shift(), false), /open to corrections again/);
});

/* --------------------------------------------------------- several at once */

test('a refusal is a fact before it is a sentence', () => {
  /*
    So that several refusals can be summarised without grouping them by their
    wording — which breaks the first time somebody improves a word.
  */
  assert.equal(sealBlock(shift()), null);
  assert.equal(sealBlock(shift({ status: 'open' })), 'still-open');
  assert.equal(sealBlock(shift({ locked_at: 'x' })), 'already-settled');
});

test('ticking several settles the ones that can be and names the ones that cannot', () => {
  const ok = pick();
  const trading = pick({ status: 'open' });
  const done = pick({ locked_at: '2026-09-01T00:00:00.000Z' });

  const plan = bulkSealPlan([ok, trading, done]);
  assert.deepEqual(plan.ready.map((s) => s.$id), [ok.$id]);
  assert.deepEqual(plan.refused.map((r) => r.block), ['still-open', 'already-settled']);
  // The same words the single settle uses, from the same place.
  assert.equal(plan.refused[0]?.why, sealProblem(trading));
});

test('one shift that cannot be settled does not refuse the other seven', () => {
  /*
    Refusing the whole run because one of them is still trading sends somebody
    back to tick seven boxes again, and the likeliest response to that is to
    stop settling anything.
  */
  const plan = bulkSealPlan([pick(), pick(), pick({ status: 'open' })]);
  assert.equal(bulkSealProblem(plan), null);
  assert.equal(plan.ready.length, 2);
});

test('oldest first, so a run that stops half way leaves no hole', () => {
  /*
    Newest first would settle the later nights and leave the earlier ones
    unsettled underneath them — which is exactly the "skipped" state the
    backlog screen shouts about. Oldest first means an interrupted run leaves
    an ordinary shrinking backlog.
  */
  const older = pick({ closed_at: '2026-09-18T22:00:00.000Z' });
  const newer = pick({ closed_at: '2026-09-21T22:00:00.000Z' });
  const middle = pick({ closed_at: '2026-09-20T22:00:00.000Z' });
  assert.deepEqual(
    bulkSealPlan([newer, older, middle]).ready.map((s) => s.$id),
    [older.$id, middle.$id, newer.$id],
  );
});

test('a shift that never recorded a close time still takes its turn', () => {
  // Sorted to the front rather than dropped. A row left out of a bulk action
  // silently is a row nobody notices was left out.
  const blank = pick({ closed_at: undefined, opened_at: undefined });
  const dated = pick();
  assert.equal(sealOrder([dated, blank]).length, 2);
});

test('nothing ticked says so rather than opening an empty confirmation', () => {
  assert.match(String(bulkSealProblem(bulkSealPlan([]))), /Tick the shifts/);
});

test('when none of them can be settled the reasons are counted by kind', () => {
  const plan = bulkSealPlan([
    pick({ status: 'open' }),
    pick({ status: 'open' }),
    pick({ locked_at: 'x' }),
  ]);
  const why = String(bulkSealProblem(plan));
  assert.match(why, /1 is settled already/);
  assert.match(why, /2 are still trading/);
});

test('one refusal is said in its own words, not summarised', () => {
  // "1 is still trading" is worse than the sentence that names the shift and
  // says where to go and close it.
  const plan = bulkSealPlan([pick({ status: 'open', code: 'BAR20260921' })]);
  assert.match(String(bulkSealProblem(plan)), /BAR20260921 is still open/);
});

test('the confirmation says how many, and that the rest are left alone', () => {
  const plan = bulkSealPlan([pick(), pick(), pick({ status: 'open' })]);
  assert.match(bulkSealWords(plan), /^2 shifts will be settled/);
  assert.match(bulkSealWords(plan), /The other 1 is left alone/);
  assert.match(bulkSealWords(bulkSealPlan([pick()])), /^1 shift will be settled/);
  assert.equal(/left alone/.test(bulkSealWords(bulkSealPlan([pick()]))), false);
});

test('six of eight is not "settled"', () => {
  /*
    The whole point. Reporting a bulk action as done when part of it failed is
    how somebody closes this screen believing a month is finished and finds
    out in November.
  */
  const out = bulkSealOutcome([
    { code: 'BAR-1', ok: true },
    { code: 'BAR-2', ok: false, why: 'The connection dropped.' },
    { code: 'BAR-3', ok: true },
  ]);
  assert.equal(out.tone, 'err');
  assert.match(out.message, /2 of 3 settled/);
  assert.match(out.message, /BAR-2 was not/);
  assert.match(out.message, /still open to corrections/);
});

test('the ones that failed are named, never counted', () => {
  // A count sends somebody hunting through a list; the code is the thing they
  // need in order to go and look.
  const out = bulkSealOutcome([
    { code: 'BAR-1', ok: false, why: 'The connection dropped.' },
    { code: 'BAR-2', ok: false, why: 'The connection dropped.' },
  ]);
  assert.match(out.message, /BAR-1, BAR-2/);
  assert.match(out.message, /Nothing was settled/);
  // One shared reason is said once rather than repeated per shift.
  assert.equal(out.message.match(/connection dropped/g)?.length, 1);
});

test('all of them through is the plain sentence', () => {
  const out = bulkSealOutcome([{ code: 'BAR-1', ok: true }, { code: 'BAR-2', ok: true }]);
  assert.deepEqual(out, { message: '2 shifts are settled.', tone: 'ok' });
  assert.match(bulkSealOutcome([{ code: 'BAR-1', ok: true }]).message, /^1 shift is settled/);
});

test('failures for different reasons drop the shared clause rather than pick one', () => {
  // Attaching one shift's reason to a list of shifts that failed differently
  // would be a confident sentence that is wrong about most of them.
  const out = bulkSealOutcome([
    { code: 'BAR-1', ok: false, why: 'The connection dropped.' },
    { code: 'BAR-2', ok: false, why: 'It was settled a moment ago by somebody else.' },
  ]);
  assert.equal(/connection dropped/.test(out.message), false);
});
