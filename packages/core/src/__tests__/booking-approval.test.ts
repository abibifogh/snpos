import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalState, approvalWords, awaitingParty, approvalRequestProblem,
  isApproval, APPROVAL_KIND,
} from '../booking-approval.ts';

/*
  A booking changed here is no longer the thing the party has a copy of. They
  are holding a sheet that is now wrong, and until they say otherwise nobody
  knows whether the change is what they asked for or merely what somebody here
  typed.
*/

test('a booking nobody has revised has nothing to approve', () => {
  assert.equal(approvalState({}), 'none');
  assert.equal(awaitingParty({}), false);
  assert.equal(approvalWords('none').label, 'Not sent for approval');
});

test('sent and unanswered is waiting on the party', () => {
  const b = { approval_requested_at: '2026-03-10T09:00:00Z' };
  assert.equal(approvalState(b), 'awaiting');
  assert.equal(awaitingParty(b), true);
  assert.equal(approvalWords('awaiting').tone, 'warn');
});

test('answered after it was asked is agreed to', () => {
  const b = {
    approval_requested_at: '2026-03-10T09:00:00Z',
    approval_given_at: '2026-03-10T09:40:00Z',
  };
  assert.equal(approvalState(b), 'approved');
  assert.equal(awaitingParty(b), false);
  assert.equal(approvalWords('approved').tone, 'ok');
});

test('AGREED TO, AND THEN CHANGED AGAIN, is waiting — not agreed', () => {
  /*
    The state the whole design exists for. A flag would say "approved" here,
    because they did once approve something; what they have never seen is the
    booking as it stands now. It looks exactly like agreement and is not.
  */
  const b = {
    approval_given_at: '2026-03-01T10:00:00Z',
    approval_requested_at: '2026-03-10T09:00:00Z',
  };
  assert.equal(approvalState(b), 'awaiting');
  assert.equal(awaitingParty(b), true);
});

test('a second revision agreed to is agreed to again', () => {
  const b = {
    approval_requested_at: '2026-03-10T09:00:00Z',
    approval_given_at: '2026-03-10T11:00:00Z',
  };
  assert.equal(approvalState(b), 'approved');
});

test('an answer with no question behind it still counts as agreed', () => {
  // Odd, and not worth calling waiting: nothing is outstanding, and reporting
  // a party as owing an answer they have already given sends somebody to chase
  // them for nothing.
  assert.equal(approvalState({ approval_given_at: '2026-03-10T09:00:00Z' }), 'approved');
});

test('an unreadable stamp is treated as absent rather than as now', () => {
  // Date.parse hands back NaN, and a NaN compared with anything is false —
  // which would quietly read as approved.
  assert.equal(approvalState({ approval_requested_at: 'not a date' }), 'none');
  assert.equal(
    approvalState({ approval_requested_at: '2026-03-10T09:00:00Z', approval_given_at: 'rubbish' }),
    'awaiting',
  );
});

/* ------------------------------------------------- before it can be sent */

test('a booking with no address has nobody to send a revision to', () => {
  const why = approvalRequestProblem({ email: '' });
  assert.match(String(why), /no email address/i);
  assert.equal(approvalRequestProblem({ email: '   ' }) !== null, true);
  assert.equal(approvalRequestProblem({}) !== null, true);
});

test('a booking with an address can be sent', () => {
  assert.equal(approvalRequestProblem({ email: 'party@hotel.com' }), null);
});

/* --------------------------------------------- the party's answer, inbound */

test('the party\'s approval is told apart from a request to change something', () => {
  /*
    Both land in booking_changes, because a guest cannot write to a booking row
    and should not be able to — a link that could edit a booking is a link that
    could empty a pass.
  */
  assert.equal(isApproval({ kind: APPROVAL_KIND }), true);
  for (const kind of ['numbers', 'timing', 'food', 'dietary', 'cancel', 'other']) {
    assert.equal(isApproval({ kind }), false, `${kind} is a request, not an answer`);
  }
  assert.equal(isApproval({}), false);
});

/* ------------------------------------------- the copy the job actually runs */

/*
  The notify job cannot import this file. A function is deployed on its own,
  with no workspace around it, so functions/notify/src/booking-approval.js is a
  deliberate hand copy of the constant above.

  The two sides MUST agree exactly. If the page writes one word and the job
  looks for another, every approval a party sends is silently filed as an
  ordinary change request, the booking is never stamped, and nobody is ever
  told the party agreed — a failure that looks like the guest not answering.
*/
test('the job\'s copy of the approval kind has not drifted', async () => {
  const job = await import('../../../../functions/notify/src/booking-approval.js');
  assert.equal(job.APPROVAL_KIND, APPROVAL_KIND);
  assert.equal(job.isApproval({ kind: APPROVAL_KIND }), true);
  assert.equal(job.isApproval({ kind: 'numbers' }), false);
  // And it survives the shapes a database hands back.
  assert.equal(job.isApproval({}), false);
  assert.equal(job.isApproval(null), false);
});
