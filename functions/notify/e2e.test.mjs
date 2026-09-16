/**
 * The notify job itself, driven the way Appwrite drives it.
 *
 * Every other test in this repo is of a pure rule, which is the right shape
 * for a rule and no use at all for "did the email actually reach anybody".
 * Twice now a group booking has gone in and nobody here has been told, and
 * both times the rules were fine and the wiring was not — so this loads
 * src/main.js EXACTLY as it ships and only fakes the two things it talks to:
 * the database and the mail server.
 *
 * What it can see that nothing else could: who ended up in the `to` line of a
 * real message, what happens to the people listed after an address that
 * bounces, and whether a resend request is cleared once it has been acted on.
 *
 * Needs --experimental-test-module-mocks; see the test:notify script.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const outbox = [];
let bookings = {};
let staff = [];
let notices = [];
const updates = [];

mock.module('nodemailer', {
  namedExports: {},
  defaultExport: {
    createTransport: () => ({
      sendMail: async (msg) => {
        if (String(msg.to).includes('gone@')) throw new Error('550 mailbox unavailable');
        outbox.push(msg);
        return { messageId: `m${outbox.length}` };
      },
    }),
  },
});

class FakeDatabases {
  async getDocument(_db, table, id) {
    if (table === 'settings') return { restaurant_name: 'SN Bistro', email_from_address: 'pos@bistro.com', currency_code: 'GHS', currency_decimals: 2, primary_color: '#0f766e' };
    if (table === 'group_bookings') return bookings[id];
    if (table === 'venues') return { name: 'SN Bistro' };
    throw new Error('no such document');
  }
  async listDocuments(_db, table) {
    if (table === 'staff_profiles') return { documents: staff, total: staff.length };
    if (table === 'order_notices') return { documents: notices, total: notices.length };
    if (table === 'feature_flags') return { documents: [{ key: 'group_orders', enabled: true, config: '{}' }], total: 1 };
    if (table === 'orders') return { documents: [], total: 0 };
    return { documents: [], total: 0 };
  }
  async createDocument(_db, table, _id, data) {
    if (table === 'order_notices') {
      const row = { $id: `n${notices.length}`, ...data };
      notices.push(row);
      return row;
    }
    return { $id: `x${Math.random()}`, ...data };
  }
  async updateDocument(_db, table, id, data) {
    updates.push({ table, id, data });
    if (table === 'group_bookings') bookings[id] = { ...bookings[id], ...data };
    if (table === 'order_notices') {
      const i = notices.findIndex((n) => n.$id === id);
      if (i >= 0) notices[i] = { ...notices[i], ...data };
    }
    return bookings[id] ?? { $id: id, ...data };
  }
}

mock.module('node-appwrite', {
  namedExports: {
    Client: class { setEndpoint() { return this; } setProject() { return this; } setKey() { return this; } },
    Databases: FakeDatabases,
    Users: class { async get() { throw new Error('no account'); } },
    Query: { equal: () => 'eq', limit: () => 'lim', greaterThanEqual: () => 'gte', lessThanEqual: () => 'lte', orderDesc: () => 'od' },
    ID: { unique: () => 'id' },
    Teams: class { async list() { return { teams: [] }; } async createMembership() { return {}; } },
    Permission: { read: () => 'r', update: () => 'u' },
    Role: { user: () => 'user', team: () => 'team' },
  },
});

process.env.SMTP_HOST = 'smtp.test';
process.env.SMTP_USER = 'u';
process.env.SMTP_PASS = 'p';
process.env.DB_ID = 'snpos';

const { default: handler } = await import('/home/user/snpos/functions/notify/src/main.js');

const run = async (doc, event) => {
  const res = { json: (b) => b };
  return handler({
    req: { bodyJson: doc, body: '', headers: { 'x-appwrite-event': event, 'x-appwrite-trigger': 'event' } },
    res,
    log: () => {},
    error: () => {},
  });
};

const BOOKING = {
  $id: 'bk1', venue_id: 'v1', contact_name: 'Ama Mensah', email: 'ama@example.com',
  reference: 'REG-1', size: 12, sittings: 2, portions: 24, total: 48_000,
  currency_code: 'GHS', order_nos: 'A-1, A-2',
  first_at: '2026-10-02T11:00:00.000Z', last_at: '2026-10-03T18:00:00.000Z',
  status: 'pending',
};

const reset = (profiles) => {
  outbox.length = 0; notices.length = 0; updates.length = 0;
  staff = profiles;
  bookings = { bk1: { ...BOOKING } };
};

test('a booking tells the house and the guest', async () => {
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true }]);
  await run({ ...BOOKING }, 'databases.snpos.collections.group_bookings.documents.bk1.create');
  const to = outbox.map((m) => m.to);
  assert.ok(to.includes('owner@bistro.com'), `house told, got ${JSON.stringify(to)}`);
  assert.ok(to.includes('ama@example.com'), 'guest told');
});

test('one dead address does not cost the others', async () => {
  reset([
    { $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true },
    { $id: 'p2', role: 'manager', email: 'gone@old.example', active: true },
    { $id: 'p3', role: 'manager', email: 'chef@bistro.com', active: true },
  ]);
  await run({ ...BOOKING }, 'databases.snpos.collections.group_bookings.documents.bk1.create');
  const to = outbox.map((m) => m.to);
  assert.ok(to.includes('owner@bistro.com'), 'first still told');
  assert.ok(to.includes('chef@bistro.com'), 'and the one AFTER the dead address');
  assert.ok(!to.includes('gone@old.example'));
  assert.ok(to.includes('ama@example.com'), 'guest unaffected');
  const failed = notices.find((n) => n.status === 'failed');
  assert.ok(failed, 'and it is recorded as failed, not silently sent');
});

test('asking again sends again, and clears the request', async () => {
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true }]);
  const asked = { ...BOOKING, notice_resend_at: '2026-09-16T10:00:00.000Z' };
  bookings.bk1 = asked;
  await run(asked, 'databases.snpos.collections.group_bookings.documents.bk1.update');

  const to = outbox.map((m) => m.to);
  assert.deepEqual(to, ['owner@bistro.com'], 'the house, and not the guest again');
  assert.match(String(outbox[0].subject), /sent again/i);

  const cleared = updates.find((u) => u.table === 'group_bookings' && u.data.notice_resend_at === null);
  assert.ok(cleared, 'the request is cleared so it cannot fire for ever');
});

test('a resend with a new address reaches the person added since', async () => {
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true },
          { $id: 'p9', role: 'manager', email: 'newmanager@bistro.com', active: true }]);
  const asked = { ...BOOKING, notice_resend_at: '2026-09-16T10:00:00.000Z' };
  bookings.bk1 = asked;
  await run(asked, 'databases.snpos.collections.group_bookings.documents.bk1.update');
  const to = outbox.map((m) => m.to);
  assert.ok(to.includes('newmanager@bistro.com'), 'the list is read as it is now');
});

test('a change request reaches the same people', async () => {
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true },
          { $id: 'p2', role: 'manager', email: 'chef@bistro.com', active: true }]);
  await run({ $id: 'c1', venue_id: 'v1', booking_id: 'bk1', contact_name: 'Ama', kind: 'timing', note: 'an hour later' },
    'databases.snpos.collections.booking_changes.documents.c1.create');
  const to = outbox.flatMap((m) => String(m.to).split(','));
  assert.ok(to.includes('owner@bistro.com'));
  assert.ok(to.includes('chef@bistro.com'));
});
