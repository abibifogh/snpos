/**
 * The auditor, follow-ups and the count log: the rules behind Checks and
 * To do. Every name and figure is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditorLimit, decisionRight, decisionRightWords, recommendProblem, recommendationOf, recommendationWords, isOwnCharge,
} from '../auditor.ts';
import {
  followUpStage, dueWords, sortFollowUps, followUpProblem, closeProblem, isMine, whoseWords, addDays, daysApart, doneLately,
} from '../follow-ups.ts';
import {
  entriesFromChecks, entriesFromShopCounts, drawerEntries, missedCounts, filterLog, logTotals, countLogCsv, checkState,
} from '../count-log.ts';
import type { CountCharge } from '../count-charges.ts';
import type { FollowUp } from '../follow-ups.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

const charge = (over: Partial<CountCharge> = {}): CountCharge => ({
  $id: 'c1', venue_id: 'main', person_id: 'p-kojo', person_user_id: 'u-kojo', person_name: 'Kojo Test',
  source: 'bar_count', item_name: 'Bar count', qty: 1, unit_price: 7_400, amount: 7_400, direction: 'owed',
  charged_by: 'system', charged_at: '2026-11-26T23:41:00.000Z', settled_total: 0, status: 'open', decision: 'pending',
  ...over,
} as CountCharge);

/* ------------------------------------------------------------ the auditor */

test('the limit is what the owner set, or a hundred of the currency', () => {
  assert.equal(auditorLimit({}, 2), 10_000);
  assert.equal(auditorLimit(null, 0), 100);
  assert.equal(auditorLimit({ auditor_limit: 25_000 }, 2), 25_000);
  assert.equal(auditorLimit({ auditor_limit: 0 }, 2), 0, 'nought: everything goes to a manager');
});

test('an auditor decides up to the limit and recommends above it; nobody decides their own', () => {
  const ada = { $id: 'p-ada', user_id: 'u-ada', role: 'auditor' };
  assert.equal(decisionRight(charge(), ada, 10_000), 'decide');
  assert.equal(decisionRight(charge({ amount: 10_500 }), ada, 10_000), 'recommend');
  assert.equal(decisionRight(charge({ amount: 50_000 }), { role: 'manager', $id: 'p-boss' }, 0), 'decide');
  assert.equal(decisionRight(charge(), { role: 'cashier', $id: 'p-x' }, 10_000), 'none');
  assert.equal(decisionRight(charge(), { ...ada, active: false }, 10_000), 'none');
  const kojo = { $id: 'p-kojo', user_id: 'u-kojo', role: 'manager' };
  assert.ok(isOwnCharge(charge(), kojo));
  assert.equal(decisionRight(charge(), kojo, 10_000), 'none');
  assert.match(decisionRightWords(charge(), kojo, 10_000, money) ?? '', /your own account/);
  assert.match(decisionRightWords(charge({ amount: 20_000 }), ada, 10_000, money) ?? '', /Above your limit of GH₵100\.00/);
  assert.equal(decisionRightWords(charge(), ada, 10_000, money), null);
});

test('a recommendation says why, and reads the way it would be confirmed', () => {
  assert.match(recommendProblem(charge(), { decision: 'waived', amount: 0, note: '' }) ?? '', /Say why/);
  assert.match(recommendProblem(charge(), { decision: 'part', amount: 7_400, note: 'Half was a breakage' }) ?? '', /all of it/);
  assert.match(recommendProblem(charge(), { decision: 'putback', amount: 0, note: 'Offered' }) ?? '', /offered/);
  assert.equal(recommendProblem(charge(), { decision: 'part', amount: 2_000, note: 'Half was a breakage' }), null);
  const c = charge({ recommended_decision: 'part', recommended_amount: 2_000, recommended_note: 'Breakage', recommended_name: 'Ada' });
  assert.deepEqual(recommendationOf(c)?.decision, 'part');
  assert.equal(recommendationOf({ ...c, decision: 'deduct' }), null, 'gone once decided');
  assert.equal(recommendationWords(c, { decision: 'part', amount: 2_000 }, money), 'Deduct GH₵20.00 of GH₵74.00');
  assert.equal(recommendationWords(c, { decision: 'waived', amount: 0 }, money), 'Waive GH₵74.00');
});

