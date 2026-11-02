/**
 * What each person has on, for the group hub's Team page: a signed, read-only
 * request names people by email and a period, and gets back, for each, their
 * shifts, spends, orders, counts and charges in the hub's shape. A small fake
 * database; every name is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleInsightTeam, countItem, periodOf, inPeriod } from './src/insight-team.js';

const SECRET = 'shared-with-the-hub';
const NOW = '2026-11-02T12:00:00.000Z';
const APP = 'https://pos.example.test/';
const PATH = '/team/activity';
const sign = (path, text, at = Date.now()) => ({ 'x-till-at': String(at), 'x-till-sig': createHmac('sha256', SECRET).update(`till-link\n${at}\n${path}\n${text}`).digest('hex') });

const Query = {
  equal: (field, value) => ({ field, value }),
  greaterThanEqual: (field, value) => ({ field, gte: value }),
  limit: () => ({ limit: true }),
  cursorAfter: () => ({ cursor: true }),
};
const matches = (r, q) => {
  if (!q.field) return true;
  if ('gte' in q) return String(r[q.field] ?? '') >= q.gte;
  return Array.isArray(q.value) ? q.value.includes(r[q.field]) : r[q.field] === q.value;
};

function world() {
  const reads = [];
  const tables = {
    staff_profiles: [
      { $id: 'p-kofi', user_id: 'u-kofi', email: 'kofi@example.test', display_name: 'Kofi Test', role: 'cashier', active: true },
      // No login id on the profile yet: found by the email.
      { $id: 'p-ama', user_id: '', email: 'ama@example.test', display_name: 'Ama Test', role: 'cashier', active: true },
      { $id: 'p-esi', user_id: 'u-esi', email: 'esi@example.test', display_name: 'Esi Test', role: 'cashier', active: true },
    ],
    shifts: [
      { $id: 'sh-open', module: 'bar', status: 'open', opened_by: 'u-kofi', opened_at: '2026-11-02T08:00:00.000Z', $createdAt: '2026-11-02T08:00:00.000Z', $updatedAt: '2026-11-02T08:00:00.000Z' },
      { $id: 'sh-closed', module: 'bar', status: 'closed', opened_by: 'u-kofi', opened_at: '2026-10-25T08:00:00.000Z', closed_by: 'u-kofi', closed_at: '2026-10-25T22:00:00.000Z', $createdAt: '2026-10-25T08:00:00.000Z', $updatedAt: '2026-10-25T22:00:00.000Z' },
      { $id: 'sh-old', module: 'kitchen', status: 'closed', opened_by: 'u-kofi', opened_at: '2026-09-01T08:00:00.000Z', closed_by: 'u-kofi', closed_at: '2026-09-01T22:00:00.000Z', $createdAt: '2026-09-01T08:00:00.000Z', $updatedAt: '2026-09-01T22:00:00.000Z' },
      { $id: 'sh-shop', module: 'craft', status: 'closed', opened_by: 'u-other', opened_at: '2026-10-31T08:00:00.000Z', closed_by: 'u-other', closed_at: '2026-10-31T20:00:00.000Z', $createdAt: '2026-10-31T08:00:00.000Z', $updatedAt: '2026-10-31T20:00:00.000Z' },
    ],
    shift_expenses: [
      { $id: 'e-wait', created_by: 'u-ama', module: 'bar', payee: 'A Drinks Depot', category: 'supplies', amount: 12000, approval_status: 'pending', $createdAt: '2026-10-30T12:00:00.000Z', $updatedAt: '2026-10-30T12:00:00.000Z' },
      { $id: 'e-ok', created_by: 'u-ama', module: 'kitchen', payee: 'A Market Stall', category: 'supplies', amount: 5000, approval_status: 'approved', approved_by: 'u-boss', $createdAt: '2026-10-28T10:00:00.000Z', $updatedAt: '2026-10-29T15:00:00.000Z' },
      { $id: 'e-mine', created_by: 'u-ama', module: 'kitchen', payee: 'Gas', category: 'utilities', amount: 3000, approval_status: 'not_required', $createdAt: '2026-10-21T10:00:00.000Z', $updatedAt: '2026-10-21T10:00:00.000Z' },
    ],
    stock_orders: [
      { $id: 'o-refused', po_no: 'PO-0142', supplier_name: 'A Drinks Depot', module: 'bar', status: 'refused', total: 64000, created_by: 'u-kofi', approved_by: 'u-boss', approved_at: '2026-10-27T09:00:00.000Z', admin_told_at: '2026-10-26T09:00:00.000Z', $createdAt: '2026-10-26T08:00:00.000Z', $updatedAt: '2026-10-27T09:00:00.000Z' },
      { $id: 'o-again', po_no: 'PO-0143', supplier_name: 'A Drinks Depot', module: 'bar', status: 'waiting', total: 70000, created_by: 'u-kofi', approved_by: 'u-boss', approved_at: '2026-10-31T12:00:00.000Z', expected_on: '2026-11-05', $createdAt: '2026-10-30T08:00:00.000Z', $updatedAt: '2026-11-01T08:00:00.000Z' },
    ],
    shift_stock_checks: [
      { $id: 'c1', shift_id: 'sh-closed', phase: 'close', module: 'bar', checked_by: 'u-kofi', variance_qty: -2, applied: false, $createdAt: '2026-10-25T21:30:00.000Z', $updatedAt: '2026-10-25T21:30:00.000Z' },
      { $id: 'c2', shift_id: 'sh-closed', phase: 'close', module: 'bar', checked_by: 'u-kofi', variance_qty: 0, applied: true, $createdAt: '2026-10-25T21:30:01.000Z', $updatedAt: '2026-10-25T21:30:01.000Z' },
      { $id: 'c3', shift_id: 'sh-esi', phase: 'open', module: 'bar', checked_by: 'u-esi', variance_qty: -6, applied: true, charge_id: 'ch1', approved_by: 'u-boss', approved_at: '2026-10-29T09:00:00.000Z', $createdAt: '2026-10-28T08:00:00.000Z', $updatedAt: '2026-10-29T09:00:00.000Z' },
    ],
    stock_counts: [
      { $id: 'sc1', counted_by: 'u-esi', counted_at: '2026-10-31T19:00:00.000Z', status: 'pending', line_count: 3, shift_id: 'sh-shop', phase: 'close', $createdAt: '2026-10-31T19:00:00.000Z', $updatedAt: '2026-10-31T19:00:00.000Z' },
    ],
    staff_charges: [
      { $id: 'ch1', person_id: 'p-esi', person_user_id: 'u-esi', person_name: 'Esi Test', source: 'bar_count', count_ref: 'sh-esi|open', module: 'bar', item_name: 'Tonic water', qty: 6, amount: 3000, direction: 'owed', status: 'open', charged_at: '2026-10-29T09:00:00.000Z', $createdAt: '2026-10-29T09:00:00.000Z', $updatedAt: '2026-10-29T09:00:00.000Z' },
    ],
    audit_log: [
      { $id: 'a1', action: 'spend_approved', entity_id: 'e-ok', $createdAt: '2026-10-29T10:00:00.000Z' },
    ],
  };
  const accounts = [
    { $id: 'u-kofi', email: 'kofi@example.test', name: 'Kofi Test' },
    { $id: 'u-ama', email: 'ama@example.test', name: 'Ama Test' },
    { $id: 'u-esi', email: 'esi@example.test', name: 'Esi Test' },
    // A login with no staff profile is not somebody on the team.
    { $id: 'u-guest', email: 'guest@example.test', name: 'Guest' },
  ];
  const db = {
    async listDocuments(_d, table, queries = []) {
      reads.push(table);
      let rows = tables[table] || [];
      for (const q of queries) rows = rows.filter((r) => matches(r, q));
      return { documents: rows, total: rows.length };
    },
    async getDocument() { throw new Error('read only: nothing should be fetched one by one'); },
    async createDocument() { throw new Error('read only: nothing may be written'); },
    async updateDocument() { throw new Error('read only: nothing may be written'); },
  };
  const users = {
    async list(queries = []) {
      reads.push('users');
      let rows = accounts;
      for (const q of queries) rows = rows.filter((r) => matches(r, q));
      return { users: rows, total: rows.length };
    },
  };
  return { tables, db, users, reads };
}

async function call(w, body, { headers = null, path = PATH } = {}) {
  const text = JSON.stringify(body);
  let out = null;
  const res = { json: (b, status = 200) => { out = { status, body: b }; return out; } };
  const handled = await handleInsightTeam({
    req: { path, method: 'POST', bodyText: text, headers: headers || sign(path, text) },
    res, db: w.db, DB_ID: 'snpos', users: w.users, Query, now: NOW,
    env: { INSIGHT_SSO_SECRET: SECRET, APP_URL: APP },
  });
  return handled ? out : null;
}

const ask = (o = {}) => ({ emails: ['Kofi@example.test', 'ama@example.test', 'esi@example.test', 'nobody@example.test', 'guest@example.test'], from: '2026-10-20', to: '2026-11-02', ...o });
const byId = (body, email) => Object.fromEntries(body.people[email].items.map((i) => [i.id, i]));

test('only the hub, and only this path', async () => {
  const w = world();
  assert.equal(await call(w, ask(), { path: '/approvals/list' }), null, 'not its path: left for the next');
  assert.equal((await call(w, ask(), { headers: { 'x-till-at': String(Date.now()), 'x-till-sig': 'no' } })).status, 401);
  const stale = sign(PATH, JSON.stringify(ask()), Date.now() - 10 * 60 * 1000);
  assert.equal((await call(w, ask(), { headers: stale })).status, 401);
  assert.deepEqual(w.reads, [], 'nothing read before the signature is good');
});

test('every email asked about is answered; one the POS does not know is not found', async () => {
  const w = world();
  const { status, body } = await call(w, ask());
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.people).sort(), ['ama@example.test', 'esi@example.test', 'guest@example.test', 'kofi@example.test', 'nobody@example.test']);
  assert.deepEqual(body.people['nobody@example.test'], { found: false, items: [] });
  assert.deepEqual(body.people['guest@example.test'], { found: false, items: [] }, 'a login without a staff profile');
  assert.equal(body.people['ama@example.test'].found, true, 'a profile found by its email');
  assert.equal(body.failed, undefined);
  // Every item carries every field of the contract.
  const keys = ['id', 'app', 'kind', 'title', 'status', 'routine', 'asked', 'decision', 'due', 'created_at', 'started_at', 'done_at',
    'waiting_on', 'waiting_since', 'waited_days', 'reopened', 'category', 'money_issue', 'amount', 'link'].sort();
  for (const p of Object.values(body.people)) for (const it of p.items) assert.deepEqual(Object.keys(it).sort(), keys, it.id);
});

test('a shift open is being done; one closed is done and routine; one long before the period is left out', async () => {
  const { body } = await call(world(), ask());
  const kofi = byId(body, 'kofi@example.test');
  assert.deepEqual(kofi['shift:sh-open'], {
    id: 'shift:sh-open', app: 'pos', kind: 'shift', title: 'Bar shift', status: 'doing', routine: false, asked: false, decision: null,
    due: '2026-11-02', created_at: '2026-11-02T08:00:00.000Z', started_at: '2026-11-02T08:00:00.000Z', done_at: null,
    waiting_on: null, waiting_since: null, waited_days: 0, reopened: 0, category: 'bar', money_issue: false, amount: null,
    link: 'https://pos.example.test/#/shifts',
  });
  const closed = kofi['shift:sh-closed'];
  assert.deepEqual([closed.status, closed.routine, closed.due, closed.done_at], ['done', true, '2026-10-25', '2026-10-25T22:00:00.000Z']);
  assert.equal(kofi['shift:sh-old'], undefined);
});

test('a spend waiting for approval is asked for, and says what holds it', async () => {
  const { body } = await call(world(), ask());
  const ama = byId(body, 'ama@example.test');
  const s = ama['spend:e-wait'];
  assert.deepEqual(
    [s.kind, s.title, s.status, s.asked, s.decision, s.waiting_on, s.waiting_since, s.waited_days, s.amount, s.category, s.link],
    ['spend', 'Spend · A Drinks Depot', 'open', true, 'waiting', 'Approval of the spend to A Drinks Depot', '2026-10-30T12:00:00.000Z', 3, 12000, 'bar', 'https://pos.example.test/#/waiting?show=spend'],
  );
  // Approved by somebody else: asked, decided when the audit trail says.
  const ok = ama['spend:e-ok'];
  assert.deepEqual([ok.status, ok.asked, ok.decision, ok.done_at, ok.waited_days, ok.waiting_on], ['done', true, 'approved', '2026-10-29T10:00:00.000Z', 1, null]);
  // Needed nobody: not asked.
  const mine = ama['spend:e-mine'];
  assert.deepEqual([mine.status, mine.asked, mine.decision], ['done', false, null]);
});

test('an order refused is decided and finished; refused and asked again counts as reopened', async () => {
  const { body } = await call(world(), ask());
  const kofi = byId(body, 'kofi@example.test');
  const r = kofi['order:o-refused'];
  assert.deepEqual(
    [r.title, r.status, r.asked, r.decision, r.done_at, r.waited_days, r.amount, r.waiting_on, r.link],
    ['PO-0142 · A Drinks Depot', 'cancelled', true, 'refused', '2026-10-27T09:00:00.000Z', 1, 64000, null, 'https://pos.example.test/#/purchase-orders?show=o-refused'],
  );
  const again = kofi['order:o-again'];
  assert.deepEqual(
    [again.status, again.decision, again.reopened, again.waiting_on, again.waiting_since, again.due],
    ['open', 'waiting', 1, 'Approval of PO-0143 (over the limit)', '2026-10-31T12:00:00.000Z', '2026-11-05'],
  );
});

test('a count held for an admin, then applied', async () => {
  const w = world();
  const held = byId((await call(w, ask())).body, 'kofi@example.test')['count:sh-closed|close'];
  assert.deepEqual(
    [held.kind, held.title, held.status, held.routine, held.decision, held.due, held.waiting_on, held.waiting_since, held.link],
    ['count', 'Bar count', 'open', false, 'waiting', '2026-10-25', 'Count held: 1 line differs, an admin decides', '2026-10-25T21:30:00.000Z', 'https://pos.example.test/#/waiting?show=count'],
  );
  assert.equal(held.waited_days, 7.6);

  Object.assign(w.tables.shift_stock_checks.find((c) => c.$id === 'c1'), { applied: true, approved_by: 'u-boss', approved_at: '2026-10-27T09:30:00.000Z', $updatedAt: '2026-10-27T09:30:00.000Z' });
  const done = byId((await call(w, ask())).body, 'kofi@example.test')['count:sh-closed|close'];
  assert.deepEqual(
    [done.status, done.routine, done.decision, done.done_at, done.waited_days, done.waiting_on, done.link],
    ['done', true, 'approved', '2026-10-27T09:30:00.000Z', 1.5, null, null],
  );
});

test('a count refused and done again is reopened once', () => {
  const it = countItem([
    { shift_id: 's9', phase: 'close', module: 'kitchen', variance_qty: -1, applied: false, rejected_at: '2026-10-26T10:00:00.000Z', $createdAt: '2026-10-25T22:00:00.000Z' },
    { shift_id: 's9', phase: 'close', module: 'kitchen', variance_qty: -1, applied: true, approved_at: '2026-10-27T10:00:00.000Z', $createdAt: '2026-10-26T12:00:00.000Z' },
  ], { now: NOW });
  assert.deepEqual([it.title, it.reopened, it.decision, it.status], ['Kitchen count', 1, 'approved', 'done']);
});

test('a staff charge is a money issue, and so is the count it came from; a shop count waits', async () => {
  const { body } = await call(world(), ask());
  const esi = byId(body, 'esi@example.test');
  assert.deepEqual(esi['charge:ch1'], {
    id: 'charge:ch1', app: 'pos', kind: 'charge', title: 'Charged for a count difference · Tonic water', status: 'open', routine: false,
    asked: false, decision: null, due: null, created_at: '2026-10-29T09:00:00.000Z', started_at: '2026-10-29T09:00:00.000Z', done_at: null,
    waiting_on: null, waiting_since: null, waited_days: 0, reopened: 0, category: 'bar', money_issue: true, amount: 3000,
    link: 'https://pos.example.test/#/staff-owing',
  });
  assert.equal(esi['count:sh-esi|open'].money_issue, true);
  const shop = esi['shop_count:sc1'];
  assert.deepEqual(
    [shop.kind, shop.status, shop.decision, shop.due, shop.waiting_on, shop.category],
    ['shop_count', 'open', 'waiting', '2026-10-31', 'Shop count held: 3 lines differ, an admin decides', 'craft'],
  );
});

test('the period and the number of people are limited', async () => {
  const w = world();
  assert.equal((await call(w, ask({ from: '2026-07-01', to: '2026-10-08' }))).status, 200, '100 days is allowed');
  const long = await call(w, ask({ from: '2026-07-01', to: '2026-10-09' }));
  assert.deepEqual([long.status, long.body.ok], [400, false], '101 days is not');
  assert.equal((await call(w, ask({ from: '2026-11-02', to: '2026-11-01' }))).status, 400);
  assert.equal((await call(w, ask({ from: '2026-02-30' }))).status, 400);
  assert.equal((await call(w, ask({ emails: 'kofi@example.test' }))).status, 400);
  const many = Array.from({ length: 201 }, (_, i) => `person${i}@example.test`);
  assert.equal((await call(w, ask({ emails: many }))).status, 400);
  assert.equal((await call(w, ask({ emails: many.slice(0, 200) }))).status, 200);
  assert.throws(() => periodOf({ from: '2026-01-01', to: '2026-04-11' }), /At most 100 days/);
});

test('the team is read in one go, not person by person', async () => {
  const few = world();
  await call(few, ask());
  const many = world();
  const emails = [...ask().emails, ...Array.from({ length: 190 }, (_, i) => `person${i}@example.test`)];
  await call(many, ask({ emails }));
  const tally = (reads) => reads.reduce((m, t) => ({ ...m, [t]: (m[t] || 0) + 1 }), {});
  // Two hundred people: two reads of the logins, the rest no more than for five.
  assert.equal(tally(many.reads).users, 2);
  assert.deepEqual(tally(many.reads).shift_expenses, tally(few.reads).shift_expenses);
  assert.ok(many.reads.length <= few.reads.length + 2, `${many.reads.length} reads for 195 people, ${few.reads.length} for 5`);
});

test('what is open always shows; what is finished shows only inside the period', () => {
  const period = { from: '2026-10-20', to: '2026-11-02' };
  assert.equal(inPeriod({ status: 'open', created_at: '2025-01-01T00:00:00.000Z' }, period), true);
  assert.equal(inPeriod({ status: 'done', created_at: '2025-01-01T00:00:00.000Z', done_at: '2026-10-21T00:00:00.000Z' }, period), true);
  assert.equal(inPeriod({ status: 'done', created_at: '2025-01-01T00:00:00.000Z', done_at: '2025-01-02T00:00:00.000Z' }, period), false);
});
