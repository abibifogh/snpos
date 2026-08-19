/**
 * Arriving at the POS already signed in, from the group's hub (Insight).
 *
 * Somebody who has signed in to Insight clicks "Restaurant POS" and lands here.
 * What arrives is an opaque code, never an identity: thirty-two random bytes
 * Insight will exchange, once, within ninety seconds. This calls Insight back —
 * server to server, with the POS's own shared secret — and asks who the code
 * was for.
 *
 * Appwrite owns its own sessions, so unlike the other systems on the hub this
 * one cannot mint a session from outside. What it can do, holding a server API
 * key, is create a one-shot *token* on the user's behalf, which the browser
 * exchanges for a real session against the POS's own domain. That is Appwrite's
 * own hand-off, the same one a staff invitation email uses.
 *
 * Three things this deliberately does not do.
 *
 * It does not trust anything in the URL. A URL ends up in a browser history, a
 * proxy log and a `Referer` header, and none of those should ever have held
 * somebody's address.
 *
 * It does not create accounts. If Insight says "this is ama@example.com" and
 * no user here has that address, the answer is no, with a message saying so.
 * Auto-provisioning would mean whoever controls the hub can mint themselves an
 * account on the till, and the whole point of a separate grant per system is
 * that reaching one is not reaching all of them.
 *
 * It does not widen anybody. The role Insight sends is ignored entirely. What
 * somebody may do here is their team membership and their staff profile, as it
 * always was. The hand-off decides *whether* they get in, never *as what*.
 *
 * Written as plain JavaScript importing nothing at runtime, so the parts that
 * decide who gets in can be tested without a database — the same arrangement
 * report-shape.js uses, and for the same reason.
 */

/** The teams that make somebody staff here. Must match STAFF_TEAMS in core/auth. */
export const STAFF_TEAMS = ['cooks', 'waiters', 'cashiers', 'managers', 'admins'];

export function ssoConfig(env) {
  return {
    redeemUrl: env?.INSIGHT_SSO_URL || '',
    secret: env?.INSIGHT_SSO_SECRET || '',
    systemId: env?.INSIGHT_SSO_SYSTEM || 'pos',
    appUrl: env?.POS_APP_URL || '',
    configured: Boolean(env?.INSIGHT_SSO_URL && env?.INSIGHT_SSO_SECRET && env?.POS_APP_URL),
  };
}

/**
 * Swap a code for an identity.
 *
 * Failures are short sentences a person can act on, because whoever hits this
 * followed a link and is now looking at a page wondering what went wrong.
 */
