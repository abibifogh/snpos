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

## Still open

- Which of the optional features in doc 09 to include.
- Whether the venue sharing rule above (shared menu / separate operations) is
  right for your locations.
