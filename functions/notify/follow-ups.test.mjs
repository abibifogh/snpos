/**
 * Follow-ups the system raises and closes itself, and the morning email, run
 * the way the hourly timer runs them against a small fake database. Every
 * name is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { wantedFollowUps, morningRecipients, sweepFollowUps, countsAtEnd, addDays } from './src/follow-ups.js';

const money = (m) => `GH₵${(m / 100).toFixed(2)}`;
const NOW = '2026-11-27T09:00:00.000Z';
const opts = { now: NOW, timeZone: 'Africa/Accra', money };

test('what should be open, from the facts', () => {
  const wanted = wantedFollowUps({
    charges: [
      { $id: 'c1', decision: 'pending', answer: 'explain', person_name: 'Kojo Test', amount: 7_400, charged_at: '2026-11-26T23:41:00Z' },
      { $id: 'c2', decision: 'pending', answer: null, person_name: 'Ama Test', amount: 1_000, charged_at: '2026-11-26T23:41:00Z' },
      { $id: 'c3', decision: 'pending', answer: 'explain', recommended_decision: 'waived', recommended_name: 'Ada', recommended_at: '2026-11-26T10:00:00Z', person_name: 'Efua Test', amount: 20_000, charged_at: '2026-11-25T23:00:00Z' },
      { $id: 'c4', decision: 'putback', status: 'open', decided_at: '2026-11-24T08:00:00Z', person_name: 'Abena Test', amount: 2_400, settled_total: 0 },
    ],
    decided: [
      { $id: 'd1', decision: 'deduct', decided_at: '2026-10-20T10:00:00Z' },
      { $id: 'd2', decision: 'deduct', decided_at: '2026-10-21T10:00:00Z', hive_sent_at: '2026-10-31T10:00:00Z' },
      { $id: 'd3', decision: 'deduct', decided_at: '2026-11-10T10:00:00Z' },
    ],
    shifts: [
      { $id: 's1', code: 'BAR-1125', module: 'bar', status: 'closed', opened_by: 'u-abena', opened_at: '2026-11-25T08:00:00Z', closed_at: '2026-11-25T23:55:00Z', closed_by: 'u-abena' },
      { $id: 's2', code: 'KIT-1125', module: 'kitchen', status: 'closed', opened_at: '2026-11-25T08:00:00Z', closed_at: '2026-11-25T22:00:00Z' },
    ],
    countedEnds: [{ shift_id: 's1', phase: 'open' }],
    waitingCounts: [
      { key: 'store:back|close', at: '2026-11-24T16:00:00Z', label: 'the store-room count', ref_id: '' },
      { key: 's9|close', at: '2026-11-27T07:00:00Z', label: 'a fresh one', ref_id: 's9' },
    ],
    openShifts: [{ $id: 's8', code: 'BAR-1124', opened_at: '2026-11-25T08:00:00Z', extended_hours: 0 }],
    people: [{ $id: 'p-abena', user_id: 'u-abena', display_name: 'Abena Test' }],
  }, opts);
  const keys = wanted.map((w) => w.auto_key).sort();
  assert.deepEqual(keys, [
    'approval:store:back|close', 'confirm:c3', 'hive:2026-10', 'hive:2026-11', 'nocount:s1:close', 'overtime:s8', 'putback:c4', 'review:c1',
  ]);
  const byKey = Object.fromEntries(wanted.map((w) => [w.auto_key, w]));
  assert.equal(byKey['review:c1'].for_role, 'auditor');
  assert.equal(byKey['review:c1'].due_on, '2026-11-27', 'a day after the count');
  assert.equal(byKey['confirm:c3'].for_role, 'manager');
  assert.match(byKey['confirm:c3'].title, /Ada's recommendation on Efua Test/);
  assert.match(byKey['nocount:s1:close'].title, /BAR-1125 closed with no end-of-shift count: ask Abena Test/);
  assert.match(byKey['putback:c4'].title, /Abena Test put back GH₵24\.00/);
  assert.equal(byKey['hive:2026-10'].due_on, '2026-10-31');
  assert.equal(byKey['hive:2026-10'].for_role, 'admin');
  // This month's from the 25th, due on its last day.
  assert.equal(byKey['hive:2026-11'].due_on, '2026-11-30');
  assert.match(byKey['overtime:s8'].title, /open 49 hours/);
  // The kitchen glances rather than counts until it is set to count.
  assert.equal(countsAtEnd('kitchen', {}), false);
  assert.equal(countsAtEnd('kitchen', { kitchen_stock_check: 'count' }), true);
});

test('the morning email goes to whose it is, and two days late to the admins as well', () => {
  const people = [
    { $id: 'p-ada', role: 'auditor', email: 'ada@example.test' },
    { $id: 'p-boss', role: 'manager', email: 'boss@example.test' },
    { $id: 'p-owner', role: 'admin', email: 'owner@example.test' },
    { $id: 'p-kojo', role: 'cashier', email: 'kojo@example.test' },
  ];
  const today = '2026-11-27';
  const to = morningRecipients([
    { $id: 'a', for_role: 'auditor', due_on: today },
    { $id: 'b', for_role: 'manager', due_on: addDays(today, -3) },
    { $id: 'c', for_role: 'person', for_id: 'p-kojo', due_on: today },
  ], people, today);
  assert.deepEqual(to.get('ada@example.test').map((f) => f.$id), ['a']);
  assert.deepEqual(to.get('boss@example.test').map((f) => f.$id), ['b']);
  assert.deepEqual(to.get('owner@example.test').map((f) => f.$id), ['b'], 'three days late reaches the owner');
  assert.deepEqual(to.get('kojo@example.test').map((f) => f.$id), ['c']);
  // No auditor: their follow-ups go to the managers and admins.
  const none = morningRecipients([{ $id: 'a', for_role: 'auditor', due_on: today }], people.filter((p) => p.role !== 'auditor'), today);
  assert.ok(none.has('boss@example.test') && none.has('owner@example.test'));
});

/* ------------------------------------------------- against a fake database */

