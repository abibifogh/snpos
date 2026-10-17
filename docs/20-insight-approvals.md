# Approvals from the group hub

**Insight** (the group hub) has an **Approvals** page. It lists everything waiting for an admin's decision in every system in one place. Pressing a choice there makes the decision **in the system it came from, as the person who pressed it**. This document covers the POS end.

## What Insight sees and can decide

| Kind | Decided from Insight | The same write as |
|---|---|---|
| Spends at the till (pending) | Approve / Refuse | `decideSpend` |
| Purchase orders over the limit (waiting) | Approve / Refuse, with a note | `decidePurchaseOrder` |
| Group bookings (pending) | Approve, with a note to the guest; Refuse only if no meal times are on the kitchen's list yet | `decideGroupBooking` |
| Changes to a booking (open) | Done / Refuse, with a reply | `decideBookingChange` |
| Bar, kitchen, store-room and shop counts, shelf changes | **Listed only**, with a link to Waiting for you | — |

Decisions from Insight make exactly the writes the admin app makes, so what follows those writes still happens:

- A refused spend is reversed in the books.
- A decided group booking emails the guest.

Counts are not decided from outside because approving one moves stock through rules that live in the app. Refusing a group booking whose meal times are already on the list also cancels those orders and gives money back, so that is done in the app too.

Every decision from Insight also writes an `audit_log` row with `device: "Insight"` and the person's own account as `actor_id`, so the trail says where it was pressed.

## Who

Insight names the person by email. They must be a user here with an active staff profile:

- An **admin** decides everything in the table.
- A **manager** decides spends, purchase orders, group bookings and booking changes, as the Waiting page already lets them.

Nobody is created and nobody is widened, the same rules as the sign-in hand-off (`19-group-sign-in.md`).

## The two paths

The paths `POST /approvals/list` and `POST /approvals/decide` live on the notify function, beside `/sso` and `/reports`. Both are answered before anything else the function does.

Each request is signed by Insight with the same shared secret the hand-off uses:

- **The secret:** `INSIGHT_SSO_SECRET` here; it is `SSO_SECRET_POS` in Insight.
- **The headers:** `X-Till-At` (milliseconds) and `X-Till-Sig`.
- **The signature:** HMAC-SHA256 over `till-link`, the time, the path and the body, each on its own line.
- **The time limit:** within five minutes.

An unsigned or stale request gets 401 before the database is read.

Links back to the app use `APP_URL` (the admin app's address), as the health email does.

## Setting it up

Nothing new if the hand-off already works: the secret is the one it uses.

In Insight, the POS must have its reports address set under Setup. That address is the notify function's domain, which is where the two paths are answered.

Code: `functions/notify/src/insight-approvals.js`. Tests: `functions/notify/insight-approvals.test.mjs`.
