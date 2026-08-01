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
| [09 — Open decisions](docs/09-open-decisions.md) | Features awaiting your confirmation |

## Assumptions made

These were the open questions; defaults chosen so the design is complete. Change
any of them and only the noted sections move.

1. **Appwrite Cloud** (`cloud.appwrite.io`) for hosting; the provisioning script
   and `appwrite.json` work unchanged against a self-hosted instance.
2. **PWA-first**: one React codebase for all four surfaces, installable on
   Android/iOS tablets. A thin native wrapper is only needed if the kitchen
   device must alarm with the screen locked (see doc 09).
3. **Payments are record-only, gateway-ready**: the POS records tender type for
   reconciliation; the schema and webhook function are shaped so Paystack or
   Stripe can be switched on without a migration.
4. **Tables + split bills are in core** (QR-per-table needs a table entity
   anyway). Loyalty, reservations, offline mode and printer/KDS hardware are in
   doc 09 pending your call.

## Repo layout (target)

```
apps/
  menu/        Customer QR menu (public, no login)
  pos/         Waiter + cashier terminal
  kitchen/     Kitchen display system
  admin/       Admin & manager dashboard
packages/
  core/        Shared SDK client, types, availability engine, money utils
  ui/          Themed component library (reads branding from settings)
functions/
  order-guard/          Server-side price + availability validation
  kitchen-escalate/     Re-ping unacknowledged orders
  shift-close/          Post shift to ledger, depletion, variance flags
  stock-variance/       Nightly theoretical-vs-actual analysis
  payment-webhook/      Gateway callback (dormant until enabled)
scripts/
  provision.mjs         Creates every collection, attribute, index, bucket, team
```
