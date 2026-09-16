/**
 * Whether the party has agreed to the booking as it now stands.
 *
 * A booking that has been changed here — a sitting moved, numbers adjusted, a
 * dish swapped — is no longer the thing the party has a copy of. They are
 * holding a sheet that is now wrong, and until they say otherwise nobody knows
 * whether the change is what they asked for or merely what somebody here
 * typed. A party of forty arriving to find Thursday lunch became Thursday
 * dinner without their agreeing to it is a worse failure than the change never
 * having been made.
 *
 * TWO STAMPS, NOT A FLAG, and that is the whole design. A flag can say
 * "approved" and cannot say "approved, and then we changed it again" — which
 * is the state that actually matters, because it looks exactly like agreement
 * and is not. Asked for today and agreed to last week is WAITING. The same
 * arithmetic as a sign-in link; see inviteState.
 *
 * Pure. Nothing here reads or writes.
 */

export interface ApprovableBooking {
  /** Asked for, and not yet sent. Cleared by the job. */
  approval_send_at?: string | null;
  /*
    Nullable because that is how a cleared date comes back from the database,
    and a rule that only accepts undefined would force every caller to launder
    its own row before asking a question about it.
  */
  approval_requested_at?: string | null;
  approval_given_at?: string | null;
  approval_note?: string;
}

export type ApprovalState =
  /** Nothing has been sent for approval. The booking stands as it was made. */
  | 'none'
  /** Asked for just now. The job sends it on the event; give it a moment. */
  | 'sending'
  /** Sent, and the party has not answered it yet. */
  | 'awaiting'
  /** The party has agreed to the booking as it now stands. */
  | 'approved';

const at = (iso?: string | null): number => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : 0;
};

export function approvalState(b: ApprovableBooking): ApprovalState {
  /*
    Asked for and not yet gone. Answered first, because until the email has
    actually left there is nothing for the party to have agreed to — and a row
    reading "waiting on the party" about a message that never left sends
    somebody to chase a guest who was never written to.
  */
  if (at(b.approval_send_at)) return 'sending';

  const asked = at(b.approval_requested_at);
  const given = at(b.approval_given_at);

  if (!asked && !given) return 'none';
  /*
    A newer request than the last answer is an unanswered one.

    Compared rather than merely checked for presence, because a revision can
    happen twice: a party that agreed to the first change and has been sent a
    second has both stamps, and only the order of them says whether today's is
    still outstanding. Checking presence alone would read the second revision
    as already agreed to, which is the exact failure this exists to prevent.
  */
  if (asked > given) return 'awaiting';
  return 'approved';
}

export interface ApprovalWords {
  label: string;
  tone: 'ok' | 'warn' | 'default';
  /** A sentence for the row, where there is something worth saying. */
  detail?: string;
}

/** What to show the house about where a revision has got to. */
export function approvalWords(state: ApprovalState): ApprovalWords {
  if (state === 'sending') {
    return {
      label: 'Sending…',
      tone: 'default',
      detail: 'Asked for just now. It normally reaches them within a minute.',
    };
  }
  if (state === 'awaiting') {
    return {
      label: 'Waiting on the party',
      tone: 'warn',
      detail: 'The revised booking has gone to them. They have not agreed to it yet.',
    };
  }
  if (state === 'approved') {
    return { label: 'Party agreed', tone: 'ok', detail: 'They have agreed to the booking as it now stands.' };
  }
  return { label: 'Not sent for approval', tone: 'default' };
}

/** Whether there is an answer outstanding from the party on this booking. */
export const awaitingParty = (b: ApprovableBooking): boolean => approvalState(b) === 'awaiting';

/**
 * Why this booking cannot be sent for approval, in a sentence, or null.
 *
 * An address is the whole of it. Everything else about a booking can be
 * missing and the revision still means something; with no address there is
 * nobody to send it to, and a button that silently does nothing is worse than
 * one that says why.
 */
export function approvalRequestProblem(b: { email?: string } & ApprovableBooking): string | null {
  if (!(b.email ?? '').trim()) {
    return 'This booking has no email address on it, so there is nobody to send the revision to.';
  }
  return null;
}

/** The kind written on a change request that is the party agreeing. See the schema. */
export const APPROVAL_KIND = 'approved';

/**
 * Whether this change request is a party's approval rather than a request.
 *
 * It arrives in the same collection because a guest cannot write to the
 * booking row and should not be able to — a link that could edit a booking is
 * a link that could empty a pass. So the answer comes in as a message and the
 * job stamps the booking from it.
 */
export const isApproval = (c: { kind?: string }): boolean => c.kind === APPROVAL_KIND;
