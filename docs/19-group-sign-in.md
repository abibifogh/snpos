# Signing in from the group hub

Somebody who has signed in to **Insight** — the reporting site that reads this
POS alongside attendance, breakfast and the laundry — clicks **Restaurant POS**
and arrives at the admin app already signed in, without typing a password.

This is the authorization-code half of OAuth and nothing else. The protocol
itself is written up in the Insight repository (`bi/docs/sso.md`); this document
is the POS end of it.

---

## What happens when somebody clicks

```
  browser                 Insight                    this POS
     │                       │                          │
     │  click "Restaurant POS"                          │
     ├──────────────────────►│                          │
     │                       │ checks the grant         │
     │                       │ mints 32 random bytes    │
     │  302 …/sso?code=…     │                          │
     │◄──────────────────────┤                          │
     │                                                  │
     │  GET  <function>/sso?code=…                      │
     ├─────────────────────────────────────────────────►│
     │                       │  POST /api/sso/redeem    │
     │                       │  Bearer <its own secret> │
     │                       │◄─────────────────────────┤
     │                       │  { email, name, role }   │
     │                       ├─────────────────────────►│
     │                       │                          │ finds that email in
     │                       │                          │ its own users, checks
     │                       │                          │ they are on a staff team,
     │                       │                          │ mints an Appwrite token
     │  302 …/admin/#/sso?userId=…&secret=…             │
     │◄─────────────────────────────────────────────────┤
     │                                                  │
     │  account.createSession(userId, secret)           │
     │  → a real session on the POS's own domain        │
```

Appwrite owns its own sessions, so unlike the other systems on the hub this one
cannot mint a session from outside. What it *can* do, holding a server API key,
is create a one-shot **token** on the user's behalf, which the browser exchanges
for a real session against the POS's own domain. That is Appwrite's own
mechanism — the same one a staff invitation email uses.

---

## Where the code lives

| Piece | File |
| --- | --- |
| The decisions — redeem, match, refuse | `functions/notify/src/sso.js` |
| Routed before everything else | `functions/notify/src/main.js` |
| Finishing the exchange in the browser | `apps/admin/src/pages/Login.tsx` |
| Tests | `packages/core/src/__tests__/sso.test.ts` |

It is inside the `notify` function for the same arithmetic that put the
reporting API and the hourly sweep there: the plan allows four functions and
this project has four.

`sso.js` imports nothing at runtime, so the parts that decide who gets in are
tested without an Appwrite project — the same arrangement `report-shape.js`
uses.

---

## The three refusals

These are the reason a simpler version would not be safe.

**It never trusts the URL.** The redirect carries an opaque code and nothing
else. A URL ends up in a browser history, a proxy log, a `Referer` header and
whatever somebody pastes into a chat; a single-use code ninety seconds old is
worthless in all of them, and an email address is not. The identity travels on
the back channel, authenticated by this system's own shared secret.

**It never creates an account.** If Insight names somebody with no account here,
they are refused, by name, so an admin knows who to invite. Auto-provisioning
would mean whoever controls the hub can mint themselves an account on the till.

**It never widens anybody.** The `role` Insight sends is ignored entirely. What
somebody may do here is their team membership and their staff profile, exactly
as when they type their password.

### And one more, particular to this system

**A user is not a member of staff.** Appwrite has a user for every guest who
ever scanned a table sticker. So the hand-off asks a second question: is this
person on one of `cooks`, `waiters`, `cashiers`, `managers`, `admins`? If not,
they are refused with a message saying so. Skipping that check would mint a
session the app then bounces — which reads as a broken link rather than as a
missing invitation. A test reads the team list out of `packages/core/src/auth.ts`
so the two cannot drift apart silently.

---

## Setting it up

### 1. A shared secret, different from every other system's

```bash
openssl rand -base64 32
```

Sharing one secret across systems throws away the property that a compromised
laundry cannot mint sessions on the POS.

### 2. Three function variables on `notify`

Appwrite console → **Functions → Notify → Settings → Variables**:

| Variable | Value |
| --- | --- |
| `INSIGHT_SSO_URL` | `https://insight.niceoperation.com/api/sso/redeem` |
| `INSIGHT_SSO_SECRET` | the value from step 1 |
| `POS_APP_URL` | where the admin app is served, e.g. `https://pos.niceoperation.com/admin/` |

`POS_APP_URL` is where the browser is sent to finish the exchange. It is read
from configuration and never from the request: an identity provider that
redirects wherever the query string says is a phishing page on your own domain.

The function's API key needs **users.read** and **users.write** — the first to
find the person, the second to mint the token.

### 3. The same secret on Insight

In the attendance repository, add repository secret `INSIGHT_SSO_SECRET_POS`
with the value from step 1, then run **Actions → Set Insight's secrets**. Until
this is done Insight reports *"SSO_SECRET_POS is not set"* on the hub, which is
correct rather than broken — the far end of this hand-off is in this
repository, so Insight cannot generate the secret by itself.

### 4. Switch the hand-off on

In Insight, under **Accounts → Where each system lives**, set the POS's sign-in
address to the notify function's domain plus `/sso`, and tick the hand-off.

---

## What `execute: ["any"]` does and does not mean

The person following a hand-off link has no account here yet — that is the whole
point — so Appwrite has to be willing to *run* the function for anybody. That is
what `"execute": ["any"]` in `appwrite.json` says, and no more.

It does not open the reporting API: that still refuses every request without
`REPORTS_API_KEY`, and refuses every request with the wrong one. It does not
open the email and event machinery either: an HTTP request that is neither
`/reports` nor `/sso` is answered `404` before a database is read or an email is
composed.

---

## When something does not work

| What you see | What it means |
| --- | --- |
| "The group hub did not recognise this system" | The two ends hold different secrets. |
| "expired or has already been used" | Someone refreshed the landing page or reopened a bookmarked link. Working as intended — go back to the hub. |
| "nobody with that address has an account on the POS" | Invite them under Staff first. Insight will not create them. |
| "…is not on any staff team" | They have an account but no staff team — most likely a customer account. Add them under Staff. |
| "That hand-off has already been used or has expired" | The Appwrite token is good for sixty seconds and once only. Click through again. |
| The hub says "SSO_SECRET_POS is not set" | Step 3 has not been done. |
