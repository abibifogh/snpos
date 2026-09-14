import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitEmails, looksLikeEmail, dedupeEmails, houseEmails, houseRecipients,
} from '../../../../functions/notify/src/house.js';

/* ------------------------------------------------- reading a typed-in list */

test('a settings box is read the way somebody would type into one', () => {
  assert.deepEqual(splitEmails('a@x.com, b@x.com'), ['a@x.com', 'b@x.com']);
  assert.deepEqual(splitEmails('a@x.com;b@x.com'), ['a@x.com', 'b@x.com']);
  assert.deepEqual(splitEmails('a@x.com\nb@x.com'), ['a@x.com', 'b@x.com']);
  assert.deepEqual(splitEmails('  a@x.com   b@x.com  '), ['a@x.com', 'b@x.com']);
  // Pasted out of a mail client, name and all.
  assert.deepEqual(splitEmails('Michael <michael@x.com>'), ['michael@x.com']);
});

test('anything that is not an address is dropped, not passed on', () => {
  /*
    One bad entry makes the mail provider refuse the WHOLE message, so a
    single typo in a settings box would silently cost every recipient on it.
  */
  assert.deepEqual(splitEmails('a@x.com, not-an-address, b@x.com'), ['a@x.com', 'b@x.com']);
  assert.deepEqual(splitEmails('nobody'), []);
  assert.deepEqual(splitEmails(''), []);
  assert.deepEqual(splitEmails(undefined), []);
  assert.deepEqual(splitEmails(null), []);
  assert.equal(looksLikeEmail('a@x'), false, 'no dot in the domain');
  assert.equal(looksLikeEmail('a b@x.com'), false);
});

test('the same person twice is one person', () => {
  assert.deepEqual(dedupeEmails(['A@x.com', 'a@x.com', 'b@x.com']), ['A@x.com', 'b@x.com']);
  assert.deepEqual(dedupeEmails(['  a@x.com  ', 'a@x.com']), ['a@x.com']);
});

/* ------------------------------------------------------- who gets told */

test('the configured list and the staff list are added, never substituted', () => {
  // Naming an events address must not quietly stop the owner hearing.
  const { to, usedFallback } = houseEmails({
    configured: 'events@hotel.com',
    profiles: [{ email: 'owner@bistro.com', role: 'admin' }],
    fallback: 'pos@bistro.com',
  });
  assert.deepEqual(to, ['events@hotel.com', 'owner@bistro.com']);
  assert.equal(usedFallback, false);
});

test('a staff profile with no email is the fault that caused all of this', () => {
  /*
    THE REPORT. The person ordering got every confirmation; nobody here got
    anything, for bookings or for change requests. `email` is optional on a
    staff profile and seed-admin.mjs never wrote one, so the owner's profile
    said "admin" and carried no address — and two unrelated code paths came
    out empty in exactly the same way.
  */
  const { to, usedFallback, why } = houseEmails({
    configured: '',
    profiles: [{ display_name: 'Michael', role: 'admin' }],
    fallback: 'pos@bistro.com',
  });
  assert.deepEqual(to, ['pos@bistro.com'], 'the restaurant hears about its own booking');
  assert.equal(usedFallback, true);
  assert.match(why, /no admin or manager has an email address/i);
  assert.match(why, /pos@bistro\.com/);
});

test('a profile switched off is not somebody to email about tonight', () => {
  const { to } = houseEmails({
    profiles: [
      { email: 'gone@bistro.com', active: false },
      { email: 'here@bistro.com', active: true },
      { email: 'old@bistro.com' },
    ],
  });
  // Absent means active, as it does everywhere else.
  assert.deepEqual(to, ['here@bistro.com', 'old@bistro.com']);
});

test('with nowhere at all to send it, that is said rather than shrugged off', () => {
  const { to, why } = houseEmails({ configured: '', profiles: [], fallback: '' });
  assert.deepEqual(to, []);
  assert.match(why, /Nobody here could be told/);
  assert.match(why, /Features, Group ordering/);
});

