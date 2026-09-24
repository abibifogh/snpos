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
let vouchers = {};
const updates = [];
// The push half: held count rows, devices, this server's key, and what the
// fake push services were asked to deliver.
let checks = [];
let shopCounts = [];
let devices = [];
let pushKeys = null;
const deleted = [];
const pushed = [];

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
    if (table === 'settings') return { restaurant_name: 'SN Bistro', email_from_address: 'pos@bistro.com', currency_code: 'GHS', currency_symbol: 'GH₵', currency_decimals: 2, primary_color: '#0f766e' };
    if (table === 'group_bookings') return bookings[id];
    if (table === 'discounts') return vouchers[id];
    if (table === 'venues') return { name: 'SN Bistro' };
    if (table === 'push_keys' && pushKeys) return pushKeys;
    throw new Error('no such document');
  }
  async listDocuments(_db, table) {
    if (table === 'staff_profiles') return { documents: staff, total: staff.length };
    if (table === 'order_notices') return { documents: notices, total: notices.length };
    if (table === 'feature_flags') return { documents: [{ key: 'group_orders', enabled: true, config: '{}' }], total: 1 };
    if (table === 'orders') return { documents: [], total: 0 };
    if (table === 'shift_stock_checks') return { documents: checks, total: checks.length };
    if (table === 'stock_counts') return { documents: shopCounts, total: shopCounts.length };
    if (table === 'push_subscriptions') return { documents: devices, total: devices.length };
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
  async deleteDocument(_db, table, id) {
    deleted.push({ table, id });
    if (table === 'push_subscriptions') devices = devices.filter((d) => d.$id !== id);
  }
}

mock.module('node-appwrite', {
  namedExports: {
    Client: class { setEndpoint() { return this; } setProject() { return this; } setKey() { return this; } },
    Databases: FakeDatabases,
    Users: class { async get() { throw new Error('no account'); } },
    Query: {
      equal: () => 'eq', limit: () => 'lim', greaterThanEqual: () => 'gte', lessThanEqual: () => 'lte',
      orderDesc: () => 'od', isNull: () => 'null', lessThan: () => 'lt', offset: () => 'off',
    },
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

/*
  Relative to THIS FILE, never to where the test was started from, and never
  to an absolute path off one machine — a checkout lives somewhere different
  on every machine that has one, so an absolute path here passes for the
  person who wrote it and fails for everybody else, which is the opposite of
  what a test is for.

  It must also come after the two mock.module calls above: the mocks have to
  be registered before the module that imports them is loaded, which is why
  this is a dynamic import at the foot of the setup rather than an import at
  the top.
*/
const { default: handler } = await import('./src/main.js');

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
  vouchers = { d1: { ...VOUCHER } };
};

const VOUCHER = {
  $id: 'd1', name: 'Friends & Family', code: 'fandf30', kind: 'percent', value: 3000,
  min_order_total: 5_000, ends_at: '2026-12-31', active: true, used_count: 0,
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
  assert.ok(to.includes('owner@bistro.com'), 'the house');
  assert.match(String(outbox.find((m) => m.to === 'owner@bistro.com').subject), /sent again/i);

  const cleared = updates.find((u) => u.table === 'group_bookings' && u.data.notice_resend_at === null);
  assert.ok(cleared, 'the request is cleared so it cannot fire for ever');
});

test('a booking sent again reaches the party too, worded as an update', async () => {
  /*
    A resend is usually a revision: something on the booking changed and the
    guest is holding a sheet that is now wrong. Sending them the current one
    is the whole point of "the revised orders, by email, like the first".
  */
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true }]);
  const asked = { ...BOOKING, notice_resend_at: '2026-09-16T10:00:00.000Z' };
  bookings.bk1 = asked;
  await run(asked, 'databases.snpos.collections.group_bookings.documents.bk1.update');

  const guest = outbox.find((m) => m.to === 'ama@example.com');
  assert.ok(guest, 'the party is told');
  assert.match(String(guest.subject), /updated/i, 'and it does not read as a new booking');
  // Its own message, so the guest never sees who else was told.
  assert.equal(String(guest.to), 'ama@example.com');
});

