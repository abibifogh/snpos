# 08, Deployment, stage by stage

Each stage ends with a **verification** you can actually perform. Don't move on
until it passes. Stages 0–3 are setup; 4–9 are build-and-ship; 10 is go-live.

---

## Stage 0, Accounts & local tooling

1. Install Node 20+ and pnpm: `npm i -g pnpm`.
2. Create an Appwrite account at <https://cloud.appwrite.io> and create an
   organisation.
3. Install the CLI: `npm i -g appwrite-cli` (v6+).
4. Log in: `appwrite login` → follow the browser prompt.

**Verify:** `appwrite client --debug` prints your endpoint and a valid session.

> Self-hosting instead? On a 4 GB VPS: install Docker, run Appwrite's
> `docker compose` installer, point a domain at it, let Traefik issue TLS, then
> `appwrite client --endpoint https://appwrite.<domain>/v1`. Everything below is
> identical from that point.

---

## Stage 1, Appwrite project

1. In the console: **Create project** → name `snpos`, region closest to your
   restaurant (latency matters for the kitchen ping).
2. Copy the **Project ID**.
3. **Settings → Platforms → Add platform → Web app** for each surface:
   `menu`, `pos`, `kds`, `admin`, hostnames `localhost` for now, real domains
   added in Stage 9. Realtime and the SDK will reject unregistered origins, so
   this step is not optional.
4. **Settings → API keys → Create key** named `server-functions` with scopes:
   `databases.*`, `documents.*`, `users.read`, `users.write`, `teams.*`,
   `files.read`, `files.write`. Copy the secret; it is shown once.
5. **Auth → Settings**: enable Email/Password and **Anonymous** (the QR menu
   needs anonymous sessions). Set session length to 1 year for staff devices.
   Disable any provider you don't use.

**Verify:** `appwrite projects get --project-id <id>` returns your project.

---

## Stage 2, Provision the schema

```bash
git clone <this repo> && cd snpos
cp .env.example .env        # fill APPWRITE_ENDPOINT, PROJECT_ID, API_KEY
                            # NB: the endpoint is region-specific, copy the
                            # exact one from your console, e.g.
                            # https://fra.cloud.appwrite.io/v1
pnpm install
pnpm provision              # runs scripts/provision.mjs
```

The script is idempotent, re-run it after any schema change; it creates what's
missing and reports what already exists. It creates:

- database `snpos` and every collection in doc 02, with attributes and indexes,
- teams `cooks`, `waiters`, `cashiers`, `managers`, `admins`,
- buckets `menu-images` (10 MB, image types only), `branding`, `receipts`,
- the seeded chart of accounts, default payment methods (Cash, Card), and the
  `settings` document with sane defaults.

**Verify:** the console shows the `snpos` database with ~50 collections, and
`settings/main` exists with `shift_float_policy = "zero"`. `feature_flags`
should hold one row per feature and `venues` your first venue.

> Appwrite creates attributes asynchronously. If an index fails with "attribute
> not available", wait 10 seconds and re-run `pnpm provision`, the script
> already retries, but a very cold project occasionally needs a second pass.

---

## Stage 3, First admin user

```bash
pnpm seed:admin --email you@example.com --name "Owner"
```

This creates the account, adds it to the `admins` team, creates its
`staff_profiles` row and prints a temporary password. Change it at first login.

**Verify:** log into the Appwrite console → Auth → the user exists and shows
membership of `admins`.

---

## Stage 4, Deploy the Functions

```bash
appwrite push functions
```

Deploys `order-guard`, `kitchen-escalate`, `shift-close`, `stock-variance` and
`payment-webhook` from `functions/` using the definitions in `appwrite.json`.

Then, per function, set the environment variables in the console (**Functions →
[fn] → Settings → Variables**):

| Variable | Value |
| --- | --- |
| `APPWRITE_ENDPOINT` | your endpoint |
| `APPWRITE_PROJECT_ID` | project ID |
| `APPWRITE_API_KEY` | the `server-functions` key |
| `DB_ID` | `snpos` |

Confirm the schedules: `kitchen-escalate` = `* * * * *`,
`stock-variance` = `30 2 * * *`. Set execute permission to `users` for
`order-guard` and `shift-close`, `any` for `payment-webhook`, and **none** for
the scheduled ones.

**Verify:** `appwrite functions create-execution --function-id order-guard
--body '{"ping":true}'` returns `{"ok":true}`.

---

## Stage 4b, Trading hours

