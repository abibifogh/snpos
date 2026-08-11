# 01, Architecture

## 1.1 Surfaces

Four apps, one shared data layer. Each is a separate build target so a kitchen
tablet never ships the admin bundle.

| Surface | Users | Auth | Notes |
| --- | --- | --- | --- |
| **Menu** (`menu.<domain>`) | Diners | Anonymous session | Opened by QR scan. No install, no account. |
| **POS** (`pos.<domain>`) | Waiters, cashiers | Email+password, then 4–6 digit PIN for fast user switch on a shared tablet | Installed as PWA, kiosk mode |
| **Kitchen** (`kds.<domain>`) | Cooks | Device account (one per station) | Always-on screen, wake lock, audio ping |
| **Admin** (`admin.<domain>`) | Managers, admins | Email+password + optional MFA | Branding, menus, accounting, reports |

## 1.2 Stack

- **React 18 + Vite + TypeScript**, one pnpm monorepo, four app targets.
- **TanStack Query** for server state; Appwrite Realtime pushes invalidate the
  relevant query keys, so every device converges without manual refresh logic.
- **Zustand** for local UI state (open ticket, cart, selected table).
- **vite-plugin-pwa** for service worker, install prompt and an offline shell.
- **Tailwind + CSS custom properties**, branding colours are injected at
  runtime as `--brand-primary` / `--brand-secondary`, so an admin colour change
  repaints every device on the next realtime tick without a rebuild.

Why one web codebase: the four surfaces share ~70% of their logic (money maths,
availability engine, order model, permission checks). Splitting into native apps
triples the release overhead for one genuine gain, reliable background alarms, 
which is addressed in doc 09.

## 1.3 Appwrite service usage

| Service | Used for |
| --- | --- |
| **Databases** | All business data, one database `snpos`, collections in doc 02 |
| **Auth** | Staff accounts; anonymous sessions for diners |
| **Teams** | Role assignment, `cooks`, `waiters`, `cashiers`, `managers`, `admins`. Collection permissions reference team IDs, so authorisation is enforced by the server, not the UI |
| **Storage** | `menu-images`, `branding`, `receipts` (expense photos) buckets |
| **Realtime** | Order sync, kitchen alerts, table status, settings/branding push |
| **Functions** | Server-authoritative logic, see below |
| **Messaging** | Optional email/SMS receipts (doc 09) |

## 1.4 Server-authoritative logic (Appwrite Functions)

Anything a diner's phone could lie about runs in a Function with an API key, not
in the client.

| Function | Trigger | Responsibility |
| --- | --- | --- |
| `order-guard` | HTTP, called by all clients to submit an order | Re-reads prices, add-on deltas, availability windows and stock from the DB; recomputes the total; rejects mismatches; assigns order number; writes the order + items atomically |
| `kitchen-escalate` | Schedule `* * * * *` | Finds orders `PENDING` past their acknowledgement SLA, increments `alert_level`, writes a realtime-visible update so kitchen devices escalate the ping; notifies a manager past level 3 |
| `shift-close` | HTTP, manager-only | Locks the shift, recomputes expected cash/card from payments, records variance, posts journal entries, applies theoretical stock depletion, snapshots the stock check |
| `stock-variance` | Schedule nightly | Compares theoretical usage (recipes × sales) to actual movement (counts + purchases) and raises `stock_flags` |
| `payment-webhook` | HTTP, gateway callback | Verifies signature, marks payment `CAPTURED`, releases the order to the kitchen. Dormant until a gateway is enabled |

Clients get **create** permission on very few collections. Orders are written
only by `order-guard`; payments only by POS users with a cashier role; ledger
entries only by functions.

## 1.5 Sync model

```
Client A writes ──► Appwrite Function ──► Database
                                            │
                                            └─► Realtime channel
                                                  ├─► Kitchen (new ticket + ping)
                                                  ├─► POS terminals (ticket state)
                                                  ├─► Diner phone (order accepted/rejected)
                                                  └─► Admin (live sales tiles)
```

Every client subscribes to:

- `databases.snpos.collections.orders.documents`, filtered client-side by
  `shift_id` (kitchen/POS) or `session_id` (diner).
- `databases.snpos.collections.order_items.documents`, item-level state.
- `databases.snpos.collections.settings.documents.main`, branding, currency,
  payment methods; applied live.

Reconnect handling: on `disconnected`, the client shows a banner and starts a
5-second poll; on reconnect it refetches the open-orders query before resuming
realtime, so no event dropped during the gap is lost.

Idempotency: every order submission carries a client-generated `idem_key`
(UUID). `order-guard` upserts on it, so a retry after a flaky connection can
never double-fire a ticket.

## 1.6 Money handling

All monetary values are stored as **integer minor units** (pesewas, cents) in
`integer` attributes, never floats. `packages/core/money.ts` owns formatting,
using `currency_code`, `currency_symbol`, `decimals` and `symbol_position` from
the settings document. Changing currency in admin changes display everywhere
instantly; it does **not** convert historical values, and the admin UI warns
about this before saving.
