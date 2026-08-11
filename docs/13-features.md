# 13, Optional features and the admin switchboard

Every feature below is **in scope**, and every one of them is something
an admin turns on or off; nothing is forced on you. This doc covers how the
switchboard works and what each feature does.

## 13.1 The switchboard

**Admin → Settings → Features** lists them all with a toggle each and an
"Options" panel underneath.

- On or off at group level per the table in 13.2; you can change
  any of them before go-live.
- Each venue can **override the group setting**. Delivery on at the high street
  branch, off at the mall branch, without touching the others.
- Turning a feature off **hides it, it does not delete it**. The waste log you
  recorded last year is still there if you turn waste logging back on. No
  migration, no data loss, no rebuild.
- Some features depend on others. Loyalty needs customer profiles, so the
  loyalty toggle is greyed out with a note explaining why until customers is on.
  The UI tells you rather than failing quietly.
- Every toggle change is written to the audit log with who did it and when.

Technically: rows in the `feature_flags` collection keyed by feature name, with
a JSON `config` blob per feature. Apps call `isEnabled('takeaway')` and render
accordingly. Defaults live in `FEATURES` in `scripts/schema.mjs`.

## 13.2 The features

| Key | Feature | Default | Notes |
| --- | --- | --- | --- |
| `receipts` | Receipts and kitchen slips | On | Email by default, see 13.3 |
| `preorders` | Order ahead / order while closed | On | Kitchen stays silent until fire time, see 13.6 |
| `takeaway` | Takeaway and delivery | On | Multiple pickup points, see 13.4 |
| `waste_log` | Waste log | On | Makes the stock alerts trustworthy |
| `time_clock` | Staff clock in / out | On | Adds labour cost to reports |
| `customers` | Customer profiles | On | Everything about it is optional for the guest |
| `loyalty` | Loyalty / stamp card | On | Requires `customers` |
| `feedback` | Feedback after paying | On | Alerts a manager on a rating below 3 |
| `multilingual` | Multi-language menu | On | Add languages under Admin → Menu → Languages |
| `purchase_orders` | Purchase orders and receiving | On | Flags short deliveries and price rises |
| `shift_summary` | Summary at shift close | On | Sent on close, see 13.5 |
| `busy_mode` | Kitchen busy mode | On | Trips automatically at a ticket threshold |
| `time_pricing` | Happy hour / time-based prices | On | Changes the price shown, before any discount |

---

## 13.3 Receipts, email first, printing optional

**Receipts are emailed, not printed**, by default. Printing is still available
if you want it (`receipt_delivery`: `email` / `print` / `both` / `off`).

How the email address is captured, in order:

1. **The guest types it while ordering** on their phone, one optional field, no
   account, no password. Skippable.
2. **Staff enter it at payment**, the cashier gets an email field on the
   payment screen for guests who ordered at the table or counter.
3. **It's already on file**, if the guest is a known customer (feature 5), the
   address is filled in automatically and the cashier just confirms.
4. **Skip it**, "No receipt" is always one tap away and needs no reason. The
   order records `skip_reason: no_email` so your records show it was offered.

Every send attempt is logged in `receipts` with its status, so "did that
customer ever get their receipt?" is answerable months later. Failed sends
retry and then show up in the admin dashboard rather than disappearing.

**Kitchen slips print separately and switch off independently**
(`print_kitchen_slips`, default **off** since you have the kitchen screen). Turn
them on and every accepted order also prints a paper docket at the kitchen
printer, useful as a fallback if a tablet dies mid-service.

## 13.4 Takeaway and delivery, many pickup points

A venue can have **as many pickup points as you like**, each configured under
Admin → Venues → [venue] → Pickup points:

- Name and kind, front counter, side window, kiosk, locker, kerbside, or a
  partner site across town.
- Its own address, directions and phone. The directions text is shown to the
  customer on their phone, which matters for anything that isn't the obvious
  front door.