Set each venue's opening hours under **Admin → Venues → [venue] → Hours**, plus
any dated holiday closures. The system needs these to know when it's open, and, 
if pre-ordering is on, which future times a customer may order into. Without
hours set, the "order ahead" time picker has nothing to offer.

**Verify:** open the customer menu outside those hours. You should see the menu
with an "order ahead" banner, not a dead end.

---

## Stage 4c, Venues

`provision.mjs` creates your first venue (`main`) automatically. For each
additional location: Admin → Venues → Add, then set its name, address,
timezone, order-number prefix, and optionally its own logo/colours and shift
float policy.

The menu and recipes are **shared** across venues; each venue can switch an item
off or set its own price under Admin → Menu → [item] → Per-venue. Staff, shifts,
cash, stock, expenses and accounts stay completely separate per venue.

Assign every staff member to their venue(s) in Stage 5, step 11. Leaving a
person's venue list empty means "all venues", use that only for owners.

**Verify:** switch venues in the admin header; sales, shifts and stock all
change, while the menu stays the same.

---

## Stage 4d, Switch features on or off

`provision.mjs` seeds every feature as enabled at group level. Go to
**Admin → Settings → Features** and turn off anything you don't want yet; you
can change any of them later without losing data ([doc 13](13-features.md)).

Set at minimum:

- **Receipts**, confirm delivery is `email`, fill in the from-name and
  from-address under Settings → Email, and decide whether kitchen slips print
  (off by default).
- **Takeaway**, add your pickup points under Admin → Venues → [venue] →
  Pickup points. `Front counter` is created for you; add any others, with their
  directions and lead times.
- **Shift summary**, add recipients under Admin → Settings → Reports. Both
  stock sections are on by default: items flagged for the first time, and
  separately anything low or out for 3+ shifts running (threshold adjustable).
- **Pre-orders**, confirm the lead time, slot length, how far ahead customers
  may order, and any per-slot capacity. Needs Stage 4b done first.
- **Discounts**, set each role's discount ceiling in Stage 5, step 11, and the
  manager-PIN threshold (default: above 20%).

**Verify:** turn one feature off and confirm its screens disappear for staff;
turn it back on and confirm nothing was lost.

---

## Stage 5, Configure the restaurant (no code)

Run the apps locally (`pnpm dev`) and log into `admin` at
<http://localhost:5174>. Work through Setup in this order, later steps depend
on earlier ones:

1. **Branding**, restaurant name, primary/secondary colours, logo (light and
   dark), favicon. Watch the contrast warnings.
2. **Currency & tax**, code, symbol, decimals, symbol position, tax rate and
   whether prices include tax, service charge.
3. **Payment methods**, enable Cash and Card; add mobile money if you take it;
   set which are counted at close and which need a reference.
4. **Shift policy**, confirm float policy is `zero` (the default) or change it
   deliberately.
5. **Ingredients & suppliers**, before menu items, so recipes can be linked.
6. **Categories** with their availability windows.
7. **Menu items**, price, image (crop + focal point), station, prep time,
   availability override, `track_stock`.
8. **Add-on groups and options**, then attach them to items with any per-item
   price overrides.
9. **Recipes**, map each item and priced add-on to its ingredients. This is the
   tedious step, and every analytics feature in doc 06 depends on it. Do the top
   20 sellers first; the rest can follow.
10. **Tables**, labels, zones, seats. Then **print QR codes** from
    Admin → Tables → Print, which generates an A6 card per table with your logo
    and brand colours.
11. **Staff**, create each user, assign a role, set a PIN, set discount/void
    limits.

**Verify:** open `menu` at `/t/<token>` for a real table on your phone; the
menu shows your colours, logo, currency, and only the items available right now.

---

## Stage 6, Staging deploy

Deploy the four apps to any static host (Vercel, Netlify, Cloudflare Pages) or
to Appwrite Sites:

```bash
pnpm build            # builds all four into apps/*/dist
```

Per app, set build env vars: `VITE_APPWRITE_ENDPOINT`, `VITE_APPWRITE_PROJECT`,
`VITE_DB_ID`, and `VITE_APP=menu|pos|kds|admin`.

Add each staging hostname to **Appwrite → Settings → Platforms**, or realtime
will silently fail to connect.

**Verify:** open the KDS and the POS on two different devices. Place an order
from a third. The kitchen pings within a second; accepting it stops the ping on
every device at once.

---

## Stage 7, Test the full day cycle on staging

Do this end to end with real people before real customers. Script:

1. Open a shift with a GH₵200 cash float.
2. Place 3 QR orders and 2 waiter orders; accept 4, **reject 1 with a reason**, 
   confirm the reason reaches the diner's phone.
