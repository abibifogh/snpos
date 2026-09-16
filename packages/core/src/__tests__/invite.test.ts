import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inviteState, inviteWords, stuckInvites, meanwhile, STUCK_AFTER_MS,
  hasSignIn, invitationWanted,
  type InviteProfile,
} from '../invite.ts';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const agoMs = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const profile = (over: Partial<InviteProfile> = {}): InviteProfile => ({ email: 'ama@x.com', ...over });

test('a link nobody asked for is not a link that failed', () => {
  assert.equal(inviteState(profile(), NOW), 'not_asked');
  // No email means no link is possible, and that is not a fault either. Most
  // staff sign in with a PIN and never have one.
  assert.equal(inviteState(profile({ email: '' }), NOW), 'no_email');
  assert.equal(inviteState(profile({ email: '   ' }), NOW), 'no_email');
});

test('just asked for is waiting, not broken', () => {
  // The job answers off the database event, in seconds. Calling it a failure
  // the instant somebody presses the button would cry wolf on every invite.
  assert.equal(inviteState(profile({ login_link_requested_at: agoMs(5_000) }), NOW), 'waiting');
  assert.equal(inviteWords(inviteState(profile({ login_link_requested_at: agoMs(5_000) }), NOW)).tone, 'warn');
});

test('asked for long enough ago and still not sent is stuck', () => {
  /**
   * The whole point. The browser cannot send this email — it writes a field
   * and a server job does the rest — so "saved" never meant "sent". Where the
   * job was not deployed or the mail settings were never filled in, nothing
   * happened and the screen said it had.
   */
  const p = profile({ login_link_requested_at: agoMs(STUCK_AFTER_MS + 1_000) });
  assert.equal(inviteState(p, NOW), 'stuck');
  const words = inviteWords('stuck');
  assert.equal(words.tone, 'danger');
  assert.match(words.detail ?? '', /Nothing has reached them/);
});

test('sent is the only state that means an email exists', () => {
  const p = profile({
    login_link_requested_at: agoMs(60_000),
    login_link_sent_at: agoMs(50_000),
  });
  assert.equal(inviteState(p, NOW), 'sent');
  assert.equal(inviteWords('sent').tone, 'ok');
});

test('asking again after an old link is a fresh unanswered request', () => {
  /**
   * "Send it again" writes the same two fields, so a person sent a link in
   * March and asked for a new one today has both stamps. Only their order says
   * whether today's has gone — checking merely that a send stamp EXISTS would
   * report the new request as already delivered.
   */
  const asked = profile({
    login_link_sent_at: '2026-03-01T09:00:00.000Z',
    login_link_requested_at: agoMs(10_000),
  });
  assert.equal(inviteState(asked, NOW), 'waiting');

  const abandoned = { ...asked, login_link_requested_at: agoMs(STUCK_AFTER_MS + 1) };
  assert.equal(inviteState(abandoned, NOW), 'stuck');
});

test('a malformed timestamp does not read as a successful send', () => {
  // Failing towards "we do not know" would be one thing; failing towards
  // "it went" is the failure this file exists to stop.
  const p = profile({ login_link_requested_at: 'not a date' });
  assert.equal(inviteState(p, NOW), 'not_asked');
  const half = profile({ login_link_requested_at: agoMs(10_000), login_link_sent_at: 'rubbish' });
  assert.equal(inviteState(half, NOW), 'waiting');
});

test('only the genuinely stuck are reported', () => {
  const rows = [
    { display_name: 'Sent', ...profile({ login_link_requested_at: agoMs(9_000), login_link_sent_at: agoMs(8_000) }) },
    { display_name: 'Waiting', ...profile({ login_link_requested_at: agoMs(9_000) }) },
    { display_name: 'Stuck', ...profile({ login_link_requested_at: agoMs(STUCK_AFTER_MS * 3) }) },
    { display_name: 'PIN only', ...profile({ email: '', pin_hash: 'x' }) },
  ];
  assert.deepEqual(stuckInvites(rows, NOW).map((r) => r.display_name), ['Stuck']);
});

test('the advice is about the person in front of you, not the mail server', () => {
  // What an admin needs first is that this person can still work today.
  assert.match(meanwhile(profile({ pin_hash: 'x' })), /can sign in on the shared terminal now/);
  assert.match(meanwhile(profile()), /Give them a PIN/);
});

/* --------------------------------------------- giving somebody a login later */

/*
  REPORTED: "Also give them an email login" could not be switched on.

  It was locked on being an existing profile at all, so a login could only be
  decided in the thirty seconds somebody was first added. Anybody entered
  without one could never be given one — the toggle would not move, the email
  box was sealed, and "Send sign-in link" on their row does nothing without an
  address to send to. The only way out was to delete the person and add them
  again, losing the profile their shifts and discounts are recorded against.

  It is also how admins and managers ended up here with no address on their
  profiles while a group booking's notice had nobody to reach.
*/

test('a profile with no account is not signed in, whatever else it carries', () => {
  assert.equal(hasSignIn({ $id: 'p1' }), false);
  // An address with nothing behind it yet: invited, or never arrived.
  assert.equal(hasSignIn({ $id: 'p1', user_id: '' }), false);
  // The placeholder written for somebody who signs in with a PIN alone.
  assert.equal(hasSignIn({ $id: 'p1', user_id: 'p1' }), false);
});

test('a profile joined to a real account is signed in', () => {
  assert.equal(hasSignIn({ $id: 'p1', user_id: 'auth-abc' }), true);
});

test('an existing person with no login can be given one', () => {
  // The whole report. This was false before, for no reason but the lock.
  assert.equal(invitationWanted({
    wantsLogin: true,
    email: 'michael@bistro.com',
    profile: { $id: 'p1' },
  }), true);
});

test('a brand new person with a login still gets their invitation', () => {
  assert.equal(invitationWanted({
    wantsLogin: true,
    email: 'new@bistro.com',
    profile: {},
  }), true);
});

test('somebody who already signs in is not posted a link for being edited', () => {
  /*
    Every save used to ask for one, so ticking a permission for a manager sent
    them a sign-in link out of nowhere — which is the kind people are told to
    report as phishing. Sending one to somebody set up is its own button.
  */
  assert.equal(invitationWanted({
    wantsLogin: true,
    email: 'owner@bistro.com',
    profile: { $id: 'p1', user_id: 'auth-abc' },
  }), false);
});

test('an invitation waiting to arrive can be asked for again', () => {
  // Has the address, has no account: still reachable, which is what makes a
  // second attempt worth having.
  assert.equal(invitationWanted({
    wantsLogin: true,
    email: 'waiting@bistro.com',
    profile: { $id: 'p1' },
  }), true);
});

test('no address and no wish for one are both no invitation', () => {
  assert.equal(invitationWanted({ wantsLogin: false, email: 'a@b.com', profile: {} }), false);
  assert.equal(invitationWanted({ wantsLogin: true, email: '', profile: {} }), false);
  assert.equal(invitationWanted({ wantsLogin: true, email: '   ', profile: {} }), false);
  assert.equal(invitationWanted({ wantsLogin: true, profile: {} }), false);
});