/* ------------------------------------------------------------- follow-ups */

const fu = (over: Partial<FollowUp> = {}): FollowUp => ({
  $id: 'f', venue_id: 'main', kind: 'task', title: 'Recount the spirits shelf', status: 'open', ...over,
});

test('a follow-up is overdue, due today, later or open-ended, and says so', () => {
  const today = '2026-11-27';
  assert.equal(followUpStage(fu({ due_on: '2026-11-25' }), today), 'overdue');
  assert.equal(dueWords(fu({ due_on: '2026-11-25' }), today), 'Overdue 2 days');
  assert.equal(dueWords(fu({ due_on: '2026-11-26' }), today), 'Overdue 1 day');
  assert.equal(dueWords(fu({ due_on: today }), today), 'Due today');
  assert.equal(dueWords(fu({ due_on: '2026-11-28' }), today), 'Due tomorrow');
  assert.match(dueWords(fu({ due_on: '2026-11-30' }), today), /^Due Mon 30 Nov$/);
  assert.equal(dueWords(fu({}), today), 'No day set');
  assert.equal(dueWords(fu({ status: 'done', due_on: '2026-11-01' }), today), 'Done');
  assert.deepEqual(
    sortFollowUps([fu({ title: 'b', due_on: '2026-11-30' }), fu({ title: 'c' }), fu({ title: 'a', due_on: '2026-11-20' })]).map((f) => f.title),
    ['a', 'b', 'c'],
  );
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(daysApart('2026-11-28', '2026-12-01'), 3);
});

test('adding and closing a follow-up are checked', () => {
  const today = '2026-11-27';
  assert.match(followUpProblem({ title: 'x' }, today) ?? '', /what needs doing/);
  assert.match(followUpProblem({ title: 'Recount gin', dueOn: '2026-11-20' }, today) ?? '', /passed/);
  assert.match(followUpProblem({ title: 'Recount gin', forRole: 'person' }, today) ?? '', /who it is for/);
  assert.equal(followUpProblem({ title: 'Recount gin', dueOn: today, forRole: 'auditor' }, today), null);
  assert.match(closeProblem('') ?? '', /what was done/);
  assert.equal(closeProblem('Recounted, it agreed.'), null);
});

test('whose a follow-up is, and how it says it', () => {
  const ada = { $id: 'p-ada', role: 'auditor' };
  assert.ok(isMine(fu({ for_role: 'auditor' }), ada));
  assert.ok(!isMine(fu({ for_role: 'manager' }), ada));
  assert.ok(isMine(fu({ for_role: 'manager' }), { role: 'admin' }), 'an admin can do anybody\'s');
  assert.ok(isMine(fu({ for_role: 'person', for_id: 'p-ada' }), ada));
  assert.equal(whoseWords(fu({ auto_key: 'review:c1', for_role: 'auditor' })), 'Raised automatically · for the auditor');
  assert.equal(whoseWords(fu({ created_name: 'Ada', for_role: 'person', for_name: 'Kojo' })), 'Added by Ada · for Kojo');
  const now = new Date('2026-11-27T12:00:00Z');
  const done = doneLately([
    fu({ status: 'done', done_at: '2026-11-26T09:00:00Z' }),
    fu({ status: 'done', done_at: '2026-11-01T09:00:00Z' }),
    fu({ status: 'done', done_at: '2026-11-26T10:00:00Z', kind: 'note' }),
  ], now);
  assert.equal(done.length, 1, 'notes are not tasks, and a month ago is not this week');
});

/* -------------------------------------------------------------- count log */

