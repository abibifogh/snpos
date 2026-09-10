import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeChecklist, mayLock, closeProgress, lockOverWarningsWords, shiftsInPeriod,
} from '../period-close.ts';
import type { CloseFacts } from '../period-close.ts';

const clean: CloseFacts = {
  through: '2026-09-30',
  from: '2026-09-01',
  shifts: [
    { $id: 's1', code: 'BAR-1', status: 'closed', opened_at: '2026-09-02T17:00:00Z', locked_at: '2026-09-03T10:00:00Z', module: 'bar' },
    { $id: 's2', code: 'KIT-1', status: 'closed', opened_at: '2026-09-02T11:00:00Z', locked_at: '2026-09-03T10:00:00Z', module: 'kitchen' },
    // October: not this month's business.
    { $id: 's3', code: 'BAR-2', status: 'open', opened_at: '2026-10-01T17:00:00Z', module: 'bar' },
  ],
  pendingBarLines: 0,
  pendingShopCounts: 0,
  pendingSpends: 0,
  pendingSpendValue: 0,
  pendingShelfChanges: 0,
  hanging: { card: 0, momo: 0, tips: 0, tax: 0 },
  owedToMakers: 0,
  lastCounted: { bar: '2026-09-30', kitchen: '2026-09-29' },
  trialBalanced: true,
};

const state = (f: CloseFacts, key: string) => closeChecklist(f).find((i) => i.key === key)?.state;

test('a finished month passes every check and may be locked', () => {
  const items = closeChecklist(clean);
  assert.ok(items.every((i) => i.state === 'ok'), JSON.stringify(items.filter((i) => i.state !== 'ok')));
  assert.equal(mayLock(items).ok, true);
  assert.equal(closeProgress(items), `${items.length} of ${items.length} done`);
});

test('an unsettled shift blocks, because its figures are not final', () => {
  /*
    The fault this exists for: a month locked over a night that could still
    be corrected, so the correction had nowhere to land.
  */
  const f = { ...clean, shifts: [{ ...clean.shifts[0], locked_at: null }, clean.shifts[1]] };
  assert.equal(state(f, 'shifts'), 'block');
  assert.equal(mayLock(closeChecklist(f)).ok, false);
  const open = { ...clean, shifts: [{ ...clean.shifts[0], status: 'open', locked_at: null }] };
  assert.match(closeChecklist(open).find((i) => i.key === 'shifts')!.detail, /still open/);
});

test('a shift that started next month is not this month’s problem', () => {
  assert.deepEqual(shiftsInPeriod(clean.shifts, '2026-09-30').map((s) => s.$id), ['s1', 's2']);
});

test('counts and spends waiting for a decision block; shelf changes only warn', () => {
  assert.equal(state({ ...clean, pendingBarLines: 2 }, 'counts'), 'block');
  assert.equal(state({ ...clean, pendingShopCounts: 1 }, 'counts'), 'block');
  assert.equal(state({ ...clean, pendingSpends: 1, pendingSpendValue: 12_000 }, 'spends'), 'block');
  assert.equal(state({ ...clean, pendingShelfChanges: 1 }, 'shelf'), 'warn');
});

test('money in transit warns and does not block', () => {
  /*
    A September card settlement that lands in October belongs to October.
    Refusing to close September until it arrives would make every month
    unclosable until the middle of the next.
  */
  const f = { ...clean, hanging: { card: 500, momo: 12_400, tips: 1_240, tax: 3_000 }, owedToMakers: 3_860 };
  const items = closeChecklist(f);
  for (const key of ['clearing', 'tips', 'tax', 'makers']) assert.equal(items.find((i) => i.key === key)?.state, 'warn', key);
  const verdict = mayLock(items);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.warnings.length, 4);
  assert.match(lockOverWarningsWords(verdict.warnings, '2026-09-30'), /4 things still in transit/);
});

test('a side that traded and was not counted this month is named', () => {
  const f = { ...clean, lastCounted: { bar: '2026-08-30', kitchen: '2026-09-29' } };
  const item = closeChecklist(f).find((i) => i.key === 'counted')!;
  assert.equal(item.state, 'warn');
  assert.match(item.detail, /^Bar not counted/);
});

test('books that do not add up block', () => {
  assert.equal(state({ ...clean, trialBalanced: false }, 'trial'), 'block');
});