test('a booking sent again still goes out when the party has no email', async () => {
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true }]);
  const asked = { ...BOOKING, email: '', notice_resend_at: '2026-09-16T10:00:00.000Z' };
  bookings.bk1 = asked;
  await run(asked, 'databases.snpos.collections.group_bookings.documents.bk1.update');
  assert.deepEqual(outbox.map((m) => m.to), ['owner@bistro.com']);
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

/* ---------------------------------- sending a revision, and hearing back */

test('a revision goes to the party, and only to the party', async () => {
  /*
    The house is not copied. They already know — somebody here made the change
    and pressed the button — and the guest must never be shown who else is on
    a message about their own booking.
  */
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true }]);
  bookings.bk1.approval_send_at = '2026-09-16T10:00:00.000Z';
  bookings.bk1.approval_note = 'Thursday lunch is now Thursday dinner.';

  await run({ ...bookings.bk1 }, 'databases.snpos.collections.group_bookings.documents.bk1.update');

  const to = outbox.map((m) => m.to);
  assert.deepEqual(to, ['ama@example.com'], `only the party, got ${JSON.stringify(to)}`);
  assert.match(outbox[0].subject, /check your group booking/i);
  assert.match(outbox[0].html, /Thursday lunch is now Thursday dinner/, 'it says what changed');
});

test('the request is cleared, so it does not fire on every later save', async () => {
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true }]);
  bookings.bk1.approval_send_at = '2026-09-16T10:00:00.000Z';
  await run({ ...bookings.bk1 }, 'databases.snpos.collections.group_bookings.documents.bk1.update');

  const cleared = updates.find((u) => u.table === 'group_bookings' && u.data.approval_send_at === null);
  assert.ok(cleared, 'the asking is cleared');
  // And the stamp that means "the party is waiting" is written, because it went.
  const stamped = updates.find((u) => u.table === 'group_bookings' && u.data.approval_requested_at);
  assert.ok(stamped, 'stamped as actually sent');
});

test('a revision that could not be sent is not recorded as waiting on the party', async () => {
  /*
    The whole reason the job stamps this rather than the page. A row reading
    "waiting on the party" about an email that never left sends somebody to
    chase a guest who was never written to.
  */
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true }]);
  bookings.bk1.email = 'gone@old.example';
  bookings.bk1.approval_send_at = '2026-09-16T10:00:00.000Z';

  await run({ ...bookings.bk1 }, 'databases.snpos.collections.group_bookings.documents.bk1.update');

  assert.equal(
    updates.some((u) => u.table === 'group_bookings' && u.data.approval_requested_at),
    false,
    'never stamped as sent',
  );
  const failed = notices.find((n) => n.status === 'failed');
  assert.ok(failed, 'and it is recorded as a failure');
});

test('the party agreeing stamps the booking and tells the house', async () => {
  reset([
    { $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true },
    { $id: 'p2', role: 'manager', email: 'chef@bistro.com', active: true },
  ]);

  await run(
    {
      $id: 'ch1', venue_id: 'v1', booking_id: 'bk1', kind: 'approved',
      contact_name: 'Ama Mensah', reference: 'REG-1', email: 'ama@example.com',
      note: 'All correct, thank you.', status: 'open',
    },
    'databases.snpos.collections.booking_changes.documents.ch1.create',
  );

  // The stamp, which is the only thing a browser can read to know it happened.
  const stamped = updates.find((u) => u.table === 'group_bookings' && u.data.approval_given_at);
  assert.ok(stamped, 'the booking is stamped as agreed');

  const to = outbox.map((m) => m.to);
  assert.ok(to.includes('owner@bistro.com'), `admin told, got ${JSON.stringify(to)}`);
  assert.ok(to.includes('chef@bistro.com'), 'manager told');
  // Never the guest: they pressed the button, they know.
  assert.equal(to.includes('ama@example.com'), false, 'the party is not told what they just did');
  assert.match(outbox[0].subject, /agreed/i);
  assert.match(outbox[0].html, /All correct, thank you/, 'and what they said comes with it');
});

test('an approval is settled rather than left waiting on somebody', async () => {
  // Left open it sits on the Waiting for you page as a job to do, and the job
  // is done: the party agreed, and there is nothing here to decide.
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true }]);
  await run(
    { $id: 'ch1', venue_id: 'v1', booking_id: 'bk1', kind: 'approved', note: 'Fine.', status: 'open' },
    'databases.snpos.collections.booking_changes.documents.ch1.create',
  );
  const closed = updates.find((u) => u.table === 'booking_changes' && u.data.status === 'done');
  assert.ok(closed, 'marked done');
});