- **Lead time in minutes**, added to the prep estimate for points that are
  further away.
- Its own opening hours, independent of the venue's.
- Which kitchen station serves it.

The customer picks their point when ordering; staff can change it. The kitchen
ticket shows the pickup point prominently, because handing food to the wrong
queue is the classic takeaway failure. Delivery is a separate toggle with its
own zones and fees, and any pickup point can be marked as a dispatch origin.

## 13.5 Shift summary, sent on close, with persistent stock problems

The summary is **sent the moment a shift is closed**, not on a nightly timer.
Whoever closes up triggers it by finishing the close wizard.

It contains:

- Sales, covers, average spend, and the split by payment method.
- Cash counted vs expected, and the variance.
- Voids, discounts and refunds, with who authorised them.
- Waste recorded during the shift.
- **Stock, in two separate sections**, see below.

### Stock is reported in two sections, never merged

**① New this shift.** Every item reported low or out **for the first time**,
listed in full. This is what to act on tonight: reorder it, or 86 it before
tomorrow's service.

**② Ongoing, flagged 3+ shifts running.** A summarised roll-up of items that
have been low or out for three or more consecutive shifts, each with how many
shifts and how long it's been that way. This is what to make a *decision*
about: a supplier who keeps short-delivering, a par level set too low, or
something going missing.

Keeping them apart is the whole point. A first-time flag is normal operations.
The same item low for the fourth shift running is a different kind of problem
wearing the same clothes, and merging the two lists is exactly how the second
one gets ignored. The threshold for section ② is configurable
(`persistent_stock_threshold`, default 3), and either section can be switched
off on its own.

The count lives on each ingredient (`consecutive_low_count`) and resets the
moment a count comes back healthy, so an item that recovers and later dips
again correctly reappears in section ① rather than carrying old history.
Recipients are configured per person and per channel, email, WhatsApp, SMS or
push, under Admin → Settings → Reports. You can also switch on a separate
nightly digest if you want both.

## 13.6 Ordering while closed (`preorders`)

Customers can browse the menu and place an order **outside trading hours**,
choosing a time when the restaurant will be open. Nothing reaches the kitchen
until that time comes round.

### What the customer sees

When the venue is closed, the menu opens normally with a banner, *"We're
closed right now, order ahead and pick a time"*, rather than a dead end. They
build their order as usual, then choose a slot from the next available trading
period. The time picker only ever offers slots the kitchen can actually serve:

- Inside opening hours, respecting per-venue holiday closures.
- At least `min_lead_minutes` away (default 30), nobody orders for five
  minutes from now.
- No later than `cutoff_minutes_before_close` before the venue shuts.
- Up to `max_days_ahead` in advance (default 7).
- Not already full, if you've set a per-slot capacity.

Ordering ahead works **during** service too, "I'll collect at 7pm", and for
all three fulfilment types, each of which you can switch off separately.

### What the kitchen sees: nothing, until it's time

This is the part that matters. A pre-order sits in a new `SCHEDULED` state and
is **invisible to the kitchen screen and silent**; it does not alarm, does not
count towards busy mode, and does not appear in the ticket queue.

At `fire_at`, computed by working back from the requested time using the items'
prep minutes plus a small buffer, the order flips to `PENDING` and behaves
exactly like a live order: it appears, it alarms, it escalates. The kitchen
never has to remember that something is due later, the system remembers.

If you'd rather see them in advance, `require_staff_confirmation` puts
pre-orders in front of a manager first, and there's a separate "Coming up"
list on the terminal showing what's due in the next few hours.

### The details that stop it going wrong

- **Shifts.** A pre-order placed while closed belongs to no shift. It's stamped
  with whichever shift is open when it fires, so the money lands in the right
  day's takings rather than the day it was typed.
- **Prices.** Snapshotted at ordering. If you change a price overnight, the
  customer pays what they were quoted.
