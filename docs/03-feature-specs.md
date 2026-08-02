# 03 — Feature specs

## 3.1 Digital menu & QR ordering

**Flow**

1. Diner scans the table QR → `menu.<domain>/t/<qr_token>`.
2. App creates an **anonymous Appwrite session** (no signup), resolves the token
   to a table, and joins or opens a `dining_session`.
3. Menu renders from `categories` + `menu_items`, filtered through the
   availability engine (3.2) for *now* in `settings.timezone`.
4. Diner builds a cart with add-ons; the client shows a running total but the
   server recomputes it.
5. **Submit** → `order-guard` function → order created `PENDING` → kitchen pings.
6. Diner's phone subscribes to its own order and shows live status:
   *Sent → Accepted → Preparing → Ready*, or *Rejected: <reason>*.

**Guards**

- The token resolves server-side; an invalid or rotated token shows "Ask your
  server for a fresh code" rather than a raw error.
- Rate limit: max 3 open orders per anonymous session, max 40 items per order.
- If `dining_sessions.status != open`, ordering is blocked (table already
  billed) — the phone shows "Your bill has been requested".
- Optional **staff approval mode** (`settings`): QR orders land in a `PENDING`
  waiter queue instead of going straight to the kitchen. Useful when you don't
  yet trust the room.

**Table-shared cart**: several phones at one table write to the same
`dining_session`, each item tagged with the submitting anon user. The bill is
one ticket; split-by-seat still works because `order_items.seat_no` is set.

## 3.2 Availability windows (days & hours)

One JSON schema, used by both `categories.availability` and
`menu_items.availability`. Item rules **override** the category when present;
otherwise the item inherits. An item is available only if *both* its own rule
and its category's rule pass (a breakfast category can't leak into dinner).

```jsonc
{
  "mode": "always",              // "always" | "windows" | "never"
  "windows": [
    { "days": [1,2,3,4,5], "start": "07:00", "end": "11:30" },
    { "days": [6,0],       "start": "08:00", "end": "13:00" }
  ],
  "exceptions": [
    { "date": "2026-12-25", "available": false, "label": "Christmas" },
    { "date": "2026-08-04", "windows": [{ "start": "18:00", "end": "23:00" }] }
  ],
  "valid_from": "2026-08-01",     // optional seasonal menu
  "valid_to":   "2026-10-31"
}
```

- Days are `0` = Sunday … `6` = Saturday.
- Windows crossing midnight (`"start": "22:00", "end": "02:00"`) are supported
  and evaluated against the *service day*, not the calendar day.
- Evaluation lives in `packages/core/availability.ts` and is used identically by
  the menu app (to hide items), the POS (to grey them out but let a manager
  override), and `order-guard` (to reject). One implementation, three callers —
  no drift.
- Admin UI: a weekly grid where you drag time blocks per category, plus a
  per-item "inherit / custom / always / never" selector and a date-exception
  list. A live "available right now?" badge previews the result.

