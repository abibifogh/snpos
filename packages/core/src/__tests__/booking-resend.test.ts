import test from 'node:test';
import assert from 'node:assert/strict';
import { sendToEach, houseRecipients } from '../../../../functions/notify/src/house.js';

/*
  THE REPORT, AND WHY THE LAST DIAGNOSIS WAS WRONG.

  A group booked. The guest got their confirmation; no admin or manager got
  theirs. Later the same party asked for a change and THAT message reached
  everybody, managers included — from the same staff list, built by the same
  three lines of code.

  So "no admin has an email on their profile" cannot have been the whole
  story: the addresses were there by the time of the change request. What was
  wrong is that the notice was sent as ONE message addressed to everybody, and
  one message to a list is all-or-nothing at the provider: a single address it
  dislikes loses it for every other person on the line, and the log records one
  failure rather than "three people were not told".
*/

const fails = (bad: string[]) => async (address: string) => {
  if (bad.includes(address)) throw new Error('550 mailbox unavailable');
  return { messageId: `ok-${address}` };
};

test('one bad address no longer costs everybody else the message', () => {
  // The whole point. Before this, the send was to a joined list and the
  // provider refused the lot.
  return sendToEach({
    to: ['owner@bistro.com', 'gone@old-domain.example', 'manager@bistro.com'],
    send: fails(['gone@old-domain.example']),
  }).then(({ sent, failed, why }) => {
    assert.deepEqual(sent, ['owner@bistro.com', 'manager@bistro.com']);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].address, 'gone@old-domain.example');
    assert.match(why, /Sent to 2 of 3/);
    assert.match(why, /gone@old-domain\.example/, 'and names who did not get it');
  });
});

test('everybody getting it says so plainly', async () => {
  const { sent, failed, why } = await sendToEach({
    to: ['a@bistro.com', 'b@bistro.com'],
    send: fails([]),
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(failed, []);
  assert.match(why, /Sent to 2 addresses/);
});

test('nobody to send to is not a failure to send', async () => {
  const { sent, failed, why } = await sendToEach({ to: [], send: fails([]) });
  assert.deepEqual(sent, []);
  assert.deepEqual(failed, []);
  assert.match(why, /Sent to 0/);
});

test('every address is tried, even after one refuses', async () => {
  /*
    A loop that stopped at the first error would turn one dead mailbox into
    everybody after it in the list going untold — the same fault in a smaller
    coat.
  */
  const tried: string[] = [];
  await sendToEach({
    to: ['one@x.com', 'two@x.com', 'three@x.com'],
    send: async (a) => { tried.push(a); if (a === 'one@x.com') throw new Error('nope'); },
  });
  assert.deepEqual(tried, ['one@x.com', 'two@x.com', 'three@x.com']);
});

test('what went wrong is reported per person, not as one word', async () => {
  const said: string[] = [];
  const { why } = await sendToEach({
    to: ['a@x.com', 'b@x.com'],
    send: fails(['a@x.com', 'b@x.com']),
    log: (m: string) => said.push(m),
  });
  assert.equal(said.length, 2, 'one line each, so a log says who');
  assert.match(why, /Sent to 0 of 2/);
  assert.match(why, /550 mailbox unavailable/);
});

/* ------------------------------------- the list itself, once more with feeling */

const fakeDb = (documents: Record<string, unknown>[]) => ({
  listDocuments: async () => ({ documents, total: documents.length }),
});
const Q = { equal: () => 'eq', limit: () => 'limit' };

test('the same staff list serves a booking and a change request', async () => {
  /*
    They were built by two separate copies of the same three lines. Identical
    today, and the kind of thing that drifts the moment one is edited — which
    is exactly how a report reading "one email worked and the other did not"
    becomes impossible to explain.
  */
  const db = fakeDb([
    { $id: 'p1', role: 'admin', email: 'owner@bistro.com', active: true },
    { $id: 'p2', role: 'manager', email: 'manager@bistro.com', active: true },
  ]);
  const got = await houseRecipients({ db, users: undefined, DB_ID: 'db', Query: Q });
  assert.deepEqual(got.to, ['owner@bistro.com', 'manager@bistro.com']);
  assert.equal(got.usedFallback, false);
});

test('an address added after a booking is used when it is sent again', async () => {
  /*
    The sequence in the report. At the booking there was nobody to tell; by
    the time of the change request somebody had put an address on a profile,
    and it worked. Resending reads the list as it is NOW, which is what makes
    a second chance worth having.
  */
  const before = await houseRecipients({
    db: fakeDb([{ $id: 'p1', role: 'admin', display_name: 'Michael' }]),
    users: undefined,
    DB_ID: 'db',
    Query: Q,
    fallback: 'pos@bistro.com',
  });
  assert.deepEqual(before.to, ['pos@bistro.com'], 'the stopgap, at the time');

  const after = await houseRecipients({
    db: fakeDb([{ $id: 'p1', role: 'admin', email: 'michael@bistro.com' }]),
    users: undefined,
    DB_ID: 'db',
    Query: Q,
    fallback: 'pos@bistro.com',
  });
  assert.deepEqual(after.to, ['michael@bistro.com'], 'the real person, on the resend');
});