3. 86 an item from the KDS; confirm it disappears from a diner's open menu.
4. Take payments: one cash, one card, one **split** across both, one with a tip.
5. Record two expenses, one with a receipt photo.
6. Refund one order.
7. Close the shift: settle open tickets, approve expenses, blind-count the cash
   (deliberately key GH₵20 short), complete the stock check marking one item
   LOW and one OUT.
8. Confirm: variance shows −20, the journal entries balance, the ledger shows
   the sales, the purchase list contains the LOW/OUT items, the OUT item's
   dishes are 86'd.
9. **Open the next shift and confirm the drawer starts at zero, not at the
   previous closing balance.** This is the specific requirement, test it
   explicitly.
10. Kill the KDS tablet's wifi for 60 seconds mid-service, place an order, then
    restore it, the ticket must appear and ping on reconnect.
11. **Offline drill** (doc 11.6): take 5 orders with wifi off, restore, confirm
    all 5 arrive exactly once; force-close the app mid-queue and confirm nothing
    is lost; try to close a shift with one terminal still offline and confirm
    the close waits and names that terminal.

**Verify:** every item above behaves as described. Fix, redeploy, repeat.

---

## Stage 8, Hardware & devices

- **Kitchen tablet**: Android, 10"+, mains powered. Install the native kitchen
  app, full build and setup steps in **[doc 12](12-kitchen-app.md)**, summarised
  as Stage 8b below. Pair a loud external speaker; tablet speakers lose to an
  extractor fan.
- **POS terminals**: install the POS PWA, pin it, disable auto-updates during
  service hours.
- **Receipt printer**: any 80mm ESC/POS printer. Network printers work from the
  browser via a small print bridge; USB printers need the bridge on a host
  machine. (See doc 09; this is one of the items awaiting your confirmation.)
- **QR codes**: print on laminated table cards or acrylic stands. Keep a spare
  set. Rotate a token immediately if a card is stolen.
- **Network**: staff devices on a separate SSID from guest wifi, with the
  kitchen tablet on 5 GHz near the AP. A UPS on the router is cheap insurance.

---

## Stage 8b, Build and install the kitchen app

```bash
pnpm --filter kitchen build
npx cap sync android
npx cap open android          # build a signed APK from Android Studio
```

Copy the APK to each kitchen tablet, allow installation from unknown sources,
install. Then work through the tablet checklist in doc 12.4, especially
**turning off battery optimisation** for the app, and the two final tests
(alarm sounds with the screen off; app returns by itself after a reboot).

Back up the signing keystore somewhere safe. Losing it means you can't push
updates to installed tablets.

**Verify:** lock the tablet, place an order from a phone, the screen wakes and
the alarm sounds at full volume. Reboot the tablet and confirm it reconnects
without anyone touching it.

---

## Stage 9, Production

1. Point DNS: `menu`, `pos`, `kds`, `admin` subdomains at your host.
2. Add all four production hostnames to Appwrite Platforms.
3. Rotate the API key created in Stage 1 and set the new value on every function
   (the original will have been in your shell history).
4. Enable MFA on all admin accounts.
5. **Backups**: Appwrite Cloud takes platform backups; additionally schedule a
   nightly export function that writes a JSON dump of every collection to a
   storage bucket, and pull a weekly copy off-platform. Test a restore once.
6. Set up an uptime check against the KDS URL and an Appwrite health endpoint.
7. Re-print QR codes pointing at the production domain.

**Verify:** repeat the Stage 7 script on production with a token order, then
void it.

---

## Stage 10, Go live

- **Soft launch**: one section of the room on QR ordering for a week, the rest
  on waiter ordering. Watch the rejection reasons and the kitchen SLA breaches.
- Keep the old process available for a fortnight. Print a paper backup of the
  day's menu.
- Train in this order: cooks (accept/reject/ready) → waiters (tickets, transfers,
  splits) → cashiers (payments, expenses, close) → managers (approvals, reports)
  → admin (everything). 30 minutes each, on real devices.
- Have a written fallback for "internet is down": take orders on paper, key them
  in after. The shift close still reconciles because the payments go in against
  the same shift.
- After two weeks, review: menu engineering quadrants, variance flags, rejection
  reasons, hourly heatmap. That first review usually pays for the system.

---

## Rollback

Every stage is reversible: the apps are static builds (redeploy the previous
build), functions keep version history in Appwrite (activate a prior
deployment), and schema changes are additive, `provision.mjs` never drops a
column. Data changes are protected by the audit log and by reversing journal
entries rather than deletes.
