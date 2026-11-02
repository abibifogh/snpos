# Team activity for Insight

**Insight** (the group hub) has a **Team** page. For each member of staff it shows what they have coming up, are doing, have done, have let run over, have asked somebody else for, and what is holding them back, and it rates how they are doing from that. This document covers the POS end: one signed, **read-only** path that hands Insight each person's items.

## The path

`POST /team/activity` lives on the notify function, beside `/approvals/list` and `/floats/po`. It is signed exactly like those (see `20-insight-approvals.md`):

- **The headers:** `X-Till-At` (milliseconds) and `X-Till-Sig`.
- **The signature:** HMAC-SHA256 with `INSIGHT_SSO_SECRET` over `till-link`, the time, the path and the body, each on its own line.
- **The time limit:** within five minutes.

An unsigned or stale request gets 401 before the database is read.

```json
{ "emails": ["kofi@example.test", "ama@example.test"], "from": "2026-10-20", "to": "2026-11-02" }
```

- At most **200 emails**, and a period of at most **100 days** (both days counted). More, a day that is not a real `YYYY-MM-DD`, or `from` after `to` gets 400.
- It answers `{ ok: true, people: { "<email, lower case>": { found, items: [...] } } }`. **Every email asked about is in the answer.**
- If one kind of row could not be read, the rest still comes back, and the answer also carries `failed: ["orders", ...]`.

## Who

A person is a POS login with that email (looked up a hundred emails at a time) **and** a staff profile, matched by the login's id, or by the email for a profile not yet linked. A login without a profile, or an email nobody here has, is `found: false` with no items. Rows name people by their login's id, and on a shared till sometimes by their profile's id, so both are looked for.

## What is listed

Everything of theirs **still open now**, plus anything **made, due or finished in the period**.

| Kind | What | Theirs because | `status` |
|---|---|---|---|
| `shift` | "Bar shift", "Kitchen shift", "Shop shift" | they opened it or closed it | open shift `doing`, closed `done` |
| `spend` | "Spend · A Drinks Depot" | they recorded it | waiting for approval `open`, otherwise `done` |
| `order` | "PO-0142 · A Drinks Depot" | they made it | draft, waiting, ready `open`; sent, part-received `doing`; received `done`; cancelled or refused `cancelled` |
| `count` | "Bar count", "Kitchen count", "Store room count" | they counted it (one shift, one end of it) | held `open`, otherwise `done`; taken back `cancelled` |
| `shop_count` | "Shop count" | they counted it | held `open`, otherwise `done` |
| `charge` | "Charged for a count difference · Tonic water" | it was put down to them | owed `open`, settled `done` |

The fields, as Insight reads them:

- **`id`**: `shift:<id>`, `spend:<id>`, `order:<id>`, `count:<shift id>|<open or close>`, `shop_count:<id>`, `charge:<id>`.
- **`routine`**: a closed shift, and a count that is not held.
- **`asked` and `decision`**: a spend or an order that needed somebody else's approval: `waiting`, `approved` or `refused`. A count shows its `decision` too, but is not `asked`.
- **`due`**: a shift's day; a count's is its shift's day; an order's is the day it is expected.
- **`waiting_on`** and **`waiting_since`**: only while something is held by somebody else, for example "Approval of PO-0142 (over the limit)" or "Count held: 2 lines differ, an admin decides".
- **`waited_days`**: to a tenth of a day, for anything that waited, decided or not.
- **`reopened`**: a count refused and filed again, or an order refused and asked again.
- **`money_issue`**: a charge owed, and a count whose shortage was charged to them.
- **`amount`**: minor units, for spends, orders and charges.
- **`link`**: a page in the admin app, from `APP_URL`.

**Estimates.** There is no "asked at" on an order, so the wait is counted from when the admins were told about it, or from when it was made; an order asked again counts from its refusal. When a spend was decided comes from the audit trail, else from when it was last changed. A settled charge is finished when it was last changed. Shifts, spends, orders and charges come with no "overdue" of their own: Insight decides that from `due` and `status`.

## How it reads

Nothing is written, not even an audit row. Each collection is read for the whole team at once, a hundred ids at a time: once for rows changed since the start of the period, once for rows still open. Never a read per person. The shifts the counts were taken on, and the audit rows for decisions, are read the same way.

## Setting it up

Nothing new. The signature uses `INSIGHT_SSO_SECRET`, the one the sign-in hand-off and Approvals already use, and links use `APP_URL`. No Provision is needed: it reads fields that already exist.

Code: `functions/notify/src/insight-team.js`. Tests: `functions/notify/insight-team.test.mjs`.