export async function redeemAtHub(code, { env = process.env, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const config = ssoConfig(env);
  if (!config.redeemUrl || !config.secret) {
    throw new Error('This system has not been connected to the group hub yet.');
  }
  // Length only. The code is opaque to us — the hub decides whether it is real
  // — but a two-character "code" is a mistake, not an attempt, and there is no
  // sense spending a round trip on it.
  if (typeof code !== 'string' || code.length < 20 || code.length > 300) {
    throw new Error('That sign-in link is not valid.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(config.redeemUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.secret}` },
      body: JSON.stringify({ systemId: config.systemId, code }),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('The group hub did not answer in time. Try again.');
    throw new Error('The group hub could not be reached.');
  } finally {
    clearTimeout(timer);
  }

  // A wrong secret is a setting somebody has to fix rather than an attack, so
  // it is worth naming. Every other failure is deliberately the same sentence:
  // telling a caller which kind of bad code they hold tells them something
  // about codes they do not hold.
  if (response.status === 401) {
    throw new Error('The group hub did not recognise this system. Its shared secret is wrong or missing.');
  }
  if (!response.ok) {
    throw new Error('That sign-in link has expired or has already been used. Go back to the hub and click through again.');
  }

  let identity;
  try {
    identity = await response.json();
  } catch {
    throw new Error('The group hub answered with something unreadable.');
  }
  if (!identity?.email) throw new Error('The group hub did not say who you are.');
  return identity;
}

/**
 * The member of staff Insight named, in this system's own users.
 *
 * Two questions, not one. Appwrite has a user for every guest who ever scanned
 * a table sticker, so "there is a user with that address" is not "there is a
 * member of staff with that address". Being staff here means belonging to one
 * of the staff teams — exactly what the app itself asks on every sign-in — and
 * a hand-off that skipped it would create a session the app then bounced,
 * which reads as a broken link rather than as a missing invitation.
 */
export async function staffUserFor(users, email) {
  const wanted = String(email ?? '').trim().toLowerCase();
  if (!wanted) throw new Error('The group hub did not say who you are.');

  // Queried rather than listed-and-filtered: this project has a user per guest.
  const found = await users.list([queryEqual('email', wanted)]);
  const user = (found?.users ?? []).find(
    (u) => String(u.email ?? '').trim().toLowerCase() === wanted,
  );
  if (!user) {
    throw new Error(`The group hub signed you in as ${wanted}, but nobody with that address has an account on the POS. An admin can invite them under Staff.`);
  }
  if (user.status === false) {
    throw new Error(`The account for ${wanted} on the POS has been blocked.`);
  }

  const memberships = await users.listMemberships(user.$id).catch(() => null);
  const teams = (memberships?.memberships ?? [])
    .map((m) => String(m.teamId ?? ''))
    .filter((id) => STAFF_TEAMS.includes(id));
  if (teams.length === 0) {
    throw new Error(`${wanted} has an account on the POS but is not on any staff team, so there is nothing here to sign in to. An admin can add them under Staff.`);
  }

  return { user, teams };
}

/**
 * Appwrite's `Query.equal`, without importing the SDK.
 *
 * This module is imported by the tests, which run without node-appwrite
 * installed at that path. The wire format is a documented string, and writing
 * it here costs one function and buys a file that can be tested at all.
 */
function queryEqual(attribute, value) {
  return JSON.stringify({ method: 'equal', attribute, values: [value] });
}

/**
 * Where the browser is sent to finish the exchange.
 *
 * `#/sso` rather than `#/token`: the token route asks the arrival to choose a
 * password, which is right for an invitation and wrong for somebody who already
 * signed in a moment ago somewhere else.
 *
 * Built from `POS_APP_URL` — configuration, set by an owner — and never from
 * anything in the request. An identity provider that redirects wherever the
 * query string says is a phishing page on your own domain.
 */
export function landingUrl(appUrl, userId, secret) {
  const base = String(appUrl || '').trim();
  if (!/^https?:\/\//i.test(base)) throw new Error('POS_APP_URL is not set to a full https:// address.');
  const target = new URL(base);
  target.hash = `#/sso?userId=${encodeURIComponent(userId)}&secret=${encodeURIComponent(secret)}`;
  return target.toString();
}

/**
 * The whole hand-off: `/sso?code=…` in, a redirect to a signed-in POS out.
 *
 * `users` is injected rather than constructed, so the decisions above can be
 * tested without an Appwrite project.
 */
export async function handleSso({ req, res, users, env = process.env, error, ...rest }) {
  const path = String(req?.path || '/').replace(/\/+$/, '') || '/';
  if (path !== '/sso') return null;

  const config = ssoConfig(env);
  try {
    const code = req?.query?.code;
    if (!code) throw new Error('That link is missing its sign-in code.');
    if (!config.appUrl) throw new Error('This system has not been connected to the group hub yet: POS_APP_URL is not set.');

    const identity = await redeemAtHub(code, { env, ...rest });
    const { user } = await staffUserFor(users, identity.email);

    // Appwrite's own hand-off: a one-shot secret, good for sixty seconds, that
    // the browser exchanges for a real session on the POS's own domain. Long
    // enough to survive a slow phone, short enough that the address it travels
    // in is worthless by the time anybody reads a log.
    const token = await users.createToken(user.$id, 64, 60);

    return res.redirect(landingUrl(config.appUrl, user.$id, token.secret), 302, {
      // A one-shot secret is in the address. It must not travel on in a
      // Referer header, and no cache may keep it.
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
  } catch (err) {
    const message = String(err?.message ?? err);
    if (typeof error === 'function') error(`SSO arrival refused: ${message}`);
    return failurePage(res, message, config.appUrl);
  }
}

/** A page, not JSON: whoever hits this is a person who followed a link. */
function failurePage(res, message, appUrl) {
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const back = /^https?:\/\//i.test(String(appUrl || '')) ? escape(appUrl) : '/';
  return res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Could not sign you in</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;color:#16202b;margin:0;display:grid;place-items:center;min-height:100vh;padding:1.5rem}
  main{background:#fff;border:1px solid #e3e7ec;border-radius:12px;padding:1.75rem;max-width:30rem}
  h1{font-size:1.15rem;margin:0 0 .6rem}
  p{margin:0 0 1rem;line-height:1.55;color:#5d6b7a}
  a{color:#0f766e}
  @media (prefers-color-scheme:dark){body{background:#0d1416;color:#e9f1f0}main{background:#151d1f;border-color:rgba(255,255,255,.12)}p{color:#9fb0ad}a{color:#4bbfae}}
</style></head><body><main>
  <h1>Could not sign you in</h1>
  <p>${escape(message)}</p>
  <p><a href="${back}">Sign in on the POS instead</a></p>
</main></body></html>`, 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
}
