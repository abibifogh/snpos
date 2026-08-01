# 13 — Optional features and the admin switchboard

All twelve features below are **in scope**, and every one of them is something
an admin turns on or off — nothing is forced on you. This doc covers how the
switchboard works and what each feature does.

## 13.1 The switchboard

**Admin → Settings → Features** lists all twelve with a toggle each and an
"Options" panel underneath.

- Off by default at group level or on, per the table in 13.2 — you can change
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

## 13.2 The twelve

| Key | Feature | Default | Notes |
| --- | --- | --- | --- |
| `receipts` | Receipts and kitchen slips | On | Email by default — see 13.3 |
| `takeaway` | Takeaway and delivery | On | Multiple pickup points — see 13.4 |
| `waste_log` | Waste log | On | Makes the stock alerts trustworthy |
| `time_clock` | Staff clock in / out | On | Adds labour cost to reports |
| `customers` | Customer profiles | On | Everything about it is optional for the guest |
| `loyalty` | Loyalty / stamp card | On | Requires `customers` |
| `feedback` | Feedback after paying | On | Alerts a manager on a rating below 3 |
| `multilingual` | Multi-language menu | On | Add languages under Admin → Menu → Languages |
| `purchase_orders` | Purchase orders and receiving | On | Flags short deliveries and price rises |
| `shift_summary` | Summary at shift close | On | Sent on close — see 13.5 |
| `busy_mode` | Kitchen busy mode | On | Trips automatically at a ticket threshold |
| `time_pricing` | Happy hour / time-based prices | On | Changes the price shown, before any discount |

---

## 13.3 Receipts — email first, printing optional

**Receipts are emailed, not printed**, by default. Printing is still available
if you want it (`receipt_delivery`: `email` / `print` / `both` / `off`).

How the email address is captured, in order:

1. **The guest types it while ordering** on their phone — one optional field, no
   account, no password. Skippable.
2. **Staff enter it at payment** — the cashier gets an email field on the
   payment screen for guests who ordered at the table or counter.
3. **It's already on file** — if the guest is a known customer (feature 5), the
   address is filled in automatically and the cashier just confirms.
4. **Skip it** — "No receipt" is always one tap away and needs no reason. The
   order records `skip_reason: no_email` so your records show it was offered.

Every send attempt is logged in `receipts` with its status, so "did that
customer ever get their receipt?" is answerable months later. Failed sends
retry and then show up in the admin dashboard rather than disappearing.

**Kitchen slips print separately and switch off independently**
(`print_kitchen_slips`, default **off** since you have the kitchen screen). Turn
them on and every accepted order also prints a paper docket at the kitchen
printer — useful as a fallback if a tablet dies mid-service.

## 13.4 Takeaway and delivery — many pickup points

A venue can have **as many pickup points as you like**, each configured under
Admin → Venues → [venue] → Pickup points:

- Name and kind — front counter, side window, kiosk, locker, kerbside, or a
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

## 13.5 Shift summary — sent on close, with persistent stock problems

The summary is **sent the moment a shift is closed**, not on a nightly timer.
Whoever closes up triggers it by finishing the close wizard.

It contains:

- Sales, covers, average spend, and the split by payment method.
- Cash counted vs expected, and the variance.
- Voids, discounts and refunds, with who authorised them.
- Waste recorded during the shift.
- **Stock items reported low or out for 3 or more shifts running** — called out
  by name, with how many shifts and how long it's been that way. A single low
  reading is noise; the same item low four shifts running is either a supply
  problem or something worse, and it's exactly the thing that gets normalised
  and ignored on a dashboard. The threshold is configurable
  (`persistent_stock_threshold`, default 3).

The count lives on each ingredient (`consecutive_low_count`) and resets the
moment a count comes back healthy. Recipients are configured per person and per
channel — email, WhatsApp, SMS or push — under Admin → Settings → Reports. You
can also switch on a separate nightly digest if you want both.

## 13.6 The rest, briefly

- **Waste log** — staff record spoiled, dropped or binned food as it happens,
  with an optional photo and a cost. Kept separate from stock movements so
  "we threw it away" is never confused with "it went missing".
- **Clock in / out** — PIN-based, ties hours to shifts, and turns into staff
  cost as a percentage of sales.
- **Customer profiles** — built from a phone number or email given at ordering.
  Always optional for the guest.
- **Loyalty** — points or a "buy 9 get 1 free" stamp card, tracked
  automatically and shown on the receipt.
- **Feedback** — a one-tap rating after paying, linked to the order, the items
  and the server. Anything below 3 stars alerts a manager the same shift.
- **Multi-language** — a language picker on the customer menu; translations are
  stored per field so you translate only what you want to.
- **Purchase orders** — raise an order to a supplier, then tick off what
  actually arrived. Short deliveries and quiet price rises get flagged.
- **Busy mode** — when tickets waiting pass a threshold, customer orders are
  quoted a longer wait; past a second threshold they're held. Trips
  automatically or by hand from the kitchen screen.
- **Time-based prices** — happy hour and similar. This changes the price the
  customer *sees*; discounts (doc 14) reduce an already-priced bill. Keeping
  the two separate is what makes the reports honest.
