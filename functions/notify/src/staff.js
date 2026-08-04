import { Teams, Users, Query } from 'node-appwrite';

/**
 * Cancelling a login when somebody leaves.
 *
 * Removing a staff profile used to remove only the profile. The Appwrite
 * account behind it stayed, still in its role team, still able to sign in — so
 * a person who had left could open the till, and the admin who removed them
 * had no way of knowing. It also claimed their email address forever: inviting
 * the same person again failed, because the login they were being invited to
 * create already existed.
 *
 * This runs when a profile is deleted and takes the account with it.
 *
 * It has to live server-side. Deleting somebody else's account, or removing
 * them from a team the admin is not themselves a member of, is not something a
 * browser is allowed to do — and should not be.
 */

const ROLE_TEAMS = ['cooks', 'waiters', 'cashiers', 'managers', 'admins'];

export async function revokeLogin({ client, db, DB_ID, doc, log, error }) {
  const email = (doc.email || '').trim().toLowerCase();
  const userId = doc.user_id || '';

  // A cook who signed in with a PIN and never had an email has no login to
  // cancel. That is the common case, and it is not a failure.
  if (!email && !userId) return { revoked: false, why: 'no login on this profile' };

  const users = new Users(client);
  const teams = new Teams(client);

  // Somebody else may still be using this address — most likely because the
  // profile was re-created before this ran, or because two profiles were made
  // by mistake and the spare is the one being deleted. Either way the account
  // is still in use and must not be touched.
  const stillUsed = await db
    .listDocuments(DB_ID, 'staff_profiles', [
      ...(email ? [Query.equal('email', email)] : [Query.equal('user_id', userId)]),
      Query.limit(2),
    ])
    .catch(() => ({ documents: [] }));
  const others = stillUsed.documents.filter((p) => p.$id !== doc.$id);
  if (others.length) {
    log(`Left ${email || userId} alone: ${others[0].display_name} still uses that login.`);
    return { revoked: false, why: 'another profile still uses this login' };
  }

  // Find the account. The id is the reliable way, but an invited person who
  // has not signed in yet has no id on their profile — their account exists
  // (Appwrite creates it when the invitation is sent) and is found by email.
  let account = null;
  if (userId) account = await users.get(userId).catch(() => null);
  if (!account && email) {
    const found = await users.list([Query.equal('email', email), Query.limit(1)]).catch(() => null);
    account = found?.users?.[0] ?? null;
  }
  if (!account) return { revoked: false, why: 'no account found for this profile' };

  // The one account that must never be deleted by a click: the last admin.
  // Removing your own profile is an easy mistake to make, and recovering from
  // it means an Appwrite console and a support conversation.
  const admins = await teams.listMemberships('admins', [Query.limit(100)]).catch(() => null);
  if (admins) {
    const isAdmin = admins.memberships.some((m) => m.userId === account.$id);
    if (isAdmin && admins.memberships.length <= 1) {
      error(`Refused to cancel the login for ${email || account.$id}: it is the only admin account. The profile has been removed but the login is untouched.`);
      return { revoked: false, why: 'this is the only admin account' };
    }
  }

  // Deleting the account removes every team membership with it. The
  // memberships are cleared first anyway, so that a delete which fails for any
  // reason still leaves somebody who cannot open a single screen — a login
  // that survives is worse than an account record that lingers.
  for (const team of ROLE_TEAMS) {
    const list = await teams.listMemberships(team, [Query.limit(100)]).catch(() => null);
    if (!list) continue;
    for (const m of list.memberships.filter((m) => m.userId === account.$id)) {
      await teams.deleteMembership(team, m.$id).catch((e) => error(`Could not remove ${email} from ${team}: ${e.message}`));
    }
  }

  await users.delete(account.$id).catch((e) => {
    error(`Removed ${email || account.$id} from every team but could not delete the account: ${e.message}`);
  });

  log(`Cancelled the login for ${email || account.$id}.`);
  return { revoked: true, email: email || null };
}
