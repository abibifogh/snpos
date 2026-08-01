# 09 — Open decisions

You asked me to propose features from highly rated POS systems and have you
confirm which to include. The core design (docs 01–08) covers everything you
specified. Below is what I'd add, split by how strongly I'd argue for it.

Reply with the numbers you want and I'll fold them into the specs and the
provisioning script.

> **All of section B and C below are now confirmed** — every optional feature
> is in scope, and each one is an admin toggle. See [doc 13](13-features.md) for
> what they do and [doc 10](10-decisions-log.md) for the plain-language record.
> This doc is kept as the history of how the scope was decided; nothing on it is
> still awaiting an answer except the hosting question in the final section.

---

## A. Already folded into core (QR ordering doesn't work without them)

| # | Feature | Why it's not optional |
| --- | --- | --- |
| A1 | Tables, zones, table states, QR token rotation | A per-table QR needs a table entity and a revocable token |
| A2 | Split bills (by seat, item, evenly, amount) + tips | Ghana/most markets: groups split constantly; without it cashiers do maths on paper |
| A3 | Discounts, voids and 86-ing with reasons + limits | These are the three biggest shrinkage vectors; they need audit trails from day one |
| A4 | Manager PIN override on shared terminals | Otherwise every void needs a manager to log out and back in |

---

## B. Strongly recommended — say yes unless you have a reason

| # | Feature | Effort | What it buys you |
| --- | --- | --- | --- |
| ~~B1~~ | ~~Offline-first mode~~ | High | **CONFIRMED — in scope.** See doc 11 |
| ~~B2~~ | ~~Receipts and kitchen dockets~~ | Medium | **CONFIRMED (feature 1)** — changed to *email* receipts by default, with printing optional and kitchen slips separately switchable. Doc 13.3 |
| ~~B3~~ | ~~Native wrapper for the kitchen device~~ | Low–Medium | **CONFIRMED — in scope.** See doc 12 |
| ~~B4~~ | ~~Customer profiles + order history~~ | Medium | **CONFIRMED (feature 5)** |
| ~~B5~~ | ~~Purchase orders & goods-receiving~~ | Medium | **CONFIRMED (feature 9)** |
| ~~B6~~ | ~~Daily summary to the owner~~ | Low | **CONFIRMED (feature 10)** — sent immediately on shift close, and it names stock low/out for 3+ shifts running. Doc 13.5 |

---

## C. Worth having, lower urgency

| # | Feature | Notes |
| --- | --- | --- |
| ~~C1~~ | ~~Loyalty~~ | **CONFIRMED (feature 6)** |
| C2 | Reservations / booking calendar | **Still not in scope** — the only item from this list not selected. Say the word if you take bookings |
| ~~C3~~ | ~~Takeaway & delivery~~ | **CONFIRMED (feature 2)** — extended to allow many admin-defined pickup points per venue. Doc 13.4 |
| ~~C4~~ | ~~Multi-branch support~~ | **CONFIRMED — in scope**, already in the schema. Shared menu, separate operations — see doc 10 |
| ~~C5~~ | ~~Staff clock-in/out~~ | **CONFIRMED (feature 4)** |
| ~~C6~~ | ~~Waste log~~ | **CONFIRMED (feature 3)** |
| ~~C7~~ | ~~Happy-hour / time-based pricing~~ | **CONFIRMED (feature 12)** |
| ~~C8~~ | ~~Feedback after payment~~ | **CONFIRMED (feature 7)** |
| ~~C9~~ | ~~Kitchen capacity throttling~~ | **CONFIRMED (feature 11)** |
| ~~C10~~ | ~~Multi-language menu~~ | **CONFIRMED (feature 8)** |

---

## D. Deliberately excluded

| Feature | Why |
| --- | --- |
| Built-in payroll | Use dedicated software; the POS should export hours, not run payroll |
| Full inventory forecasting / auto-purchasing | Needs 6+ months of your data first. Revisit after go-live |
| Third-party delivery integrations (Bolt Food, Glovo) | Only worth it once you're actually on those platforms; each is a separate integration |

---

## Questions that change the design

1. ~~**Payments**~~ — **Answered: record-only.** The `payment-webhook` function
   ships dormant; no gateway onboarding needed.
2. **Appwrite Cloud or self-hosted?** Still open — I assumed Cloud. Self-hosting
   is cheaper at scale and keeps data local, but you own uptime, and a POS
   that's down is a restaurant that's closed. Cloud is the right default unless
   something forces otherwise.
3. ~~**One venue or several?**~~ — **Answered: several.** Now in the schema.
   Still open: whether "shared menu, separate operations" is the right sharing
   rule for your locations (doc 10, decision 3).
4. ~~**Offline mode**~~ — **Answered: yes.** See doc 11.

---

## Outcome

Everything above except C2 (reservations) is now in scope, and every one of them
is an **admin toggle** rather than a permanent commitment — see
[doc 13](13-features.md). Discounts and discount codes were added on top, with
payment always marked by staff: [doc 14](14-discounts.md).