const names = {
  shift: (id: string) => ({ s1: 'BAR-1126', s2: 'BAR-1125' } as Record<string, string>)[id] ?? '?',
  room: () => 'Store room',
  shelf: (id: string) => ({ club: 'Club 330ml', gin: 'Gin 25cl' } as Record<string, string>)[id] ?? '?',
};

test('counted lines become one row per shift end, short and over kept apart', () => {
  const rows = entriesFromChecks([
    { $id: '1', $createdAt: '2026-11-26T23:40:00Z', shift_id: 's1', phase: 'close', ingredient_id: 'club', module: 'bar', counted_qty: 44, theoretical_qty: 48, variance_qty: -4, variance_value: -6_000, checked_by: 'u-kojo', charge_id: 'c1' },
    { $id: '2', $createdAt: '2026-11-26T23:41:00Z', shift_id: 's1', phase: 'close', ingredient_id: 'gin', module: 'bar', counted_qty: 31, theoretical_qty: 30, variance_qty: 1, variance_value: 1_200, checked_by: 'u-kojo' },
    { $id: '3', $createdAt: '2026-11-26T08:10:00Z', shift_id: 's1', phase: 'open', ingredient_id: 'club', module: 'bar', counted_qty: 48, theoretical_qty: 48, variance_qty: 0, variance_value: 0, checked_by: 'u-kojo' },
    { $id: '4', $createdAt: '2026-11-24T16:00:00Z', shift_id: 'store:back', phase: 'close', ingredient_id: 'club', module: 'bar', counted_qty: 11, theoretical_qty: 12, variance_qty: -1, variance_value: -9_000, applied: false },
  ], names);
  const end = rows.find((r) => r.kind === 'end')!;
  assert.equal(end.place, 'BAR-1126');
  assert.equal(end.short, 6_000);
  assert.equal(end.over, 1_200);
  assert.equal(end.state, 'differs');
  assert.equal(end.chargeId, 'c1');
  assert.equal(end.at, '2026-11-26T23:40:00Z', 'when the first line was written');
  assert.deepEqual(end.lines?.map((l) => [l.name, l.diff, l.worth]), [['Club 330ml', -4, -6_000], ['Gin 25cl', 1, 1_200]]);
  assert.equal(rows.find((r) => r.kind === 'start')!.state, 'agrees');
  const store = rows.find((r) => r.kind === 'stocktake')!;
  assert.equal(store.place, 'Store room');
  assert.equal(store.shiftId, undefined);
  assert.equal(store.state, 'waiting');
  assert.equal(checkState([{ variance_qty: -1, applied: false, rejected_at: '2026-11-25' }]), 'refused');
  assert.equal(checkState([{ variance_qty: -1, undone_at: '2026-11-25' }]), 'undone');
});