test('an ordinary change request is still a change request', async () => {
  /*
    The approval branch runs first and must not swallow the thing it sits in
    front of: a party asking for eight more covers is not an approval, and
    stamping the booking for one would report agreement nobody gave.
  */
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true }]);
  await run(
    {
      $id: 'ch2', venue_id: 'v1', booking_id: 'bk1', kind: 'numbers',
      note: 'Eight more for Tuesday.', status: 'open',
    },
    'databases.snpos.collections.booking_changes.documents.ch2.create',
  );
  assert.equal(
    updates.some((u) => u.table === 'group_bookings' && u.data.approval_given_at),
    false,
    'no agreement was stamped',
  );
  assert.match(outbox[0].subject, /change asked for/i);
});

/* ------------------------------------------- a voucher on its way to somebody */

test('a voucher reaches the one address its row names, with the slip attached', async () => {
  reset([{ $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true }]);

  const out = await run(
    {
      $id: 's1', venue_id: 'v1', discount_id: 'd1', to_email: 'ama@example.com',
      to_name: 'Ama', voucher_name: 'Friends & Family', status: 'queued',
    },
    'databases.snpos.collections.voucher_sends.documents.s1.create',
  );

  const to = outbox.map((m) => m.to);
  assert.deepEqual(to, ['ama@example.com'], `only the customer, got ${JSON.stringify(to)}`);
  assert.equal(out.sent, true);
  // The house is not copied on a customer's voucher, and one address never
  // sees another: that is the whole reason a row carries one address.
  assert.equal(to.includes('owner@bistro.com'), false);

  const mail = outbox[0];
  assert.match(mail.subject, /30% OFF/);
  assert.match(mail.html, /FANDF30/, 'the code is in the body as well as the slip');
  assert.equal(mail.attachments.length, 1);
  assert.match(mail.attachments[0].filename, /\.pdf$/);
  assert.ok(mail.attachments[0].content.length > 500, 'and the slip has something in it');
});

test('a sent voucher is stamped sent, so a screen can say which ones arrived', async () => {
  reset([]);
  await run(
    { $id: 's1', venue_id: 'v1', discount_id: 'd1', to_email: 'ama@example.com', status: 'queued' },
    'databases.snpos.collections.voucher_sends.documents.s1.create',
  );
  const done = updates.find((u) => u.table === 'voucher_sends' && u.data.status === 'sent');
  assert.ok(done, 'stamped sent');
  assert.ok(done.data.sent_at, 'and when');
});

test('a refused address is recorded as failed rather than looking sent', async () => {
  /*
    The row IS the record. A send that quietly did nothing leaves a screen
    saying a customer has their voucher when nobody wrote to them.
  */
  reset([]);
  const out = await run(
    { $id: 's1', venue_id: 'v1', discount_id: 'd1', to_email: 'gone@old.example', status: 'queued' },
    'databases.snpos.collections.voucher_sends.documents.s1.create',
  );
  assert.equal(out.sent, false);
  const failed = updates.find((u) => u.table === 'voucher_sends' && u.data.status === 'failed');
  assert.ok(failed, 'marked failed');
  assert.match(String(failed.data.last_error), /550|mailbox/i, 'and says why');
});

test('a voucher that has ended is not sent, however it was asked for', async () => {
  /*
    Checked again here, not only on the page. A voucher can end between
    somebody pressing send and this row being reached — and one that would be
    refused at the till is worse than none: the customer finds out at the
    counter and somebody here has to explain it.
  */
  reset([]);
  vouchers.d1 = { ...VOUCHER, ends_at: '2020-01-01' };
  const out = await run(
    { $id: 's1', venue_id: 'v1', discount_id: 'd1', to_email: 'ama@example.com', status: 'queued' },
    'databases.snpos.collections.voucher_sends.documents.s1.create',
  );
  assert.equal(out.sent, false);
  assert.equal(outbox.length, 0, 'nothing left the building');
  const failed = updates.find((u) => u.table === 'voucher_sends' && u.data.status === 'failed');
  assert.match(String(failed.data.last_error), /already ended/i);
});

