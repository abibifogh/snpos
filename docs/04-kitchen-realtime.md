# 04 — Kitchen display, realtime sync & the ping

## 4.1 Cross-device order sync

Every surface subscribes to the `orders` and `order_items` document channels.
An event carries the full document, so a client can update its cache directly;
it also invalidates the TanStack Query key so any derived view (open tickets,
table map, live sales tile) recomputes.

Ordering guarantees:

- Writes go through `order-guard` / status functions, so two waiters tapping
  "Accept" on the same ticket resolve deterministically — the function checks
  the current status and rejects an illegal transition (`ACCEPTED` → `PENDING`),
  returning the winning state.
- Each order carries `version` (int, incremented server-side). Clients drop an
  event whose `version` is lower than what they hold, which makes out-of-order
  websocket delivery harmless.
- On reconnect the client refetches open orders before re-subscribing, closing
  the gap window.

## 4.2 Kitchen Display System

Layout: ticket cards in a column grid, oldest first, colour-coded by age
(green < 5 min, amber < 10, red beyond), grouped by station when the device is
filtered to `hot` / `cold` / `bar`.

Card shows: order number, table/channel, elapsed timer, guest count, item lines
with add-ons and notes, allergy flags in high contrast, and the two primary
actions — **Accept** and **Reject**.

Per-item progress: a cook can mark individual lines `preparing` → `ready`; the
ticket auto-advances to `READY` when all its lines are ready, which notifies the
waiter's POS and the diner's phone.

Bump bar / keyboard shortcuts for gloved hands; large tap targets (min 64px);
screen wake lock so the tablet never sleeps mid-service.

## 4.3 The ping — escalating until acknowledged

**Requirement**: a new order pings the kitchen device *until* it is accepted or
rejected.

Client side (`apps/kitchen`):

1. A realtime `create` event for a `PENDING` order starts an alert loop.
2. The loop plays a sound via the Web Audio API on an interval, vibrates where
   supported, flashes the card and the document title, and shows a persistent
   full-width banner. It does **not** stop on its own.
3. It stops only when the order's status leaves `PENDING` — including when
   *another* kitchen device accepts it, because the stop is driven by the
   realtime event, not by the local button press.
4. Audio unlock: browsers block sound before a user gesture, so the KDS shows a
   one-tap "Start service" screen at shift start that unlocks an
   `AudioContext`; the app then monitors `audioContext.state` and re-shows the
   prompt if the OS suspends it. A silent-but-flashing kitchen is a failure
   mode, so the banner also shows "🔇 Sound blocked — tap to enable" whenever
   the context isn't running.
5. Sound files are cached by the service worker so a network blip never mutes
   the alarm.

Server side (`kitchen-escalate`, runs every minute):

| Elapsed since `PENDING` | Action |
| --- | --- |
| `kitchen_ack_sla_seconds` (default 60) | `alert_level` → 1: faster interval, louder tone |
| 2× SLA | `alert_level` → 2: continuous tone, card enlarges to full screen |
| 4× SLA | `alert_level` → 3: manager's POS and admin dashboard raise an alert |
| 8× SLA | `alert_level` → 4: push notification to manager devices; order flagged in the shift report |

Because escalation is a *server* field on the order, it survives a KDS tablet
reboot and it reaches the manager even if the kitchen device is off or asleep.

**Heartbeat**: each KDS device writes `last_seen` every 30s to a
`devices` document. If a station has open tickets and no heartbeat for 2
minutes, the manager dashboard shows "Kitchen display offline" — this catches
the silent failure where nobody is looking at the screen at all.

## 4.4 Accept / reject

**Accept** → status `ACCEPTED`, `accepted_by`/`accepted_at` set, ping stops
everywhere, diner's phone updates, prep timer starts from `prep_minutes`.

**Reject** → a modal that *cannot* be dismissed without a reason:

- Pick a `reject_reason_code`: out of stock, too busy, item unavailable, closing
  soon, duplicate, customer request, other.
- Free-text note optional, **mandatory when the code is `other`**
  (`settings.require_reject_reason` defaults true and only an admin may relax
  it).
- Optionally reject **individual lines** rather than the whole ticket — the
  common real case is one dish being off, not the order. Remaining lines
  proceed; the rejected line is voided with the reason and removed from the
  total.
- On reject: the diner's phone shows the reason plainly and offers a one-tap
  alternative from the same category; the waiter's POS raises a task; the
  reason is written to `audit_log` and rolls up in the shift report as
  "rejections by reason", which is the number that tells you whether your
  kitchen is under-stocked or under-staffed.
- If the reason is `out_of_stock`, the KDS offers "also mark this item 86'd" in
  the same modal — one tap removes it from every diner's phone.