- **Availability.** Re-checked at fire time. If something has sold out
  overnight, staff are prompted to call the customer rather than the order
  silently failing, there's a `cannot_meet_slot` rejection reason for exactly
  this.
- **Capacity.** `slot_capacity` caps orders per slot, held in `preorder_slots`
  and incremented server-side in one step, so two people can't both take the
  last place at 12:00. Left at 0 it's unlimited.
- **Payment** is still recorded by staff at handover, unchanged by any of this.

## 13.7 The rest, briefly

- **Waste log**, staff record spoiled, dropped or binned food as it happens,
  with an optional photo and a cost. Kept separate from stock movements so
  "we threw it away" is never confused with "it went missing".
- **Clock in / out**, PIN-based, ties hours to shifts, and turns into staff
  cost as a percentage of sales.
- **Customer profiles**, built from a phone number or email given at ordering.
  Always optional for the guest.
- **Loyalty**, points or a "buy 9 get 1 free" stamp card, tracked
  automatically and shown on the receipt.
- **Feedback**, a one-tap rating after paying, linked to the order, the items
  and the server. Anything below 3 stars alerts a manager the same shift.
- **Multi-language**, a language picker on the customer menu; translations are
  stored per field so you translate only what you want to.
- **Purchase orders**, raise an order to a supplier, then tick off what
  actually arrived. Short deliveries and quiet price rises get flagged.
- **Busy mode**, when tickets waiting pass a threshold, customer orders are
  quoted a longer wait; past a second threshold they're held. Trips
  automatically or by hand from the kitchen screen.
- **Time-based prices**, happy hour and similar. This changes the price the
  customer *sees*; discounts (doc 14) reduce an already-priced bill. Keeping
  the two separate is what makes the reports honest.


---

## 13.8 Storage layout

The design uses three storage buckets, menu images (public), branding
(public), expense receipts (managers only), so a private receipt and a public
photo are separated by where they live, not just by a permission setting.

Appwrite's free plan allows **one** bucket. When provisioning detects that, it
falls back automatically:

- All files share one bucket, and **file-level security is switched on**.
- Every upload must therefore carry its own permissions: menu images and
  branding are readable by anyone, expense receipts by managers and admins
  only. The property that matters, receipts are not world-readable, is
  preserved; the isolation is just weaker, since a mistake at upload time is no
  longer caught by the bucket itself.
- `settings.storage_mode` records which layout is in use (`multi` or `single`)
  and `settings.shared_bucket_id` names the shared bucket, so the apps know
  where to upload without guessing.

Upgrading the Appwrite plan later and re-running `npm run provision` creates the
separate buckets and flips the mode back to `multi`. Existing files stay where
they are.


---

## 13.9 Menu structure

### A dish can live in several categories

`menu_items.category_id` is the dish's **primary** category, it gives every
dish one home and sets its default kitchen station. Additional memberships are
rows in `menu_item_categories`.

This exists because categories carry their own availability hours. Put Jollof
in both *Lunch* (11:00–15:00) and *À la carte* (all day) and it appears under
Lunch only at lunchtime, while remaining visible under À la carte throughout.
The same dish, two different visibility rules, no duplicate record and no
divergent prices.

A membership can be switched off per category (`active`) without removing it,
and carries its own `sort` so a dish can be third under Lunch and first under
Mains.

### Options (add-ons)

`addon_groups` are reusable question sets, "Choose your protein", with
`addon_options` as the answers. Each option carries a `price_delta` which may
be **zero**: an included choice and a paid upgrade are the same mechanism, and
nothing needs a special case for "free".

Groups attach to dishes through `menu_item_addon_groups`, so one group serves
many dishes. `min_select`, `max_select` and `required` express the rules, 
pick one, pick up to three, must answer before ordering.

Prices are captured onto the order line at the time of ordering, so changing an
option's price later never rewrites what a past customer was charged.
