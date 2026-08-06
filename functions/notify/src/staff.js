import { Teams, Users, Query, ID } from 'node-appwrite';

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

const TEAM_FOR = {
  cook: 'cooks', waiter: 'waiters', cashier: 'cashiers', manager: 'managers', admin: 'admins',
};

/**
 * Giving somebody their sign-in, and telling them about it.
 *
 * This used to be done by the browser: the admin app asked Appwrite to invite
 * the address to a team. It could not work. Creating a membership from a
 * browser needs the person doing it to be an owner of that team, and an admin
 * is an owner of the admins team only — so inviting a cook was refused, the
 * account was never created, and no email was ever sent. The profile saved
 * fine, which is what made it look like the email had simply gone astray.
 *
 * Doing it here fixes two things at once. The account and the membership are
 * made with a server key, so any admin can add anybody. And the email is sent
 * through the restaurant's own mail provider — the one already delivering
 * receipts — rather than Appwrite's shared sender, which is throttled and lands
 * in spam.
 *
 * The link signs them in once and asks them to choose a password. No temporary
 * password is ever typed by one person and read by another.
 */
export async function ensureLogin({ client, db, DB_ID, doc, settings, transport, from, shell, log, error }) {
  const email = (doc.email || '').trim().toLowerCase();
  if (!email) return { skipped: 'no email on this profile' };

  const wanted = TEAM_FOR[doc.role] || 'waiters';
  const users = new Users(client);
  const teams = new Teams(client);

  // Has a link already gone out, and is a new one being asked for? An edit to
  // somebody's phone number arrives here as the same event as "send them a
  // link", and only one of those should put mail in their inbox.
  const requested = doc.login_link_requested_at ? Date.parse(doc.login_link_requested_at) : 0;
  const sent = doc.login_link_sent_at ? Date.parse(doc.login_link_sent_at) : 0;

  // ---------------------------------------------------------------- account
  let account = null;
  if (doc.user_id && doc.user_id !== doc.$id) account = await users.get(doc.user_id).catch(() => null);
  if (!account) {
    const found = await users.list([Query.equal('email', email), Query.limit(1)]).catch(() => null);
    account = found?.users?.[0] ?? null;
  }
  let isNew = false;
  if (!account) {
    // No password. They set one from the link, so nothing has to be invented
    // here and then shared.
    account = await users.create(ID.unique(), email, undefined, undefined, doc.display_name || undefined);
    isNew = true;
    log(`Created an account for ${email}.`);
  }

  // ------------------------------------------------------------ memberships
  // Exactly one role team, matching the profile. Doing it every time is what
  // makes a promotion or a demotion take effect: the old team is left behind
  // rather than accumulated, so somebody demoted from manager actually loses
  // the manager's access rather than keeping it alongside their new one.
  for (const team of ROLE_TEAMS) {
    const list = await teams.listMemberships(team, [Query.limit(100)]).catch(() => null);
    if (!list) continue;
    const mine = list.memberships.filter((m) => m.userId === account.$id);
    if (team === wanted) {
      // By user id, never by email: passing an email starts Appwrite's own
      // invitation flow and sends its own mail, which is the thing being
      // replaced here.
      if (!mine.length) {
        await teams
          .createMembership(team, ['member'], undefined, account.$id, undefined, undefined, doc.display_name || undefined)
          .catch((e) => error(`Could not add ${email} to ${team}: ${e.message}`));
      }
      continue;
    }
    if (team === 'admins' && mine.length && list.memberships.length <= 1) {
      error(`Left ${email} in the admins team: it is the only admin account.`);
      continue;
    }
    for (const m of mine) {
      await teams.deleteMembership(team, m.$id).catch((e) => error(`Could not remove ${email} from ${team}: ${e.message}`));
    }
  }

  // ------------------------------------------------------------------- link
  const shouldSend = isNew || requested > sent;
  const patch = {};
  if (!doc.user_id || doc.user_id === doc.$id) patch.user_id = account.$id;

  if (!shouldSend) {
    if (Object.keys(patch).length) await db.updateDocument(DB_ID, 'staff_profiles', doc.$id, patch).catch(() => {});
    return { account: account.$id, sent: false, why: 'no link asked for' };
  }

  const site = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!site) {
    error('APP_URL is not set on this function, so there is no address to send anybody to. Re-run Deploy functions.');
    return { account: account.$id, sent: false, why: 'no APP_URL' };
  }
  if (!transport) {
    error('No SMTP configured, so no sign-in link could be sent.');
    return { account: account.$id, sent: false, why: 'no smtp' };
  }

  // A day, not the default quarter of an hour. Somebody added during service
  // reads their email that evening, and a link that expired while they were
  // working is a second job for the admin.
  const token = await users.createToken(account.$id, 32, 60 * 60 * 24);
  const link = `${site}/admin/#/token?userId=${encodeURIComponent(account.$id)}&secret=${encodeURIComponent(token.secret)}`;
  const place = settings.restaurant_name || 'the restaurant';

  await transport.sendMail({
    to: email,
    from,
    subject: `Your sign-in for ${place}`,
    text:
      `${doc.display_name || 'Hello'},\n\n` +
      `You have been set up on ${place}'s system as ${doc.role || 'staff'}.\n\n` +
      `Open this link to sign in and choose a password:\n${link}\n\n` +
      'The link works once and expires in 24 hours. If it has expired, ask for another.\n',
    html: shell(
      `Your sign-in for ${place}`,
      `<p style="margin:0 0 14px">${doc.display_name ? `${doc.display_name},` : 'Hello,'}</p>
       <p style="margin:0 0 18px">You have been set up on ${place}'s system as <strong>${doc.role || 'staff'}</strong>.</p>
       <p style="margin:0 0 22px"><a href="${link}" style="display:inline-block;background:${settings.primary_color || '#0f766e'};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Sign in and choose a password</a></p>
       <p style="margin:0;color:#5d6b7a;font-size:13px">The link works once and expires in 24 hours. If it has expired, ask for another.</p>`,
      settings.primary_color || '#0f766e',
    ),
  });

  patch.login_link_sent_at = new Date().toISOString();
  await db.updateDocument(DB_ID, 'staff_profiles', doc.$id, patch).catch((e) => error(`Sent the link but could not record it: ${e.message}`));

  log(`Sent a sign-in link to ${email}.`);
  return { account: account.$id, sent: true };
}

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
