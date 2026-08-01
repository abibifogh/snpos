# 09 — Open decisions

You asked me to propose features from highly rated POS systems and have you
confirm which to include. The core design (docs 01–08) covers everything you
specified. Below is what I'd add, split by how strongly I'd argue for it.

Reply with the numbers you want and I'll fold them into the specs and the
provisioning script.

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
| **B1** | **Offline-first mode** — local queue (IndexedDB) for ordering and billing, syncs to Appwrite on reconnect | High | This is the difference between a demo and a POS. When the internet drops mid-service, service continues. I'd rank this the single highest-value addition |
| **B2** | **Thermal receipt printing** (80mm ESC/POS) + kitchen docket printing as a backup to the KDS | Medium | Customers ask for receipts; tax authorities require them; a printed docket saves you when the tablet dies |
| **B3** | **Native wrapper for the kitchen device only** (Capacitor) | Low–Medium | Guarantees the alarm sounds with the screen off/locked and survives the browser tab being backgrounded. Browsers throttle background audio; this removes that risk entirely |
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
| C4 | Multi-branch support | Adds `venue_id` to every collection. **Cheap now, expensive later** — tell me if a second location is plausible within 2 years |
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

## Four questions that change the design

1. **Payments** — record-only (assumed), or should diners pay in-app? If in-app,
   **Paystack** is the right choice for Ghana/Nigeria (card + mobile money);
   Stripe if you're billing in USD/EUR. This decides whether
   `payment-webhook` ships live or dormant.
2. **Appwrite Cloud or self-hosted?** I assumed Cloud. Self-hosting is cheaper
   at scale and keeps data local, but you own uptime — and a POS that's down is
   a restaurant that's closed.
3. **One venue or several?** See C4 — retrofitting `venue_id` later means
   touching every collection and every query.
4. **B1 (offline mode)** — how bad is your internet? If it drops even weekly,
   B1 moves from "recommended" to "required", and it's better built into the
   data layer now than bolted on after.