test('shop counts, the drawer, and the counts nobody filed', () => {
  const shop = entriesFromShopCounts([
    { $id: 'k1', counted_at: '2026-11-23T09:00:00Z', counted_by: 'p-efua', status: 'pending', line_count: 64, missing_pieces: 1, missing_value: 6_000 },
    { $id: 'k2', counted_at: '2026-11-23T18:00:00Z', status: 'approved', line_count: 64, shift_id: 's9', phase: 'close' },
  ], () => 'SHOP-1123');
  assert.equal(shop[0].kind, 'stocktake');
  assert.equal(shop[0].place, 'Shop floor');
  assert.equal(shop[0].state, 'waiting');
  assert.equal(shop[0].short, 6_000);
  assert.equal(shop[1].kind, 'end');
  assert.equal(shop[1].state, 'agrees');

  const shifts = [
    { $id: 's1', code: 'BAR-1126', module: 'bar', status: 'closed', opened_by: 'u-kojo', opened_at: '2026-11-26T08:00:00Z', closed_by: 'u-kojo', closed_at: '2026-11-26T23:50:00Z',
      opening_floats: '{"cash":20000}', expected: '{"cash":150000}', counted: '{"cash":148000}', variance: '{"cash":-2000}', variance_note: 'Short change' },
    { $id: 's2', code: 'BAR-1125', module: 'bar', status: 'closed', opened_by: 'u-abena', opened_at: '2026-11-25T08:00:00Z', closed_by: 'u-abena', closed_at: '2026-11-25T23:55:00Z',
      opening_floats: '{"cash":20000}', float_source: 'carried_over', expected: '{"cash":90000}', counted: '{"cash":90000}', variance: '{"cash":0}' },
  ];
  const cash = drawerEntries(shifts, money);
  const close1 = cash.find((e) => e.id === 'cash|s1|close')!;
  assert.equal(close1.short, 2_000);
  assert.equal(close1.amount, 148_000);
  assert.equal(close1.state, 'differs');
  assert.match(close1.note ?? '', /should have held GH₵1500\.00 · “Short change”/);
  assert.match(cash.find((e) => e.id === 'cash|s2|open')!.note ?? '', /carried over/);

  const filed = entriesFromChecks([
    { $id: '1', $createdAt: '2026-11-26T08:10:00Z', shift_id: 's1', phase: 'open', ingredient_id: 'club', module: 'bar', variance_qty: 0 },
    { $id: '2', $createdAt: '2026-11-26T23:40:00Z', shift_id: 's1', phase: 'close', ingredient_id: 'club', module: 'bar', variance_qty: 0 },
    { $id: '3', $createdAt: '2026-11-25T08:10:00Z', shift_id: 's2', phase: 'open', ingredient_id: 'club', module: 'bar', variance_qty: 0 },
  ], names);
  const missed = missedCounts(shifts, filed, (m) => m === 'bar', new Date('2026-11-27T12:00:00Z'));
  assert.deepEqual(missed.map((m) => [m.place, m.kind, m.note]), [['BAR-1125', 'end', 'Closed with no end-of-shift count.']]);
  // A shift opened ten minutes ago has not missed its count yet.
  const fresh = missedCounts([{ $id: 'n', module: 'bar', status: 'open', opened_at: '2026-11-27T11:50:00Z' }], [], () => true, new Date('2026-11-27T12:00:00Z'));
  assert.equal(fresh.length, 0);
});

test('the log filters, totals and downloads the way the screen shows it', () => {
  const rows = [
    ...entriesFromChecks([
      { $id: '1', $createdAt: '2026-11-26T23:40:00Z', shift_id: 's1', phase: 'close', ingredient_id: 'club', module: 'bar', variance_qty: -4, variance_value: -6_000, checked_by: 'u-kojo' },
      { $id: '2', $createdAt: '2026-11-26T08:10:00Z', shift_id: 's1', phase: 'open', ingredient_id: 'club', module: 'bar', variance_qty: 0, checked_by: 'u-kojo' },
      { $id: '3', $createdAt: '2026-11-20T08:10:00Z', shift_id: 's2', phase: 'open', ingredient_id: 'club', module: 'kitchen', variance_qty: 0, checked_by: 'u-yaw' },
    ], names),
  ];
  const week = { from: '2026-11-23T00:00:00Z', to: '2026-11-29T23:59:59Z' };
  assert.equal(filterLog(rows, week).length, 2);
  assert.equal(filterLog(rows, { ...week, onlyDifferences: true }).length, 1);
  assert.equal(filterLog(rows, { ...week, kind: 'start' }).length, 1);
  assert.equal(filterLog(rows, { ...week, by: 'u-yaw' }).length, 0);
  assert.equal(filterLog(rows, { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z', side: 'kitchen' }).length, 1);
  const t = logTotals(filterLog(rows, week));
  assert.deepEqual([t.counts, t.agree, t.short, t.over, t.net], [2, 1, 6_000, 0, -6_000]);
  const csv = countLogCsv(filterLog(rows, week), (id) => (id === 'u-kojo' ? '=Kojo' : ''));
  assert.ok(csv.startsWith('﻿When,Shift or room'));
  assert.match(csv, /'=Kojo/, 'a name that starts a formula stays a name');
  assert.match(csv, /,60\.00,0\.00,Differs,/);
});
