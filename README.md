# SNPOS — Restaurant POS on Appwrite

A multi-surface restaurant point-of-sale built entirely on Appwrite (Database,
Auth, Teams, Storage, Realtime, Functions). Covers QR self-ordering, kitchen
display with escalating alerts, shift/cash control, ingredient stock checks and
an accounting/analytics layer.

## Documentation

| Doc | Contents |
| --- | --- |
| [01 — Architecture](docs/01-architecture.md) | Surfaces, tech choices, Appwrite service usage, sync model |
| [02 — Data model](docs/02-data-model.md) | Every collection, attribute, index and permission |
| [03 — Feature specs](docs/03-feature-specs.md) | QR ordering, availability windows, add-ons, branding, payments |
| [04 — Kitchen & realtime](docs/04-kitchen-realtime.md) | Order sync, ping-until-acknowledged, reject reasons |
| [05 — Shifts, cash & stock](docs/05-shifts-cash-stock.md) | Open/close, expenses, float policy, stock check |
| [06 — Accounting & analytics](docs/06-accounting-analytics.md) | Ledger, dashboards, variance flagging |
| [07 — Roles & access](docs/07-roles-access.md) | Cook / waiter / cashier / manager / admin matrix |
| [08 — Deployment](docs/08-deployment.md) | **Step-by-step, stage by stage** |
| [09 — Open decisions](docs/09-open-decisions.md) | How the scope was decided (history) |
| [10 — Decisions log](docs/10-decisions-log.md) | What's been decided, in plain language |
| [11 — Offline mode](docs/11-offline-mode.md) | Working through an internet outage |
| [12 — Kitchen app](docs/12-kitchen-app.md) | Native Android app for the alarm |
| [13 — Features](docs/13-features.md) | Optional features, pre-ordering, and the admin switchboard |
| [14 — Discounts](docs/14-discounts.md) | Discounts, codes, and marking a bill paid |
| [15 — Manual console setup](docs/15-manual-console-setup.md) | Every collection, field and index, for building by hand |

## Confirmed decisions

1. **Payments are record-only.** Customers don't pay in the app; the POS records
   how each bill was settled (cash / card / mobile money / split) for shift
   reconciliation and accounting. Built so a gateway can be switched on later
   without redoing anything.
2. **Offline mode is in.** Service continues through an internet outage and
   catches up on reconnect — [doc 11](docs/11-offline-mode.md).
3. **Several venues.** Shared menu and recipes, separate staff/shifts/cash/stock
   and accounts per location, plus a group-wide comparison view.
4. **The kitchen screen is a native Android app**, so the alarm works with the
   tablet locked — [doc 12](docs/12-kitchen-app.md).
5. **Every optional feature is in, and every one is an admin toggle** —
   [doc 13](docs/13-features.md). Receipts are emailed rather than printed
   (kitchen slips print separately and switch off on their own); takeaway
   supports several pickup points per venue; the shift summary is sent the
   moment a shift closes, listing stock flagged for the first time and, in its
   own section, anything low or out for 3+ shifts running.
6. **Discounts and discount codes** — guests can type a code while ordering,
   staff apply discounts before payment, and **staff always mark the bill
   paid** — [doc 14](docs/14-discounts.md).
7. **Customers can order while the restaurant is closed**, choosing a time when
   it will be open. Pre-orders stay silent and invisible to the kitchen until
   the moment they need cooking — [doc 13.6](docs/13-features.md).

Still assumed, not yet confirmed: **Appwrite Cloud** for hosting (the
provisioning script works unchanged against a self-hosted instance).

Running on Appwrite's **free plan** works, with one adaptation: the plan allows
a single storage bucket, so all files share one with per-file permissions
instead of three separate buckets. See [doc 13.8](docs/13-features.md).

## Repo layout (target)

```
apps/
  menu/        Customer QR menu (public, no login)
  pos/         Waiter + cashier terminal
  kitchen/     Kitchen display system
  kitchen-android/  Capacitor shell around kitchen/ (alarm, wake, boot restart)
  admin/       Admin & manager dashboard
packages/
  core/        Shared SDK client, types, availability engine, money utils
  offline/     Local store, outbox queue, sync worker, conflict rules
  ui/          Themed component library (reads branding from settings)
functions/
  order-guard/          Server-side price + availability validation
  preorder-fire/        Releases scheduled orders to the kitchen at fire time
  kitchen-escalate/     Re-ping unacknowledged orders
  shift-close/          Post shift to ledger, depletion, variance flags
  stock-variance/       Nightly theoretical-vs-actual analysis
  payment-webhook/      Gateway callback (dormant until enabled)
scripts/
  provision.mjs         Creates every collection, attribute, index, bucket, team
  gen-manual-setup.mjs  Regenerates doc 15 from the schema (npm run gen:manual)
```