Unavailable items are **shown greyed with the next available time** ("Available
from 7:00 AM tomorrow") rather than hidden — it sells the return visit, and it's
configurable (`hide` vs `grey`) per category.

## 3.3 Add-ons with custom pricing

- Groups are reusable across items (`Sides`, `Cooking temperature`, `Extras`).
- `price_delta` may be **negative** (discount for removals) or zero (free
  choice like "medium rare").
- Per-item override on the join table lets the same option cost differently on
  different dishes.
- `min_select` / `max_select` / `required` drive validation on the client **and**
  in `order-guard`.
- `max_qty` per option allows "×3 extra shot".
- Add-ons can carry their own recipe rows, so "Extra cheese" depletes cheese
  stock and appears in variance analysis.
- Add-on prices display in the diner's configured currency with the correct
  symbol/decimals, and are snapshotted onto the order line.

## 3.4 Branding (colours, logos, currency)

Admin → Branding sets `primary_color`, `secondary_color`, `logo_light_id`,
`logo_dark_id`, `favicon_id`, plus currency code/symbol/decimals/position.

Implementation:

- Colours are written to CSS custom properties on `:root` at boot from the
  settings document, and re-applied on every realtime update of that document —
  so a colour change propagates to all devices within a second, no redeploy.
- The UI palette is generated from the two brand colours (tints, shades,
  hover/active states) so a single hex produces a coherent theme.
- **Contrast guard**: the admin picker computes WCAG contrast for text on each
  brand colour and blocks a save that would render buttons unreadable, offering
  the nearest passing shade.
- Logos are uploaded to the `branding` bucket and served through Appwrite's
  image transformation endpoint at the size each surface needs.
- Currency change warns that it is display-only and does not convert history.

## 3.5 Menu images that format well on phones

- Upload at any size; the client **enforces a 4:3 crop** with a draggable focal
  point, stored as `image_focal_x/_y`.
- Delivery via Appwrite Storage `getFilePreview` with explicit
  `width`/`height`/`gravity`/`quality`/`output=webp`, so the phone downloads a
  ~40 KB image, not the 6 MB original.
- Responsive `srcSet` at 1×/2×/3× for card (320w), row (160w) and hero (768w)
  slots; `sizes` matches the grid.
- `aspect-ratio: 4/3` + `object-fit: cover` + `object-position` from the focal
  point means **no layout shift and no awkward crops** on any screen width.
- Blurred low-quality placeholder (16px preview, upscaled) while loading;
  `loading="lazy"` and `decoding="async"` below the fold.
- Upload validation: reject > 10 MB, auto-downscale to max 2000px before upload,
  strip EXIF (which also strips location data from staff phone photos).
- A "preview on phone" pane in admin renders the exact card at 390px width.

## 3.6 Payment options

Payment methods are data, not code (`payment_methods` collection). Admin can
add, rename, reorder, disable, and set per-method behaviour: whether it opens a
cash drawer, whether it demands a reference, whether it's blind-counted at shift
close, and an optional surcharge.

- **Split payments**: an order can carry many `payments` rows; the POS shows
  remaining balance until it reaches zero.
- **Split the bill**: by seat, by item, evenly by N, or by arbitrary amount.
- **Tips** are captured per payment and posted to `2200 Tips payable`, never to
  revenue.
- **Refunds** create a negative payment linked via `refund_of`, always inside a
  shift, always with a reason and a manager approval.
- **Gateway-ready**: `gateway` on the method plus `payments.status` and the
  dormant `payment-webhook` function mean enabling Paystack or Stripe later is
  configuration plus one function deploy — no schema migration.

## 3.7 Other core service features

- **Order modification**: add items to an open ticket, fire courses separately,
  void a line with a reason (manager PIN above a threshold), transfer a ticket
  to another table, merge/split tables.
- **Discounts**: percentage or fixed, item-level or order-level, each with a
  reason code, capped per role by `staff_profiles.can_discount_up_to_bp`, all
  written to `audit_log`.
- **86 / sold out**: one tap in the POS sets `sold_out_until`, instantly
  removing the item from every diner's phone.
- **Receipts**: print-ready HTML receipt (58/80mm CSS) plus a QR to a hosted
  receipt page; email/SMS is available via Appwrite Messaging if enabled.

## Group orders

Off by default. Turned on, the customer menu gains a **Group order** switch
beside the ordinary menu.

- Categories and dishes flagged **group orders only** appear on that menu and
  nowhere else. A hotel party ordering platters does not want the à la carte
  list, and a walk-in should not be offered a set meal for twenty.
- The guest is asked for a booking reference — labelled "Hotel reservation
  number" by default, changeable — and how many people. Both are configurable
  as required or optional under Admin → Features.
- When the order arrives, an email goes out immediately to whoever is listed
  (falling back to the shift-summary recipients). A party of twenty is a
  kitchen planning decision, not just another ticket.
- The kitchen ticket carries the reference and the head count.
- The guest is emailed again when the kitchen accepts, which is the ordinary
  accepted-order email doing its job.

## Tables and areas

Somewhere to sit is not always a table. Under Admin → Tables & QR each entry
is either a **table** or an **area** — poolside, lounge, terrace. An area has
no number and no fixed seat count; what the kitchen needs is somewhere to send
the waiter, and an area answers that as well as a table does.

A guest who arrives without scanning a table QR code is asked where they are
sitting, choosing from anything marked selectable. When they pick an area they
can add a line of their own — "by the pool bar, blue umbrella" — which is the
only thing that gets the food to the right people, and it prints on the ticket.

## Order numbers

Under Admin → Settings → Order numbers: the prefix, how many digits, and
whether numbering runs continuously or starts again each morning. **Restart
from here** sets the next number without touching any order already placed.

These get shouted across a pass. A kitchen counting to four digits forever is
being made to work around the software rather than the other way round.

