import { account, db, teams, DB_ID, Query } from './client';
import type { StaffProfile } from './types';

/**
 * Telling a member of staff apart from a customer.
 *
 * The customer menu signs every guest in anonymously — that is what lets
 * someone who has only scanned a sticker place an order. The consequence is
 * that "is there a session?" is a useless question on a staff screen: a
 * customer who scanned a table code half an hour ago has one.
 *
 * The real question is whether this person is in a staff team, and that is
 * what these ask. Appwrite decides it, not the browser, so a page cannot talk
 * its way past it.
 */

export const STAFF_TEAMS = ['cooks', 'waiters', 'cashiers', 'managers', 'admins'] as const;
export type StaffTeam = (typeof STAFF_TEAMS)[number];

/** Which staff teams this session belongs to. Empty for a guest. */
export async function myStaffTeams(): Promise<StaffTeam[]> {
  try {
    const list = await teams.list();
    return list.teams
      .map((t) => t.$id as StaffTeam)
      .filter((id) => (STAFF_TEAMS as readonly string[]).includes(id));
  } catch {
    // A guest cannot list teams at all, which is itself the answer.
    return [];
  }
}

export interface StaffSession {
  userId: string;
  email: string;
  name: string;
  teams: StaffTeam[];
}

export class NotStaffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotStaffError';
  }
}

/**
 * The session, or a refusal.
 *
 * Throws rather than returning null so a screen cannot forget to check: the
 * boot sequence stops, and the message explains the difference between "not
 * signed in" and "signed in, but as a customer" — which look identical from
 * the outside and need completely different answers.
 */
export async function requireStaff(): Promise<StaffSession> {
  let me;
  try {
    me = await account.get();
  } catch {
    throw new NotStaffError('Sign in on this device first.');
  }

  const mine = await myStaffTeams();
  if (mine.length === 0) {
    throw new NotStaffError(
      'This device is signed in as a customer, not as staff. Sign out and sign in with a staff account.',
    );
  }

  return { userId: me.$id, email: me.email, name: me.name, teams: mine };
}

/**
 * The staff profile behind a session, joining the two up on first sign-in.
 *
 * A profile is written when somebody is invited, which is before they have an
 * account for it to point at — so on their very first sign-in nothing matches
 * on the account id. Matching on the email address they were invited with, and
 * stamping the id onto the profile, is what closes that gap. Every sign-in
 * after this one matches directly.
 *
 * Without it, an invitation could be accepted and the sign-in succeed, only for
 * the app to open with no name, no role and no permissions — which reads as a
 * broken account rather than a blank field.
 */
export async function staffProfileFor(session: {
  userId: string;
  email?: string;
}): Promise<StaffProfile | null> {
  const byId = await db.listDocuments(DB_ID, 'staff_profiles', [
    Query.equal('user_id', session.userId),
    Query.limit(1),
  ]);
  if (byId.documents[0]) return byId.documents[0] as unknown as StaffProfile;

  const email = (session.email ?? '').trim().toLowerCase();
  if (!email) return null;

  const byEmail = await db.listDocuments(DB_ID, 'staff_profiles', [
    Query.equal('email', email),
    Query.limit(1),
  ]);
  const found = byEmail.documents[0];
  if (!found) return null;

  // The stamp is a convenience, not a requirement. A role with no write access
  // to staff_profiles simply matches on email again next time, which costs one
  // extra query and nothing else.
  const claimed = await db
    .updateDocument(DB_ID, 'staff_profiles', found.$id, { user_id: session.userId })
    .catch(() => found);
  return claimed as unknown as StaffProfile;
}

/** Drop whatever session is on this device, guest or staff. */
export async function signOutCompletely(): Promise<void> {
  await account.deleteSession('current').catch(() => undefined);
}
