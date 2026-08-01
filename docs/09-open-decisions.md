# 09 — Open decisions

You asked me to propose features from highly rated POS systems and have you
confirm which to include. The core design (docs 01–08) covers everything you
specified. Below is what I'd add, split by how strongly I'd argue for it.

Reply with the numbers you want and I'll fold them into the specs and the
provisioning script.

> **Settled so far** (see [doc 10](10-decisions-log.md) for the plain-language
> version): payments are record-only, offline mode is **in**, multi-venue is
> **in**, and the kitchen alarm gets a native Android app. Items B1, B3 and C4
> below are therefore confirmed and no longer open.

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
| **B2** | **Thermal receipt printing** (80mm ESC/POS) + kitchen docket printing as a backup to the KDS | Medium | Customers ask for receipts; tax authorities require them; a printed docket saves you when the tablet dies |
| ~~B3~~ | ~~Native wrapper for the kitchen device~~ | Low–Medium | **CONFIRMED — in scope.** See doc 12 |
| **B4** | **Customer profiles + order history** (phone-identified) | Medium | Enables re-order, "your usual", and turns anonymous QR scans into a marketable customer list |
| **B5** | **Purchase orders & goods-receiving flow** | Medium | You already have purchases; adding PO → receive → invoice-match closes the loop and makes the variance analysis in doc 06 far more accurate |
| **B6** | **Daily summary email/push to the owner** (Appwrite Messaging) | Low | Sales, cash variance, flags — in your inbox at close without opening the dashboard |

---

## C. Worth having, lower urgency

| # | Feature | Notes |
| --- | --- | --- |
| C1 | Loyalty (points or digital stamp card) | Natural once B4 exists; drives repeat visits |
| C2 | Reservations / booking calendar | Only if you take bookings; otherwise skip |
| C3 | Takeaway & delivery flow with a pickup-time queue | Say yes if you do any off-premise trade |
| ~~C4~~ | ~~Multi-branch support~~ | **CONFIRMED — in scope**, already in the schema. Shared menu, separate operations — see doc 10 |
| C5 | Staff clock-in/out + labour cost as % of sales | Pairs with the hourly sales heatmap for rostering |
| C6 | Waste log (record spoilage as it happens) | Materially improves variance accuracy — B5 and this together explain most of your leakage |
| C7 | Happy-hour / time-based pricing | Reuses the availability engine; low extra cost |
| C8 | Customer feedback prompt after payment | One tap, feeds a rating per dish and per server |
| C9 | Kitchen capacity throttling | Auto-delays QR orders when the queue exceeds N tickets, instead of the kitchen drowning |
| C10 | Multi-language menu (English + local) | Straightforward: a translations map per item |

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