/* ------------------------------- the repair, against a fake database */

/** Answers like Appwrite's client for the one query this makes. */
const fakeDb = (documents: Record<string, unknown>[], throws = false) => ({
  listDocuments: async () => {
    if (throws) throw new Error('offline');
    return { documents, total: documents.length };
  },
});

const fakeUsers = (byId: Record<string, { email?: string }>) => ({
  get: async (id: string) => {
    const found = byId[id];
    if (!found) throw new Error('no such user');
    return found;
  },
});

const Q = { equal: () => 'eq', limit: () => 'limit' };

test('an address missing from the profile is taken off the sign-in account', async () => {
  /*
    The repair, and the reason nothing has to be edited for this to work.

    A profile with no `email` still knows which Appwrite user it belongs to,
    and that user has an address — signing in is impossible without one. It
    was only ever the copy that was missing.
  */
  const got = await houseRecipients({
    db: fakeDb([{ display_name: 'Michael', role: 'admin', user_id: 'u1' }]),
    users: fakeUsers({ u1: { email: 'michael@bistro.com' } }),
    DB_ID: 'db',
    Query: Q,
    configured: '',
    fallback: 'pos@bistro.com',
  });
  assert.deepEqual(got.to, ['michael@bistro.com']);
  assert.equal(got.usedFallback, false, 'a real person, not the stopgap');
});

test('the account is only asked about when the profile has nothing usable', async () => {
  let asked = 0;
  const users = {
    get: async (id: string) => { asked += 1; return { email: `${id}@account.com` }; },
  };
  const got = await houseRecipients({
    db: fakeDb([
      { role: 'admin', user_id: 'u1', email: 'onprofile@bistro.com' },
      { role: 'manager', user_id: 'u2' },
    ]),
    users,
    DB_ID: 'db',
    Query: Q,
  });
  assert.equal(asked, 1, 'only the one with no address');
  assert.deepEqual(got.to, ['onprofile@bistro.com', 'u2@account.com']);
});

test('an invited profile with no account yet is not an error', async () => {
  // Somebody who has not accepted. Nothing to look up, and nothing broken.
  const got = await houseRecipients({
    db: fakeDb([{ role: 'manager', display_name: 'Not yet' }]),
    users: fakeUsers({}),
    DB_ID: 'db',
    Query: Q,
    fallback: 'pos@bistro.com',
  });
  assert.deepEqual(got.to, ['pos@bistro.com']);
});

test('an account that cannot be read falls through instead of throwing', async () => {
  const said: string[] = [];
  const got = await houseRecipients({
    db: fakeDb([{ role: 'admin', user_id: 'missing', display_name: 'Michael' }]),
    users: fakeUsers({}),
    DB_ID: 'db',
    Query: Q,
    fallback: 'pos@bistro.com',
    log: (m: string) => said.push(m),
  });
  assert.deepEqual(got.to, ['pos@bistro.com']);
  assert.ok(said.some((m) => /Could not read the account/.test(m)));
});

test('a staff list that cannot be read is said out loud, not swallowed', async () => {
  /*
    A failing lookup and an empty one produced the same silence, and they have
    completely different fixes.
  */
  const said: string[] = [];
  const got = await houseRecipients({
    db: fakeDb([], true),
    users: fakeUsers({}),
    DB_ID: 'db',
    Query: Q,
    configured: 'events@hotel.com',
    log: (m: string) => said.push(m),
  });
  assert.deepEqual(got.to, ['events@hotel.com'], 'what was configured still goes out');
  assert.ok(said.some((m) => /Could not read the staff list/.test(m)));
});

test('no users service at all still works', async () => {
  // The SSO half of the function owns that client; this must not depend on it.
  const got = await houseRecipients({
    db: fakeDb([{ role: 'admin', user_id: 'u1', email: 'a@bistro.com' }]),
    users: undefined,
    DB_ID: 'db',
    Query: Q,
  });
  assert.deepEqual(got.to, ['a@bistro.com']);
});