test('a voucher that has been deleted since fails rather than throwing', async () => {
  reset([]);
  vouchers = {};
  const out = await run(
    { $id: 's1', venue_id: 'v1', discount_id: 'gone', to_email: 'ama@example.com', status: 'queued' },
    'databases.snpos.collections.voucher_sends.documents.s1.create',
  );
  assert.equal(out.sent, false);
  assert.match(String(out.why), /no longer exists/i);
});

/* ----------------------------------------- a stock count left waiting a day */

import { createECDH, createDecipheriv, hkdfSync } from 'node:crypto';
const { makeKeys, b64u } = await import('./src/webpush.js');

/**
 * A browser, as far as a push service is concerned: its key pair, and a way
 * to read what it was sent. Written from RFC 8291 so the test reads the
 * message the way the phone would, not the way the sender meant it.
 */
function device(id, userId, endpoint = `https://fcm.googleapis.com/fcm/send/${id}`) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.alloc(16, id.length);
  const row = { $id: id, user_id: userId, endpoint, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) };
  const read = (body) => {
    const salt = body.subarray(0, 16);
    const asPublic = body.subarray(21, 86);
    const rec = body.subarray(86);
    const shared = ecdh.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(rec.subarray(rec.length - 16));
    const out = Buffer.concat([d.update(rec.subarray(0, rec.length - 16)), d.final()]);
    return JSON.parse(out.subarray(0, out.length - 1).toString());
  };
  return { row, read };
}

/** Push services, faked at the network: 410 for an endpoint ending "dead". */
globalThis.fetch = async (url, init) => {
  pushed.push({ url, init });
  return new Response('', { status: String(url).endsWith('dead') ? 410 : 201 });
};

const tick = () => handler({
  req: { bodyJson: null, body: '', headers: { 'x-appwrite-trigger': 'schedule' } },
  res: { json: (b) => b },
  log: () => {},
  error: () => {},
});

const dayAndAHalfAgo = () => new Date(Date.now() - 36 * 3_600_000).toISOString();

const OWNER = { $id: 'p-owner', user_id: 'u-owner', role: 'admin', active: true, email: 'owner@bistro.com', display_name: 'Owner' };
const MANAGER = { $id: 'p-mgr', user_id: 'u-mgr', role: 'manager', active: true, email: 'mgr@bistro.com', display_name: 'Kofi' };
const BARTENDER = { $id: 'p-bar', user_id: 'u-bar', role: 'cashier', active: true, email: '', display_name: 'Ama' };

const heldCola = () => ({
  $id: 'chk-cola', shift_id: 'sh-day1', phase: 'close', applied: false, variance_qty: -2, variance_value: 2_000,
  ingredient_id: 'cola', checked_by: 'p-bar', $createdAt: dayAndAHalfAgo(), alerted_at: dayAndAHalfAgo(),
});

const resetCounts = () => {
  reset([OWNER, MANAGER, BARTENDER]);
  checks = [heldCola()];
  shopCounts = [];
  devices = [];
  pushKeys = { public_key: '', private_key: '' };
  const k = makeKeys();
  pushKeys = { public_key: k.publicKey, private_key: k.privateKey };
  deleted.length = 0;
  pushed.length = 0;
  process.env.SMTP_HOST = 'smtp.test';
};

const overdueMail = () => outbox.filter((m) => /over a day/.test(m.subject));
const stampedOverdue = () => updates.filter((u) => u.table === 'shift_stock_checks' && u.data.overdue_alerted_at);

test('a count held over a day is emailed to the admins, not the managers', async () => {
  resetCounts();
  await tick();
  const mail = overdueMail();
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, 'owner@bistro.com');
  assert.match(mail[0].html, /Why a day matters/);
});

test('and it reaches the admin\'s phone, readable, and nobody else\'s', async () => {
  resetCounts();
  const phone = device('owner-phone', 'u-owner');
  const other = device('mgr-phone', 'u-mgr');
  devices = [phone.row, other.row];
  await tick();

  const toOwner = pushed.filter((p) => p.url === phone.row.endpoint);
  assert.equal(toOwner.length, 1, 'the admin\'s phone was sent it');
  assert.equal(pushed.filter((p) => p.url === other.row.endpoint).length, 0, 'the manager\'s was not');

  // What the phone would actually show, decrypted as the phone decrypts it.
  const shown = phone.read(toOwner[0].init.body);
  assert.match(shown.title, /Bar count, counting out waiting 1 day/);
  assert.match(shown.body, /GH₵20\.00 in differences/);
  assert.equal(shown.url, '#/waiting?show=count');
  assert.match(toOwner[0].init.headers.Authorization, /^vapid t=.+, k=/);
});

