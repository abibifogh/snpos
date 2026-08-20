/**
 * Whether somebody's sign-in link actually went out.
 *
 * The browser cannot send this email and never could: creating an account and
 * putting somebody in a team needs a server key, which a browser is not
 * allowed to hold. So asking is a FIELD on the profile —
 * `login_link_requested_at` — and a background job picks it up, sends the mail,
 * and stamps `login_link_sent_at`.
 *
 * That design is right and it had one bad consequence: the admin app said "a
 * sign-in link is on its way" the moment the profile saved, which is a claim it
 * has no way to know. If the job was not deployed, or the mail settings were
 * never filled in, nothing happened at all and the screen said it had. The
 * failure was invisible from the only place anybody looks.
 *
 * The two stamps already hold the answer. This reads them.
 *
 * Pure. Nothing here reads or writes.
 */

export interface InviteProfile {
  email?: string;
  pin_hash?: string;
  user_id?: string;
  login_link_requested_at?: string;
  login_link_sent_at?: string;
}

export type InviteState =
  /** No email on the profile. They sign in with a PIN, or not at all. */
  | 'no_email'
  /** Has an email, but nobody has asked for a link yet. */
  | 'not_asked'
  /** Asked for just now. The job runs on the event; give it a moment. */
  | 'waiting'
  /** The job sent it. This is the only state that means an email exists. */
  | 'sent'
  /** Asked for long enough ago that nothing is coming. Something is wrong. */
  | 'stuck';

/**
 * How long to wait before calling it stuck.
 *
 * The job runs off the database event, so in a working system the stamp comes
 * back in seconds. Two minutes is long enough to cover a slow build or a
 * retry, and short enough that somebody who added a cook before service finds
 * out during service rather than the next morning.
 */
export const STUCK_AFTER_MS = 2 * 60 * 1000;

const at = (iso?: string): number => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : 0;
};

export function inviteState(p: InviteProfile, now: Date = new Date()): InviteState {
  if (!(p.email ?? '').trim()) return 'no_email';

  const requested = at(p.login_link_requested_at);
  const sent = at(p.login_link_sent_at);

  if (!requested && !sent) return 'not_asked';
  /*
    A newer request than the last send is an unanswered one.

    Compared rather than merely checked for presence, because "send it again"
    is the same two fields: somebody who was sent a link in March and asked for
    a fresh one today has both stamps, and only the order of them says whether
    today's has gone.
  */
  if (requested > sent) {
    return now.getTime() - requested > STUCK_AFTER_MS ? 'stuck' : 'waiting';
  }
  return 'sent';
}

export interface InviteWords {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'default';
  /** The sentence shown under the row, where there is something to say. */
  detail?: string;
}

export function inviteWords(state: InviteState): InviteWords {
  if (state === 'sent') return { label: 'Link sent', tone: 'ok' };
  if (state === 'waiting') {
    return { label: 'Sending…', tone: 'warn', detail: 'Asked for just now. This normally lands within a minute.' };
  }
  if (state === 'stuck') {
    return {
      label: 'Not sent',
      tone: 'danger',
      // Says what is true — that nothing was sent — rather than what was
      // hoped. The two causes are named on the page itself.
      detail: 'Asked for, but the server never sent it. Nothing has reached them.',
    };
  }
  if (state === 'not_asked') return { label: 'No link yet', tone: 'default' };
  return { label: 'PIN only', tone: 'default' };
}

/** Anybody whose link was asked for and never went. */
export const stuckInvites = <T extends InviteProfile>(rows: T[], now: Date = new Date()): T[] =>
  rows.filter((r) => inviteState(r, now) === 'stuck');

/**
 * The two reasons a link does not arrive, in the order worth checking.
 *
 * Both are settings on the server rather than anything on this screen, which
 * is exactly why the failure was invisible: nothing an admin could see was
 * wrong, and nothing they could do from here would have fixed it.
 */
export const INVITE_CHECKS: { what: string; how: string }[] = [
  {
    what: 'The mail settings may be missing',
    how: 'The server needs SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS set as GitHub secrets. '
      + 'Without them the job runs, records what it would have sent, and sends nothing. Receipts and the '
      + 'daily summary use the same settings, so if those are not arriving either, this is why.',
  },
  {
    what: 'The background jobs may not be running the latest version',
    how: 'Run "Deploy functions" in GitHub Actions. Sending sign-in links is one of them, and it also '
      + 'picks up the mail settings above — changing a secret does nothing until it is run again.',
  },
];

/**
 * What somebody can do for the person in front of them, right now.
 *
 * The useful thing to say to an admin whose invitation did not arrive is not
 * "check your SMTP" — it is that this person can still be let in today. A cook
 * with a PIN can work the whole shift without an email ever arriving.
 */
export function meanwhile(p: InviteProfile): string {
  return p.pin_hash
    ? 'They already have a PIN, so they can sign in on the shared terminal now. The link is only needed for the admin dashboard on their own device.'
    : 'Give them a PIN in the meantime — edit them and set one. That gets them working on the shared terminal today; the link is only for the admin dashboard on their own device.';
}