const Query = {
  equal: (field, value) => ({ field, value }),
  greaterThanEqual: (field, value) => ({ field, gte: value }),
  limit: () => ({}),
  cursorAfter: () => ({}),
};
const matches = (r, q) => {
  if (!q.field) return true;
  if ('gte' in q) return String(r[q.field] ?? '') >= q.gte;
  return Array.isArray(q.value) ? q.value.includes(r[q.field]) : r[q.field] === q.value;
};

function world() {
  let n = 0;
  const outbox = [];
  const tables = {
    follow_ups: [],
    shifts: [{ $id: 's1', code: 'BAR-1125', module: 'bar', status: 'closed', opened_by: 'u-abena', opened_at: '2026-11-25T08:00:00Z', closed_at: '2026-11-25T23:55:00Z', closed_by: 'u-abena' }],
    staff_profiles: [
      { $id: 'p-abena', user_id: 'u-abena', display_name: 'Abena Test', role: 'cashier', active: true },
      { $id: 'p-ada', user_id: 'u-ada', display_name: 'Ada Test', role: 'auditor', active: true, email: 'ada@example.test' },
    ],
    staff_charges: [{ $id: 'c1', decision: 'pending', answer: 'explain', person_name: 'Kojo Test', amount: 7_400, charged_at: '2026-11-25T23:41:00Z' }],
    shift_stock_checks: [{ $id: 'k1', shift_id: 's1', phase: 'open', applied: true }],
    stock_counts: [],
  };
  const db = {
    async listDocuments(_d, table, qs = []) {
      const rows = (tables[table] ?? []).filter((r) => qs.every((q) => matches(r, q)));
      return { documents: rows, total: rows.length };
    },
    async createDocument(_d, table, id, data) {
      const row = { $id: id, ...data };
      tables[table].push(row);
      return row;
    },
    async updateDocument(_d, table, id, data) {
      const r = tables[table].find((x) => x.$id === id);
      Object.assign(r, data);
      return r;
    },
  };
  const ctx = {
    db, DB_ID: 'snpos', Query, money, timeZone: 'Africa/Accra',
    newId: () => `f${(n += 1)}`,
    send: async (m) => { outbox.push(m); },
    error: () => {},
  };
  return { tables, ctx, outbox };
}

test('the sweep raises each once, emails once a day, and closes what is dealt with', async () => {
  const w = world();
  const first = await sweepFollowUps(w.ctx, { now: NOW, settings: { timezone: 'Africa/Accra' } });
  assert.equal(first.raised, 2);
  assert.deepEqual(w.tables.follow_ups.map((f) => f.auto_key).sort(), ['nocount:s1:close', 'review:c1']);
  assert.equal(w.outbox.length, 1, 'one email to the auditor');
  assert.equal(w.outbox[0].to[0], 'ada@example.test');
  assert.match(w.outbox[0].subject, /2 follow-ups due today/);

  // An hour later: nothing new, and no second email.
  const again = await sweepFollowUps(w.ctx, { now: '2026-11-27T10:00:00.000Z', settings: { timezone: 'Africa/Accra' } });
  assert.equal(again.raised, 0);
  assert.equal(w.outbox.length, 1);

  // The difference is decided and the count turns up: both close themselves.
  w.tables.staff_charges[0].decision = 'deduct';
  w.tables.shift_stock_checks.push({ $id: 'k2', shift_id: 's1', phase: 'close', applied: true });
  const later = await sweepFollowUps(w.ctx, { now: '2026-11-27T11:00:00.000Z', settings: { timezone: 'Africa/Accra' } });
  assert.equal(later.closed, 2);
  assert.ok(w.tables.follow_ups.every((f) => f.status === 'done' && f.done_by === 'system'));

  // Taken back: the review comes back. A person-closed one would not.
  w.tables.staff_charges[0].decision = 'pending';
  w.tables.staff_charges[0].reopened_by = 'u-boss';
  const back = await sweepFollowUps(w.ctx, { now: '2026-11-27T12:00:00.000Z', settings: { timezone: 'Africa/Accra' } });
  assert.equal(back.raised, 1);
  const review = w.tables.follow_ups.find((f) => f.auto_key === 'review:c1');
  assert.equal(review.status, 'open');
  review.status = 'done';
  review.done_by = 'p-ada';
  const kept = await sweepFollowUps(w.ctx, { now: '2026-11-27T13:00:00.000Z', settings: { timezone: 'Africa/Accra' } });
  assert.equal(kept.raised, 0, 'a person closed it; it stays closed');
});

test('a database without follow-ups is left alone', async () => {
  const w = world();
  delete w.tables.follow_ups;
  w.ctx.db.listDocuments = async (_d, table) => { if (table === 'follow_ups') throw new Error('Collection not found'); return { documents: [] }; };
  assert.deepEqual(await sweepFollowUps(w.ctx, { now: NOW }), { skipped: 'no follow_ups collection' });
});