test('once told, the count is stamped so it is not said again', async () => {
  resetCounts();
  await tick();
  assert.deepEqual(stampedOverdue().map((u) => u.id), ['chk-cola']);

  // The next hour: the row now carries the stamp, and nothing more is sent.
  checks = [{ ...heldCola(), overdue_alerted_at: new Date().toISOString() }];
  outbox.length = 0; pushed.length = 0;
  await tick();
  assert.equal(overdueMail().length, 0);
  assert.equal(pushed.length, 0);
});

test('a count waiting less than a day is left for later', async () => {
  resetCounts();
  checks = [{ ...heldCola(), $createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }];
  devices = [device('owner-phone', 'u-owner').row];
  await tick();
  assert.equal(overdueMail().length, 0);
  assert.equal(pushed.length, 0);
});

test('a phone that has gone is removed, and the email still counts as telling somebody', async () => {
  resetCounts();
  devices = [device('dead', 'u-owner', 'https://fcm.googleapis.com/fcm/send/dead').row];
  await tick();
  assert.deepEqual(deleted, [{ table: 'push_subscriptions', id: 'dead' }]);
  assert.equal(overdueMail().length, 1);
  assert.equal(stampedOverdue().length, 1);
});

test('with no email set up, the phone alone is enough', async () => {
  // Two independent channels: one missing must not silence the other.
  resetCounts();
  delete process.env.SMTP_HOST;
  const phone = device('owner-phone', 'u-owner');
  devices = [phone.row];
  await tick();
  assert.equal(overdueMail().length, 0);
  assert.equal(pushed.filter((p) => p.url === phone.row.endpoint).length, 1);
  assert.equal(stampedOverdue().length, 1, 'told, so stamped');
  process.env.SMTP_HOST = 'smtp.test';
});

test('when nobody could be told, nothing is stamped and the next hour tries again', async () => {
  /*
    The alternative is a count marked as escalated to nobody, which is exactly
    the silence this exists to break.
  */
  resetCounts();
  delete process.env.SMTP_HOST;
  devices = [];
  await tick();
  assert.equal(stampedOverdue().length, 0);
  process.env.SMTP_HOST = 'smtp.test';
});

test('with no push key yet, email still goes and the gap is not papered over', async () => {
  resetCounts();
  pushKeys = null;
  devices = [device('owner-phone', 'u-owner').row];
  await tick();
  assert.equal(pushed.length, 0, 'nothing signed with a key made up on the spot');
  assert.equal(overdueMail().length, 1);
});

/* ----------------------------------------- a device turning notifications on */

test('turning a device on is answered by a notification on that device', async () => {
  resetCounts();
  const phone = device('new-phone', 'u-owner');
  const out = await run(
    { ...phone.row, test_requested_at: new Date().toISOString() },
    'databases.snpos.collections.push_subscriptions.documents.new-phone.create',
  );
  assert.equal(out.outcome, 'sent');
  assert.equal(pushed.length, 1);
  assert.equal(phone.read(pushed[0].init.body).title, 'Notifications are on');
  // The request is cleared, so the function's own write-back does not send again.
  const cleared = updates.find((u) => u.table === 'push_subscriptions' && u.id === 'new-phone');
  assert.equal(cleared?.data.test_requested_at, null);
});

test('an update with no test asked for sends nothing', async () => {
  resetCounts();
  const phone = device('p', 'u-owner');
  const out = await run(phone.row, 'databases.snpos.collections.push_subscriptions.documents.p.update');
  assert.deepEqual(out, { nothing: true });
  assert.equal(pushed.length, 0);
});

test('turning a device on before the server has a key says so on the device\'s row', async () => {
  resetCounts();
  pushKeys = null;
  const phone = device('p', 'u-owner');
  await run(
    { ...phone.row, test_requested_at: new Date().toISOString() },
    'databases.snpos.collections.push_subscriptions.documents.p.create',
  );
  const row = updates.find((u) => u.table === 'push_subscriptions' && u.id === 'p');
  assert.match(row?.data.last_error ?? '', /Run Provision Appwrite/);
});
