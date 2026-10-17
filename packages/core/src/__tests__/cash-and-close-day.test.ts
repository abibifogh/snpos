import test from 'node:test';
import assert from 'node:assert/strict';
import { cashCounted, keptFrom, cashPlanProblem, keptByMethod, safeBalance, awaitingBank, bankingProblem } from '../cash-away.ts';
import { closeDayChecklist, closeDayProgress, type CloseDayFacts } from '../close-day.ts';

const methods = [{ $id: 'cash', kind: 'cash' }, { $id: 'momo', kind: 'mobile_money' }];
const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

test('only cash is split; what is not sent to the safe or bank stays as the float', () => {
  const counted = { cash: 234_000, momo: 118_000 };
  assert.equal(cashCounted(counted, methods), 234_000);
  assert.equal(keptFrom(234_000, { toSafe: 204_000, toBank: 0 }), 30_000);
  assert.deepEqual(keptByMethod(counted, methods, 30_000), { cash: 30_000, momo: 0 });
  // A shift closed before the question existed leaves everything it counted.
  assert.deepEqual(keptByMethod(counted, methods, undefined), { cash: 234_000, momo: 0 });
});

test('a split must add up, and somebody must be named when cash leaves', () => {
  assert.equal(cashPlanProblem(234_000, { toSafe: 0, toBank: 0 }), null, 'all kept needs no name');
  assert.match(cashPlanProblem(234_000, { toSafe: 300_000, toBank: 0, takenBy: 'Kofi' }) ?? '', /more than was counted/);
  assert.match(cashPlanProblem(234_000, { toSafe: 100_000, toBank: 0 }) ?? '', /who is taking/);
  assert.match(cashPlanProblem(234_000, { toSafe: -1, toBank: 0 }) ?? '', /less than nothing/);
  assert.equal(cashPlanProblem(234_000, { toSafe: 100_000, toBank: 100_000, takenBy: 'Kofi' }), null);
});

test('the safe holds what went in less what was banked from it', () => {
  const moves = [
    { kind: 'to_safe' as const, status: 'in_safe' as const, amount: 204_000 },
    { kind: 'to_safe' as const, status: 'in_safe' as const, amount: 50_000 },
    { kind: 'safe_to_bank' as const, status: 'banked' as const, amount: 200_000 },
    { kind: 'to_bank' as const, status: 'pending' as const, amount: 90_000 },
    { kind: 'to_bank' as const, status: 'banked' as const, amount: 80_000 },
  ];
  assert.equal(safeBalance(moves), 54_000);
  assert.equal(awaitingBank(moves).length, 1);
  assert.match(bankingProblem(0) ?? '', /Give the amount/);
  assert.match(bankingProblem(60_000, 54_000) ?? '', /more than the safe/);
  assert.equal(bankingProblem(54_000, 54_000), null);
});

const facts = (over: Partial<CloseDayFacts> = {}): CloseDayFacts => ({
  shifts: [
    { $id: 's1', code: 'BIST-0412', status: 'closed', cash_kept: 30_000 },
    { $id: 's2', code: 'BAR-0198', status: 'closed', cash_kept: 0 },
  ],
  pendingCountLines: 0, pendingSpends: 0, pendingSpendTotal: 0,
  cashAwaitingBank: 0, inSafe: 0, momoHanging: 0, cardHanging: 0,
  boxes: [{ name: 'Kitchen box', lastCounted: '2026-10-16T10:00:00Z' }],
  now: new Date('2026-10-17T10:00:00Z').getTime(),
  ...over,
});

test('a finished day is all done', () => {
  const rows = closeDayChecklist(facts(), money);
  assert.deepEqual(rows.map((r) => [r.key, r.state]), [
    ['shifts', 'done'], ['counts', 'done'], ['cash', 'done'], ['settle', 'done'], ['spends', 'done'], ['petty', 'done'],
  ]);
  assert.deepEqual(closeDayProgress(rows), { done: 6, of: 6 });
});

test('each job still to do says what and where', () => {
  const rows = closeDayChecklist(facts({
    shifts: [{ $id: 's1', code: 'BIST-0412', status: 'open' }, { $id: 's2', code: 'BAR-0198', status: 'closed' }],
    pendingCountLines: 4, pendingSpends: 2, pendingSpendTotal: 106_500,
    cashAwaitingBank: 204_000, inSafe: 50_000, momoHanging: 118_000, cardHanging: 46_000,
    boxes: [{ name: 'Kitchen box', lastCounted: '2026-10-01T10:00:00Z' }, { name: 'Bar box' }],
  }), money);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.match(by.shifts!.detail, /BIST-0412 still open/);
  assert.match(by.counts!.detail, /4 count differences/);
  assert.match(by.cash!.detail, /GH₵2040.00 taken to the bank, not yet confirmed.*GH₵500.00 in the safe/);
  assert.equal(by.cash!.to, '/accounting?tab=settle');
  assert.match(by.settle!.detail, /MoMo GH₵1180.00 and card GH₵460.00/);
  assert.match(by.spends!.detail, /2 spends, GH₵1065.00/);
  assert.match(by.petty!.detail, /Kitchen box last counted 16 days ago · Bar box never counted/);
  assert.deepEqual(closeDayProgress(rows), { done: 0, of: 6 });
});

test('a close that did not say where its cash went is named, and a quiet day has nothing to do', () => {
  const rows = closeDayChecklist(facts({ shifts: [{ $id: 's1', code: 'BIST-0400', status: 'closed' }] }), money);
  assert.match(rows.find((r) => r.key === 'cash')!.detail, /Closed without saying where the cash went: BIST-0400/);
  const quiet = closeDayChecklist(facts({ shifts: [], boxes: [] }), money);
  assert.deepEqual(quiet.map((r) => r.state), ['none', 'none', 'none', 'done', 'none', 'none']);
});
