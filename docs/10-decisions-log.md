# 10 — Decisions log

A record of what was decided, when, and what it changed. Plain language — this
one is meant to be readable without being technical.

---

## Confirmed — 1 August 2026

### 1. Payments are record-only

Customers do **not** pay inside the app. Your existing card machine and mobile
money stay exactly as they are. The POS simply records *how* each bill was
settled — cash, card, mobile money, or a mix — so that the shift close and the
accounts add up.

*What this changes:* the online payment feature stays switched off. If you ever
change your mind, the system is already built to accept it without redoing
anything — it's a setting, not a rebuild.

### 2. Offline mode is on

The system keeps working when the internet drops. Staff can keep taking orders,
sending them to the kitchen and settling bills; everything catches up
automatically the moment the connection returns.

*What this changes:* every device keeps its own copy of today's menu, open
tables and orders. A small banner tells staff when they're offline and how many
orders are waiting to be sent, so nobody is guessing. Two devices editing the
same bill while offline is handled by a clear rule: the kitchen's view of what
was accepted always wins, and any conflict is shown to a manager rather than
silently picking a side.

*The honest limit:* the kitchen screen in one building cannot receive an order
from a phone in another building with no internet between them. Offline mode
keeps the restaurant running on its own network; it is not magic. Your table
QR ordering specifically needs customers to have internet on their own phones —
if your wifi is down for guests, waiters take the orders on the terminal
instead. Worth knowing before go-live.

### 3. Several venues

The system supports more than one restaurant location from day one.

*Chosen approach (change this if you disagree):* **shared menu, separate
operations.** You build the menu and recipes once and every venue uses it, with
each venue free to switch individual items off or set its own price. Everything
operational stays separate per venue — staff, shifts, cash drawers, expenses,
stock counts and accounts never mix. On top of that you get a group view that
compares venues side by side.

*What this changes:* every record now belongs to a venue. Staff are assigned to
one or more venues and only see theirs; managers see their venue; you see
everything. Adding venue number two later is now just a form, not a rebuild —
which is exactly why it was worth deciding now.

### 4. The kitchen alarm gets a proper app

The kitchen screen becomes a real installed Android app rather than a web page
in a browser.

*Why it matters:* web browsers deliberately quieten and slow down pages that
aren't in front. That's fine for a website and unacceptable for the one screen
that must scream when an order arrives. The app version keeps the alarm at full
volume with the screen off, survives the tablet being locked or the app being
minimised, restarts itself if the tablet reboots mid-service, and can override
the tablet's own volume setting so nobody can accidentally silence it.

*What this changes:* the kitchen tablet must be **Android** (any cheap 10" one
is fine). It installs from a file you copy across or from the Play Store —
covered step by step in the deployment doc. Everything else stays as a normal
web app. The kitchen app is a thin shell around the same screen, so it never
drifts out of step with the rest of the system.

---

### 5. Every optional feature is in — and every one is switchable

All twelve features offered are included, plus ordering-ahead (decision 11), and
**each one is an on/off switch an admin controls**, per venue if you want.
Nothing is welded in. Full list and what each does: [doc 13](13-features.md).

*What this changes:* turning something off hides it, it never deletes it — so
you can start simple, switch things on as you find you want them, and switch
them back off without losing what you recorded.

### 6. Receipts go by email, not paper

Instead of printing receipts, they're **emailed**. The guest can type their
address while ordering; if they didn't, the cashier can enter it at payment; if
neither, staff simply skip it and nothing is held up. Printing is still there as
an option if you ever want it.

**Kitchen slips print separately, and you can switch that off on its own** —
it's off by default, since you have the kitchen screen. Turn it on and every
accepted order also prints a paper docket, which is a useful fallback if a
tablet dies mid-service.

### 7. Takeaway can have several pickup points

You define as many collection points per venue as you need — front counter,
side window, a kiosk, kerbside, or a partner site across town. Each has its own
directions shown to the customer, its own opening hours and its own extra prep
time. The kitchen ticket shows which one, because handing food to the wrong
queue is *the* classic takeaway mistake.

### 8. The summary is sent at shift close, and splits stock two ways

Not a nightly timer — it goes out **the moment a shift is closed**, carrying
sales, cash variance, voids, discounts and waste.

Stock appears as **two separate sections**:

1. **New this shift** — everything reported low or out for the first time,
   listed in full. What to act on tonight.
2. **Ongoing** — a roll-up of anything low or out for **3 or more shifts
   running**, with how long it's been that way. What to make a decision about.

*Why keep them apart:* one low reading is normal operations. The same item low
four shifts running is either a supplier problem or someone helping themselves
— a different problem wearing the same clothes. Merged into one list, the second
kind disappears into the first. The threshold is adjustable if 3 turns out to be
too noisy, and either section can be switched off on its own.

### 9. Discounts and discount codes

You can create discounts of any shape — percent, fixed amount, free item, free
delivery — with limits on dates, times, minimum spend, how many times they can
be used, and which venues they apply to.

- **Guests** can type a **code** while ordering on their phone.
- **Staff** apply discounts after accepting the order and **before it's marked
  paid** — never after. A discount on a bill that's already settled is the
  oldest way cash walks out of a restaurant, so the system won't allow it;
  genuine after-the-fact cases go through a refund, which leaves its own trail.
- Each staff member has a discount ceiling; above it, a manager PIN is needed on
  the same screen. Everything is logged with who applied and who approved.

### 10. Staff mark bills as paid, always

Customers never settle a bill in the app — this follows from decision 1. Staff
record how each bill was paid, and only then does the receipt, loyalty and
feedback prompt fire.

This is enforced, not merely intended: the customer-facing app has no route
that can mark an order paid, and the permissions exclude guests entirely, so it
can't be done with a crafted request either. Details in
[doc 14](14-discounts.md).

### 11. Customers can order while you're closed

The menu stays open outside trading hours. A customer who scans a QR code or
opens the link at 11pm sees the full menu with a banner, builds their order, and
**picks a time when you'll be open** — rather than hitting a dead end and going
elsewhere.

*The important part:* the kitchen sees nothing. A pre-order is completely
silent — no alarm, no ticket, nothing in the queue — until the moment it needs
cooking, which the system works out by counting back from the requested time
using each dish's prep time. Nobody has to remember that something is due later.

*What this changes:* you'll need to set your **opening hours** per venue
(Admin → Venues → Hours) — the system can't offer sensible times without them.
You can cap how many orders any one time slot accepts, so ten people can't all
book 12:00 and swamp the pass. Prices are locked in at the time of ordering, and
if something sells out overnight staff are prompted to phone the customer rather
than the order quietly failing.

Ordering ahead works during service too ("I'll collect at 7pm"), and like
everything else it's a switch you can turn off.

---

## Still open

- **Hosting**: Appwrite Cloud (assumed) or self-hosted.
- Whether the venue sharing rule in decision 3 (shared menu / separate
  operations) is right for your locations.
- Reservations and table booking — the one feature offered that you didn't pick.
  Easy to add later if you start taking bookings.
