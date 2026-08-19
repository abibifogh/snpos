import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleSso, landingUrl, redeemAtHub, ssoConfig, staffUserFor, STAFF_TEAMS,
  // Plain JavaScript, deliberately importing nothing at runtime so it can be
  // tested from here without an Appwrite project.
} from '../../../../functions/notify/src/sso.js';
import { readFileSync } from 'node:fs';

/**
 * Accepting a sign-in hand-off from the group hub.
 *
 * The dangerous failures here are all failures to refuse: letting a code stand
 * in for an identity, signing in a customer because they share an address with
 * a member of staff, or sending the one-shot secret somewhere the request
 * asked for. Each of those would look like everything working, for the wrong
 * person, so each has a test.
 */

const HUB = 'https://insight.example.com/api/sso/redeem';
const APP = 'https://pos.example.com/admin/';
const ENV = { INSIGHT_SSO_URL: HUB, INSIGHT_SSO_SECRET: 'shared-with-the-hub', POS_APP_URL: APP };
const CODE = 'a'.repeat(43);

/** A hub that answers with whatever it is told to, and records what it was asked. */
function fakeHub(answer: unknown, { status = 200 } = {}) {
  const seen: any[] = [];
  const impl: any = async (url: string, init: any) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => answer };
  };
  impl.seen = seen;
  return impl;
}

/** The POS's own users: two staff, one guest who scanned a table sticker. */
const USERS = [
  { $id: 'u_ama', email: 'ama@nice.test', name: 'Ama Boateng', status: true, teams: ['cashiers'] },
  { $id: 'u_kofi', email: 'kofi@nice.test', name: 'Kofi Mensah', status: false, teams: ['managers'] },
  { $id: 'u_guest', email: 'guest@nice.test', name: 'Guest', status: true, teams: [] },
];

function fakeUsers(rows = USERS) {
  const minted: any[] = [];
  return {
    minted,
    async list(queries: string[]) {
      // The real SDK filters server-side; mirror that so a handler which
      // forgot to query would not accidentally pass.
      const wanted = JSON.parse(queries[0]).values[0];
      return { total: 0, users: rows.filter((u) => u.email === wanted) };
    },
    async listMemberships(userId: string) {
      const user = rows.find((u) => u.$id === userId);
      return { memberships: (user?.teams ?? []).map((teamId) => ({ teamId })) };
    },
    async createToken(userId: string, length: number, expire: number) {
      minted.push({ userId, length, expire });
      return { userId, secret: 'one-shot-secret', expire };
    },
  };
}

/** Appwrite's res, reduced to what this handler uses. */
function fakeRes() {
  const out: any = {};
  return {
    out,
    redirect(url: string, status: number, headers: Record<string, string>) {
      Object.assign(out, { kind: 'redirect', url, status, headers });
      return out;
    },
    send(body: string, status: number, headers: Record<string, string>) {
      Object.assign(out, { kind: 'send', body, status, headers });
      return out;
    },
  };
}

const arrive = async (code: unknown, fetchImpl: any, over: any = {}) => {
  const res = fakeRes();
  const users = over.users ?? fakeUsers();
  await handleSso({
    req: { path: '/sso', query: code == null ? {} : { code } },
    res, users, env: over.env ?? ENV, fetchImpl, error: () => {},
  } as any);
  return { ...res.out, users };
};

test('a good code becomes a one-shot Appwrite token, and a redirect to the app', async () => {
  const hub = fakeHub({ email: 'ama@nice.test', name: 'Ama Boateng', role: 'owner' });
  const r = await arrive(CODE, hub);

  assert.equal(r.kind, 'redirect');
  assert.equal(r.status, 302);
  assert.equal(r.headers['Referrer-Policy'], 'no-referrer');
  assert.match(r.headers['Cache-Control'], /no-store/);

  const url = new URL(r.url);
  assert.equal(url.origin + url.pathname, 'https://pos.example.com/admin/');
  const params = new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1));
  assert.equal(params.get('userId'), 'u_ama');
  assert.equal(params.get('secret'), 'one-shot-secret');
  assert.ok(url.hash.startsWith('#/sso'), 'the invitation route would ask for a password');

  assert.deepEqual(r.users.minted, [{ userId: 'u_ama', length: 64, expire: 60 }]);
});

test('the identity travels on the back channel, never in the URL', async () => {
  const hub = fakeHub({ email: 'ama@nice.test', name: 'Ama Boateng', role: 'cashier' });
  await arrive(CODE, hub);

  assert.equal(hub.seen.length, 1, 'the code must be exchanged, not read');
  assert.equal(hub.seen[0].url, HUB);
  assert.equal(hub.seen[0].init.headers.Authorization, 'Bearer shared-with-the-hub');
  assert.deepEqual(hub.seen[0].body, { systemId: 'pos', code: CODE });
});

test('a customer who happens to share an address is not signed in as staff', async () => {
  // The failure that matters most here. Appwrite has a user for every guest who
  // ever scanned a table sticker, so "a user exists" is not "staff exists".
  const hub = fakeHub({ email: 'guest@nice.test', name: 'Guest', role: 'owner' });
  const r = await arrive(CODE, hub);

  assert.equal(r.status, 400);
  assert.match(r.body, /not on any staff team/);
  assert.equal(r.users.minted.length, 0, 'no token may be minted for a non-member of staff');
});

test('somebody the hub knows and the POS does not is refused, by name', async () => {
  const hub = fakeHub({ email: 'stranger@nice.test', name: 'Stranger', role: 'admin' });
  const r = await arrive(CODE, hub);

  assert.equal(r.status, 400);
  assert.match(r.body, /stranger@nice\.test/, 'say who, so an admin knows what to invite');
  assert.match(r.body, /nobody with that address has an account/);
  assert.equal(r.users.minted.length, 0);
});

