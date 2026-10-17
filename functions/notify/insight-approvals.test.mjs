/**
 * The group hub's Approvals page, as far as the POS can tell: a signed
 * request naming somebody by email, what waits for them, and a decision
 * written the way the admin app writes it. A small fake database; every
 * name is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleInsightApprovals, signedByHub, mayDecide } from './src/insight-approvals.js';

const SECRET = 'shared-with-the-hub';
const sign = (path, text, at = Date.now()) => ({ 'x-till-at': String(at), 'x-till-sig': createHmac('sha256', SECRET).update(`till-link\n${at}\n${path}\n${text}`).digest('hex') });

const Query = {
  equal: (field, value) => ({ field, value }),
  limit: () => ({ limit: true }),
  cursorAfter: () => ({ cursor: true }),
};

function world() {
  const tables = {
    staff_profiles: [
      { $id: 'p1', user_id: 'u1', email: 'owner@example.test', display_name: 'Test Owner', role: 'admin', active: true },
      { $id: 'p2', user_id: 'u2', email: 'kofi@example.test', display_name: 'Kofi Test', role: 'manager', active: true },
      { $id: 'p3', user_id: 'u3', email: 'ama@example.test', display_name: 'Ama Test', role: 'waiter', active: true },
    ],
    shift_expenses: [{ $id: 'e1', venue_id: 'main', shift_id: 's1', amount: 25000, payee: 'A Gas Seller', category: 'Gas', approval_status: 'pending', created_by: 'u3', $createdAt: '2026-10-17T08:00:00Z' }],
    purchase_orders: [{ $id: 'o1', venue_id: 'main', po_no: 'PO-0042', supplier_name: 'A Drinks Supplier', status: 'waiting', total: 185000, created_by_name: 'Kofi Test', lines: JSON.stringify([{ name: 'Club beer', qty: 10, buy_label: 'crates', unit_cost: 15000 }]), $createdAt: '2026-10-16T08:00:00Z' }],
    group_bookings: [
      { $id: 'g1', status: 'pending', contact_name: 'A Choir', email: 'choir@example.test', size: 30, total: 900000, first_at: '2026-10-24T12:00:00Z', $createdAt: '2026-10-15T08:00:00Z' },
      { $id: 'g2', status: 'pending', contact_name: 'A Wedding', size: 80, $createdAt: '2026-10-15T09:00:00Z' },
    ],
    orders: [{ $id: 'r1', group_booking_id: 'g2', status: 'NEW' }],
    booking_changes: [{ $id: 'c1', status: 'open', contact_name: 'A Choir', kind: 'time', note: 'Can we start at 1pm?', $createdAt: '2026-10-17T07:00:00Z' }],
    shift_stock_checks: [{ $id: 'k1', shift_id: 's9', phase: 'close', module: 'bar', ingredient_id: 'i1', applied: false, theoretical_qty: 4, counted_qty: 3, checked_by: 'u3', $createdAt: '2026-10-17T06:00:00Z' }],
    stock_counts: [],
    ingredients: [{ $id: 'i1', name: 'Gin 75cl' }],
    audit_log: [],
  };
  const db = {
    async listDocuments(_d, table, queries = []) {
      let rows = tables[table] || [];
      for (const q of queries) if (q.field) rows = rows.filter((r) => (Array.isArray(q.value) ? q.value.includes(r[q.field]) : r[q.field] === q.value));
      return { documents: rows, total: rows.length };
    },
    async getDocument(_d, table, id) {
      if (table === 'settings') return { currency_symbol: 'GH₵' };
      const row = (tables[table] || []).find((r) => r.$id === id);
      if (!row) throw new Error('Document not found');
      return row;
    },
    async updateDocument(_d, table, id, data) { const row = tables[table].find((r) => r.$id === id); Object.assign(row, data); return row; },
    async createDocument(_d, table, _id, data) { tables[table].push(data); return data; },
  };
  const users = {
    async list(queries) {
      const email = queries[0].value;
      const all = [{ $id: 'u1', email: 'owner@example.test', name: 'Test Owner', status: true }, { $id: 'u2', email: 'kofi@example.test', name: 'Kofi Test', status: true }, { $id: 'u3', email: 'ama@example.test', name: 'Ama Test', status: true }];
      return { users: all.filter((u) => u.email === email) };
    },
  };
  return { tables, db, users };
}

async function call(w, path, body, headers = null) {
  const text = JSON.stringify(body);
  let out = null;
  const res = { json: (b, status = 200) => { out = { status, body: b }; return out; } };
  await handleInsightApprovals({
    req: { path, method: 'POST', bodyText: text, headers: headers || sign(path, text) },
    res, db: w.db, DB_ID: 'snpos', users: w.users, Query, env: { INSIGHT_SSO_SECRET: SECRET, APP_URL: 'https://pos.example.test' },
  });
  return out;
}

test('only the hub, recently, for this path and body', () => {
  const h = sign('/approvals/list', '{}');
  assert.equal(signedByHub(SECRET, { at: h['x-till-at'], sig: h['x-till-sig'], path: '/approvals/list', bodyText: '{}' }), true);
  assert.equal(signedByHub(SECRET, { at: h['x-till-at'], sig: h['x-till-sig'], path: '/approvals/decide', bodyText: '{}' }), false);
  const old = sign('/approvals/list', '{}', Date.now() - 10 * 60 * 1000);
  assert.equal(signedByHub(SECRET, { at: old['x-till-at'], sig: old['x-till-sig'], path: '/approvals/list', bodyText: '{}' }), false);
  assert.equal(mayDecide('manager', 'spend'), true);
  assert.equal(mayDecide('manager', 'count'), false);
});

test('an unsigned request, and somebody with no say here, are refused', async () => {
  const w = world();
  assert.equal((await call(w, '/approvals/list', { email: 'owner@example.test' }, { 'x-till-at': '1', 'x-till-sig': 'no' })).status, 401);
  assert.equal((await call(w, '/approvals/list', { email: 'nobody@example.test' })).status, 403);
  const waiter = await call(w, '/approvals/list', { email: 'ama@example.test' });
  assert.equal(waiter.status, 403);
  assert.match(waiter.body.error, /not an admin or a manager/);
});

test('the list: each kind in words, counts to be decided in the POS', async () => {
  const w = world();
  const { body } = await call(w, '/approvals/list', { email: 'owner@example.test' });
  assert.equal(body.ok, true);
  const by = Object.fromEntries(body.items.map((i) => [`${i.kind}:${i.id}`, i]));
  assert.equal(by['spend:e1'].title, 'Spend · A Gas Seller');
  assert.equal(by['spend:e1'].amount, 25000);
  assert.deepEqual(by['order:o1'].details[0], ['Club beer', '10 crates × GH₵150.00']);
  assert.deepEqual(by['group_booking:g1'].decisions.map((d) => d.key), ['approve', 'refuse']);
  assert.deepEqual(by['group_booking:g2'].decisions.map((d) => d.key), ['approve'], 'meal times on the list: refused in the POS only');
  assert.equal(by['count:s9|close'].decisions.length, 0);
  assert.deepEqual(by['count:s9|close'].details[0], ['Gin 75cl', 'expected 4, counted 3']);
  assert.equal(by['count:s9|close'].open, 'https://pos.example.test/#/waiting?show=count');
  // A manager sees what a manager decides, and no counts.
  const kofi = await call(w, '/approvals/list', { email: 'kofi@example.test' });
  assert.equal(kofi.body.items.some((i) => i.kind === 'count'), false);
});

test('decisions are written as the app writes them, with an audit row from Insight', async () => {
  const w = world();
  const spend = await call(w, '/approvals/decide', { email: 'owner@example.test', kind: 'spend', id: 'e1', decision: 'refuse' });
  assert.equal(spend.status, 200);
  assert.equal(spend.body.as, 'Test Owner via Insight');
  assert.deepEqual([w.tables.shift_expenses[0].approval_status, w.tables.shift_expenses[0].approved_by], ['rejected', 'u1']);
  assert.deepEqual([w.tables.audit_log[0].action, w.tables.audit_log[0].device], ['spend_refused', 'Insight']);
  // Already decided: said, and nothing written again.
  assert.equal((await call(w, '/approvals/decide', { email: 'owner@example.test', kind: 'spend', id: 'e1', decision: 'approve' })).status, 409);

  await call(w, '/approvals/decide', { email: 'kofi@example.test', kind: 'order', id: 'o1', decision: 'approve', note: 'Fine this once' });
  assert.deepEqual([w.tables.purchase_orders[0].status, w.tables.purchase_orders[0].approved_by, w.tables.purchase_orders[0].decided_note], ['ready', 'u2', 'Fine this once']);

  const refused = await call(w, '/approvals/decide', { email: 'owner@example.test', kind: 'group_booking', id: 'g2', decision: 'refuse' });
  assert.equal(refused.status, 409);
  assert.equal(w.tables.group_bookings[1].status, 'pending');
  await call(w, '/approvals/decide', { email: 'owner@example.test', kind: 'group_booking', id: 'g1', decision: 'approve', note: 'See you then' });
  assert.deepEqual([w.tables.group_bookings[0].status, w.tables.group_bookings[0].decided_note], ['approved', 'See you then']);

  await call(w, '/approvals/decide', { email: 'owner@example.test', kind: 'booking_change', id: 'c1', decision: 'approve', note: '1pm is fine' });
  assert.deepEqual([w.tables.booking_changes[0].status, w.tables.booking_changes[0].reply], ['done', '1pm is fine']);

  assert.equal((await call(w, '/approvals/decide', { email: 'owner@example.test', kind: 'count', id: 's9|close', decision: 'approve' })).status, 400);
  assert.equal((await call(w, '/approvals/decide', { email: 'owner@example.test', kind: 'spend', id: 'e1', decision: 'maybe' })).status, 400);
});