test('a blocked account stays blocked', async () => {
  const hub = fakeHub({ email: 'kofi@nice.test', name: 'Kofi Mensah', role: 'manager' });
  const r = await arrive(CODE, hub);

  assert.equal(r.status, 400);
  assert.match(r.body, /has been blocked/);
  assert.equal(r.users.minted.length, 0);
});

test('a code the hub refuses mints nothing', async () => {
  const r = await arrive(CODE, fakeHub({ error: 'no' }, { status: 400 }));
  assert.match(r.body, /expired or has already been used/);
  assert.equal(r.users.minted.length, 0);
});

test('a wrong shared secret says so, because it is a setting somebody must fix', async () => {
  const r = await arrive(CODE, fakeHub({ error: 'no' }, { status: 401 }));
  assert.match(r.body, /did not recognise this system/);
});

test('a link with no code fails before anything is called', async () => {
  let called = false;
  const r = await arrive(null, async () => { called = true; });
  assert.equal(r.status, 400);
  assert.match(r.body, /missing its sign-in code/);
  assert.equal(called, false);
});

test('an unconnected system says so rather than reaching out', async () => {
  let called = false;
  const r = await arrive(CODE, async () => { called = true; }, { env: {} });
  assert.match(r.body, /not been connected to the group hub/);
  assert.equal(called, false);
});

test('an unreachable hub is a sentence, not a stack trace', async () => {
  const r = await arrive(CODE, async () => { throw new Error('ECONNREFUSED'); });
  assert.match(r.body, /could not be reached/);
  assert.doesNotMatch(r.body, /ECONNREFUSED/);
});

test('a hub that names nobody is refused', async () => {
  const r = await arrive(CODE, fakeHub({ name: 'Nobody', role: 'admin' }));
  assert.match(r.body, /did not say who you are/);
});

test('the failure page escapes what it repeats back', async () => {
  const r = await arrive(CODE, fakeHub({ email: '<script>alert(1)</script>@x.test', name: 'x', role: 'admin' }));
  assert.doesNotMatch(r.body, /<script>alert/);
  assert.match(r.body, /&lt;script&gt;/);
});

test('an obvious non-code costs no round trip', async () => {
  let called = false;
  const probe: any = async () => { called = true; };
  await assert.rejects(() => redeemAtHub('short', { env: ENV, fetchImpl: probe }), /not valid/);
  await assert.rejects(() => redeemAtHub(null, { env: ENV, fetchImpl: probe }), /not valid/);
  assert.equal(called, false);
});

test('anything that is not /sso is left alone', async () => {
  const res = fakeRes();
  const handled = await handleSso({
    req: { path: '/reports/orders', query: { code: CODE } },
    res, users: fakeUsers(), env: ENV, error: () => {},
  } as any);
  assert.equal(handled, null, 'the reporting API must still get its own requests');
  assert.deepEqual(res.out, {});
});

test('where the browser lands is configuration, never input', () => {
  // An identity provider that redirects wherever the query string says is a
  // phishing page on your own domain. The only source is POS_APP_URL.
  assert.match(landingUrl(APP, 'u_1', 's'), /^https:\/\/pos\.example\.com\/admin\/#\/sso\?/);
  assert.throws(() => landingUrl('', 'u_1', 's'), /POS_APP_URL/);
  assert.throws(() => landingUrl('javascript:alert(1)', 'u_1', 's'), /POS_APP_URL/);
  assert.throws(() => landingUrl('evil.example.com', 'u_1', 's'), /POS_APP_URL/);
});

test('the userId and secret are escaped into the address', () => {
  const url = landingUrl(APP, 'u/1&x', 'a b+c');
  const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.equal(params.get('userId'), 'u/1&x');
  assert.equal(params.get('secret'), 'a b+c');
});

test('the address is matched without case or stray spaces mattering', async () => {
  const { user } = await staffUserFor(fakeUsers(), '  AMA@Nice.TEST ');
  assert.equal(user.$id, 'u_ama');
  await assert.rejects(() => staffUserFor(fakeUsers(), ''), /did not say who you are/);
  await assert.rejects(() => staffUserFor(fakeUsers(), '   '), /did not say who you are/);
});

test('the staff teams match the ones the app itself asks for', () => {
  // Read out of the app's own source rather than compared against a copy of
  // the list. Importing it is not possible here — core/auth pulls in the
  // browser Appwrite client, which wants import.meta.env — and a test carrying
  // its own duplicate would go on passing after the two had drifted apart.
  //
  // Drift matters: the hand-off would start minting sessions the app then
  // bounces, which reads as a broken link rather than a missing invitation.
  const source = readFileSync(new URL('../auth.ts', import.meta.url), 'utf8');
  const listed = /export const STAFF_TEAMS = \[([^\]]+)\]/.exec(source);
  assert.ok(listed, 'STAFF_TEAMS is no longer declared where this test looks for it');
  const appTeams = [...listed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  assert.ok(appTeams.length > 0, 'the app declares at least one staff team');
  assert.deepEqual([...STAFF_TEAMS].sort(), appTeams.sort());
});

test('half a configuration is not a configuration', () => {
  assert.equal(ssoConfig(ENV).configured, true);
  assert.equal(ssoConfig({ ...ENV, POS_APP_URL: '' }).configured, false);
  assert.equal(ssoConfig({ ...ENV, INSIGHT_SSO_SECRET: '' }).configured, false);
  assert.equal(ssoConfig({}).configured, false);
  assert.equal(ssoConfig(ENV).systemId, 'pos');
});
