# 15 — Manual setup in the Appwrite console

Everything to create by hand, in order. Generated from `scripts/schema.mjs`,
so it matches exactly what `npm run provision` would have built.

> **Before you start, read this.**
>
> This is **60 collections, 793 fields and 195 indexes**. Entered by hand at a
> realistic pace that is somewhere between 8 and 15 hours of clicking, and a
> single mistyped field name will surface later as a broken screen rather than
> an error at the time. The script does the same work in about four minutes and
> is safe to re-run.
>
> If the terminal is the obstacle, the shortest path is still
> `npm run provision` on any computer (see doc 08, Stage 2) — it needs Node
> installed and nothing else. This document exists because you asked for it, and
> it is complete and correct; it is just the expensive way to get there.
>
> **Work top to bottom.** Later steps reference IDs created in earlier ones.

**Conventions used below**

- **ID** means the "Collection ID" / "Attribute Key" field — type it exactly,
  lowercase, underscores not spaces. The apps look these up by ID.
- **Required** columns marked **Yes** must be ticked. Appwrite will not let you
  set a default on a required field — that is expected, not a mistake.
- **Default `—`** means leave the default box empty.
- **Array Yes** means tick "Array".
- Enum values are comma-separated; enter them one per row in the console.
  A value shown as `(blank)` means add an empty option.

---

## Stage 1 — Project settings

In your existing project (ID `6a6e308e00234b152989`, Frankfurt region):

1. **Settings → Platforms → Add platform → Web app**, four times:

   | Name | Hostname (for now) |
   | --- | --- |
   | `menu` | `localhost` |
   | `pos` | `localhost` |
   | `kds` | `localhost` |
   | `admin` | `localhost` |

   Add the real domains later. Appwrite rejects connections from any origin
   not listed here, so skipping this makes everything fail with a CORS error.

2. **Auth → Settings**:
   - Enable **Email/Password**.
   - Enable **Anonymous** — the customer QR menu needs it; without it, guests
     cannot order at all.
   - Set **Session length** to 1 year (staff devices stay logged in).
   - Disable every provider you do not use.

3. **Settings → API keys → Create API key**, name `server-functions`, scopes:
   `databases.read`, `databases.write`, `collections.read`, `collections.write`,
   `attributes.read`, `attributes.write`, `indexes.read`, `indexes.write`,
   `documents.read`, `documents.write`, `users.read`, `users.write`,
   `teams.read`, `teams.write`, `files.read`, `files.write`.
   Copy the secret immediately — it is shown once.

---

## Stage 2 — Teams

**Auth → Teams → Create team**, five times. The Team ID matters — permissions
below refer to it.

| Team ID | Name |
| --- | --- |
| `cooks` | Cooks |
| `waiters` | Waiters |
| `cashiers` | Cashiers |
| `managers` | Managers |
| `admins` | Admins |

---

## Stage 3 — Storage buckets

**Storage → Create bucket**, three times.

### Bucket `menu-images` — Menu images

- **Maximum file size**: 10 MB
- **Allowed file extensions**: jpg, jpeg, png, webp, avif
- **Permissions** — Read: Any · Create/Update/Delete: Team: managers, Team: admins
- Leave encryption and antivirus on (the defaults).

### Bucket `branding` — Branding

- **Maximum file size**: 5 MB
- **Allowed file extensions**: jpg, jpeg, png, webp, svg, ico
- **Permissions** — Read: Any · Create/Update/Delete: Team: admins
- Leave encryption and antivirus on (the defaults).

### Bucket `receipts` — Expense receipts

- **Maximum file size**: 10 MB
- **Allowed file extensions**: jpg, jpeg, png, webp, pdf
- **Permissions** — Read: Team: managers, Team: admins · Create/Update/Delete: Team: cashiers, Team: managers, Team: admins
- Leave encryption and antivirus on (the defaults).

---

## Stage 4 — Database

**Databases → Create database** → Name `NiceOps POS`, **Database ID `snpos`**.

The ID must be exactly this — the apps read it from `DB_ID` in the settings
file and will not find anything otherwise.

---

## Stage 5 — Collections

For each collection below:

1. **Create collection** with the exact **Collection ID** shown.
2. Open **Settings → Permissions** and set the four rows as listed.
3. Add every attribute from the table, in order.
4. Add every index from the index table.

Attributes are created asynchronously. If an index refuses to save with
"attribute not available", wait ten seconds and try again — the attribute is
still being built.

There are 60 collections. A progress checklist is at the end of this document.

---

### 1. `venues` — Venues

**Read**: Any · **Create**: Team: admins · **Update**: Team: admins · **Delete**: Team: admins

**Attributes** (19)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `name` | String | size 120 | **Yes** | — | No |
| `slug` | String | size 60 | **Yes** | — | No |
| `address` | String | size 300 | No | — | No |
| `phone` | String | size 40 | No | — | No |
| `timezone` | String | size 64 | **Yes** | — | No |
| `active` | Boolean | — | **Yes** | — | No |
| `sort` | Integer | — | **Yes** | — | No |
| `primary_color` | String | size 9 | No | — | No |
| `secondary_color` | String | size 9 | No | — | No |
| `logo_light_id` | String | size 64 | No | — | No |
| `shift_float_policy` | Enum | inherit, zero, carry_over, fixed, prompt | **Yes** | — | No |
| `shift_float_default` | Integer | — | **Yes** | — | No |
| `order_number_prefix` | String | size 8 | No | — | No |
| `tax_rate_bp` | Integer | — | No | — | No |
| `opening_hours` | String | size 4000 | No | — | No |
| `holiday_closures` | String | size 4000 | No | — | No |
| `walkin_token` | String | size 64 | No | — | No |
| `group_token` | String | size 64 | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `slug_unique` | unique | `slug` |
| `active_sort` | key | `active`, `sort` |
| `org` | key | `org_id` |

---

### 2. `venue_menu_items` — Venue menu overrides

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (7)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `menu_item_id` | String | size 64 | **Yes** | — | No |
| `available` | Boolean | — | **Yes** | — | No |
| `price_override` | Integer | — | No | — | No |
| `sold_out_until` | Datetime | — | No | — | No |
| `availability_override` | String | size 4000 | No | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue_item` | unique | `venue_id`, `menu_item_id` |
| `org` | key | `org_id` |

---

### 3. `organisations` — Organisations

**Read**: All users · **Create**: _none — server only_ · **Update**: _none — server only_ · **Delete**: _none — server only_

**Attributes** (13)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `name` | String | size 160 | **Yes** | — | No |
| `slug` | String | size 60 | **Yes** | — | No |
| `team_id` | String | size 64 | **Yes** | — | No |
| `status` | Enum | trial, active, overdue, suspended, closed | **Yes** | — | No |
| `plan` | String | size 40 | No | — | No |
| `trial_ends_at` | Datetime | — | No | — | No |
| `owner_email` | String | size 160 | **Yes** | — | No |
| `owner_name` | String | size 160 | No | — | No |
| `country` | String | size 60 | No | — | No |
| `phone` | String | size 40 | No | — | No |
| `tools` | String | size 40 | No | — | Yes |
| `note` | String | size 1000 | No | — | No |
| `suspended_reason` | String | size 300 | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `slug_unique` | unique | `slug` |
| `team` | key | `team_id` |
| `status` | key | `status` |

---

### 4. `org_requests` — Setup requests

**Read**: _none — server only_ · **Create**: Any · **Update**: _none — server only_ · **Delete**: _none — server only_

**Attributes** (10)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `hotel_name` | String | size 160 | **Yes** | — | No |
| `contact_name` | String | size 160 | **Yes** | — | No |
| `email` | String | size 160 | **Yes** | — | No |
| `phone` | String | size 40 | No | — | No |
| `country` | String | size 60 | No | — | No |
| `rooms` | String | size 40 | No | — | No |
| `tools` | String | size 40 | No | — | Yes |
| `message` | String | size 2000 | No | — | No |
| `status` | Enum | new, contacted, approved, declined | **Yes** | — | No |
| `org_id_created` | String | size 64 | No | — | No |

**Indexes** (1)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `status_new` | key | `status` |

---

### 5. `settings` — Settings

**Read**: Any · **Create**: _none — server only_ · **Update**: Team: admins · **Delete**: _none — server only_

**Attributes** (48)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `restaurant_name` | String | size 120 | **Yes** | — | No |
| `timezone` | String | size 64 | **Yes** | — | No |
| `currency_code` | String | size 3 | **Yes** | — | No |
| `currency_symbol` | String | size 8 | **Yes** | — | No |
| `currency_decimals` | Integer | — | **Yes** | — | No |
| `symbol_position` | Enum | before, after | **Yes** | — | No |
| `primary_color` | String | size 9 | **Yes** | — | No |
| `secondary_color` | String | size 9 | **Yes** | — | No |
| `accent_color` | String | size 9 | No | — | No |
| `logo_light_id` | String | size 64 | No | — | No |
| `logo_dark_id` | String | size 64 | No | — | No |
| `favicon_id` | String | size 64 | No | — | No |
| `tax_rate_bp` | Integer | — | **Yes** | — | No |
| `tax_inclusive` | Boolean | — | **Yes** | — | No |
| `service_charge_bp` | Integer | — | **Yes** | — | No |
| `shift_float_policy` | Enum | zero, carry_over, fixed, prompt | **Yes** | — | No |
| `shift_float_default` | Integer | — | **Yes** | — | No |
| `allow_negative_cash` | Boolean | — | No | false | No |
| `kitchen_ack_sla_seconds` | Integer | — | **Yes** | — | No |
| `kitchen_ping_max_level` | Integer | — | **Yes** | — | No |
| `require_reject_reason` | Boolean | — | **Yes** | — | No |
| `qr_orders_need_approval` | Boolean | — | **Yes** | — | No |
| `order_number_prefix` | String | size 8 | No | ORD | No |
| `order_number_mode` | Enum | continuous, daily | No | continuous | No |
| `order_number_next` | Integer | — | No | 1 | No |
| `order_number_padding` | Integer | — | No | 4 | No |
| `order_number_reset_on` | Datetime | — | No | — | No |
| `tips_enabled` | Boolean | — | No | true | No |
| `tips_ask_on` | Enum | both, till, kitchen, none | No | both | No |
| `expense_paid_from` | Enum | cash_only, any | No | cash_only | No |
| `low_stock_default_bp` | Integer | — | **Yes** | — | No |
| `stock_check_mode` | Enum | levels, counts | No | levels | No |
| `stock_count_decimals` | Boolean | — | No | true | No |
| `stock_variance_threshold_bp` | Integer | — | **Yes** | — | No |
| `stock_variance_value_floor` | Integer | — | **Yes** | — | No |
| `expense_approval_threshold` | Integer | — | **Yes** | — | No |
| `cash_variance_tolerance` | Integer | — | **Yes** | — | No |
| `terminal_idle_lock_seconds` | Integer | — | **Yes** | — | No |
| `default_locale` | String | size 10 | No | en | No |
| `enabled_locales` | String | size 10 | No | — | Yes |
| `email_from_name` | String | size 120 | No | — | No |
| `email_from_address` | String | size 160 | No | — | No |
| `email_reply_to` | String | size 160 | No | — | No |
| `storage_mode` | Enum | multi, single | No | multi | No |
| `shared_bucket_id` | String | size 64 | No | — | No |
| `role_access` | String | size 2000 | No | — | No |
| `daily_report_hour` | Integer | — | No | 23 | No |

**Indexes** (1)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `org` | key | `org_id` |

---

### 6. `payment_methods` — Payment methods

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: admins · **Update**: Team: admins · **Delete**: Team: admins

**Attributes** (11)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `name` | String | size 40 | **Yes** | — | No |
| `kind` | Enum | cash, card, mobile_money, voucher, on_account | **Yes** | — | No |
| `enabled` | Boolean | — | **Yes** | — | No |
| `sort` | Integer | — | **Yes** | — | No |
| `opens_cash_drawer` | Boolean | — | **Yes** | — | No |
| `requires_reference` | Boolean | — | **Yes** | — | No |
| `counted_at_close` | Boolean | — | **Yes** | — | No |
| `gateway` | Enum | none, paystack, stripe | **Yes** | — | No |
| `surcharge_bp` | Integer | — | **Yes** | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `enabled_sort` | key | `enabled`, `sort` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 7. `categories` — Categories

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (11)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `name` | String | size 120 | **Yes** | — | No |
| `description` | String | size 500 | No | — | No |
| `sort` | Integer | — | **Yes** | — | No |
| `image_id` | String | size 64 | No | — | No |
| `active` | Boolean | — | **Yes** | — | No |
| `availability` | String | size 4000 | No | — | No |
| `unavailable_display` | Enum | grey, hide | **Yes** | — | No |
| `station` | Enum | hot, cold, bar, dessert | **Yes** | — | No |
| `station_key` | String | size 40 | No | — | No |
| `group_only` | Boolean | — | No | false | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `active_sort` | key | `active`, `sort` |
| `org` | key | `org_id` |

---

### 8. `menu_items` — Menu items

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (22)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `category_id` | String | size 64 | **Yes** | — | No |
| `name` | String | size 160 | **Yes** | — | No |
| `description` | String | size 1000 | No | — | No |
| `price` | Integer | — | **Yes** | — | No |
| `image_id` | String | size 64 | No | — | No |
| `image_focal_x` | Float | — | **Yes** | — | No |
| `image_focal_y` | Float | — | **Yes** | — | No |
| `sku` | String | size 40 | No | — | No |
| `active` | Boolean | — | **Yes** | — | No |
| `availability` | String | size 4000 | No | — | No |
| `sold_out_until` | Datetime | — | No | — | No |
| `prep_minutes` | Integer | — | **Yes** | — | No |
| `station` | Enum | hot, cold, bar, dessert, inherit | **Yes** | — | No |
| `station_key` | String | size 40 | No | — | No |
| `unavailable_since` | Datetime | — | No | — | No |
| `unavailable_by` | String | size 64 | No | — | No |
| `unavailable_reason` | String | size 200 | No | — | No |
| `group_only` | Boolean | — | No | false | No |
| `tags` | String | size 40 | No | — | Yes |
| `sort` | Integer | — | **Yes** | — | No |
| `track_stock` | Boolean | — | **Yes** | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `category_active` | key | `category_id`, `active` |
| `name_search` | fulltext | `name` |
| `org` | key | `org_id` |

---

### 9. `menu_item_categories` — Menu item categories

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (5)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `menu_item_id` | String | size 64 | **Yes** | — | No |
| `category_id` | String | size 64 | **Yes** | — | No |
| `sort` | Integer | — | No | 0 | No |
| `active` | Boolean | — | No | true | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `item_category` | unique | `menu_item_id`, `category_id` |
| `category` | key | `category_id`, `sort` |
| `item` | key | `menu_item_id` |
| `org` | key | `org_id` |

---

### 10. `stations` — Stations

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (7)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `key` | String | size 40 | **Yes** | — | No |
| `name` | String | size 80 | **Yes** | — | No |
| `colour` | String | size 9 | No | — | No |
| `sort` | Integer | — | No | 0 | No |
| `active` | Boolean | — | No | true | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue_key` | unique | `venue_id`, `key` |
| `venue_sort` | key | `venue_id`, `sort` |
| `org` | key | `org_id` |

---

### 11. `addon_groups` — Add-on groups

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (7)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `name` | String | size 120 | **Yes** | — | No |
| `description` | String | size 300 | No | — | No |
| `min_select` | Integer | — | **Yes** | — | No |
| `max_select` | Integer | — | **Yes** | — | No |
| `required` | Boolean | — | **Yes** | — | No |
| `sort` | Integer | — | **Yes** | — | No |

**Indexes** (1)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `org` | key | `org_id` |

---

### 12. `addon_options` — Add-on options

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (8)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `group_id` | String | size 64 | **Yes** | — | No |
| `name` | String | size 120 | **Yes** | — | No |
| `price_delta` | Integer | — | **Yes** | — | No |
| `active` | Boolean | — | **Yes** | — | No |
| `sort` | Integer | — | **Yes** | — | No |
| `default_selected` | Boolean | — | **Yes** | — | No |
| `max_qty` | Integer | — | **Yes** | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `group` | key | `group_id`, `sort` |
| `org` | key | `org_id` |

---

### 13. `menu_item_addon_groups` — Item add-on links

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (6)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `menu_item_id` | String | size 64 | **Yes** | — | No |
| `group_id` | String | size 64 | **Yes** | — | No |
| `sort` | Integer | — | **Yes** | — | No |
| `price_delta_override` | Integer | — | No | — | No |
| `required_override` | Boolean | — | No | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `item` | key | `menu_item_id`, `sort` |
| `org` | key | `org_id` |

---

### 14. `tables` — Tables and areas

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (13)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `label` | String | size 40 | **Yes** | — | No |
| `zone` | String | size 60 | No | — | No |
| `kind` | Enum | table, area | No | table | No |
| `guest_selectable` | Boolean | — | No | true | No |
| `seats` | Integer | — | **Yes** | — | No |
| `qr_token` | String | size 64 | **Yes** | — | No |
| `status` | Enum | free, seated, ordered, bill_requested, dirty | **Yes** | — | No |
| `current_order_id` | String | size 64 | No | — | No |
| `current_session_id` | String | size 64 | No | — | No |
| `active` | Boolean | — | **Yes** | — | No |
| `sort` | Integer | — | **Yes** | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `qr_token_unique` | unique | `qr_token` |
| `zone_sort` | key | `zone`, `sort` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 15. `dining_sessions` — Dining sessions

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: All users · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: _none — server only_

**Attributes** (9)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `table_id` | String | size 64 | **Yes** | — | No |
| `opened_at` | Datetime | — | **Yes** | — | No |
| `closed_at` | Datetime | — | No | — | No |
| `guest_count` | Integer | — | **Yes** | — | No |
| `anon_user_ids` | String | size 64 | No | — | Yes |
| `status` | Enum | open, billing, closed | **Yes** | — | No |
| `shift_id` | String | size 64 | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `table_status` | key | `table_id`, `status` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 16. `orders` — Orders

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: All users · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: _none — server only_

**Attributes** (61)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `order_no` | String | size 20 | **Yes** | — | No |
| `idem_key` | String | size 64 | **Yes** | — | No |
| `version` | Integer | — | **Yes** | — | No |
| `channel` | Enum | qr, waiter, counter, takeaway, delivery | **Yes** | — | No |
| `table_id` | String | size 64 | No | — | No |
| `session_id` | String | size 64 | No | — | No |
| `shift_id` | String | size 64 | No | — | No |
| `status` | Enum | SCHEDULED, PENDING, ACCEPTED, PREPARING, READY, SERVED, CLOSED, REJECTED, CANCELLED | **Yes** | — | No |
| `alert_level` | Integer | — | **Yes** | — | No |
| `accepted_at` | Datetime | — | No | — | No |
| `accepted_by` | String | size 64 | No | — | No |
| `rejected_at` | Datetime | — | No | — | No |
| `rejected_by` | String | size 64 | No | — | No |
| `reject_reason_code` | Enum | out_of_stock, too_busy, item_unavailable, closing_soon, duplicate, customer_request, cannot_meet_slot, other | No | — | No |
| `reject_reason_note` | String | size 500 | No | — | No |
| `subtotal` | Integer | — | **Yes** | — | No |
| `discount_total` | Integer | — | **Yes** | — | No |
| `tax_total` | Integer | — | **Yes** | — | No |
| `service_total` | Integer | — | **Yes** | — | No |
| `tip_total` | Integer | — | **Yes** | — | No |
| `total` | Integer | — | **Yes** | — | No |
| `currency_code` | String | size 3 | **Yes** | — | No |
| `payment_status` | Enum | unpaid, partial, paid, refunded | **Yes** | — | No |
| `placed_by` | String | size 80 | **Yes** | — | No |
| `guest_count` | Integer | — | **Yes** | — | No |
| `notes` | String | size 500 | No | — | No |
| `seat_note` | String | size 200 | No | — | No |
| `is_group` | Boolean | — | No | false | No |
| `group_reference` | String | size 60 | No | — | No |
| `group_size` | Integer | — | No | 0 | No |
| `group_contact_name` | String | size 120 | No | — | No |
| `marked_paid_by` | String | size 64 | No | — | No |
| `marked_paid_at` | Datetime | — | No | — | No |
| `served_at` | Datetime | — | No | — | No |
| `fired_at` | Datetime | — | No | — | No |
| `customer_id` | String | size 64 | No | — | No |
| `customer_name` | String | size 160 | No | — | No |
| `customer_phone` | String | size 40 | No | — | No |
| `customer_email` | String | size 160 | No | — | No |
| `email_source` | Enum | guest_at_order, staff_entered, customer_profile, declined | No | — | No |
| `locale` | String | size 10 | No | — | No |
| `fulfilment` | Enum | dine_in, takeaway, delivery | No | dine_in | No |
| `pickup_point_id` | String | size 64 | No | — | No |
| `is_preorder` | Boolean | — | No | false | No |
| `scheduled_for` | Datetime | — | No | — | No |
| `fire_at` | Datetime | — | No | — | No |
| `slot_id` | String | size 64 | No | — | No |
| `placed_while_closed` | Boolean | — | No | false | No |
| `delivery_zone_id` | String | size 64 | No | — | No |
| `delivery_address` | String | size 500 | No | — | No |
| `delivery_fee` | Integer | — | No | 0 | No |
| `delivery_status` | Enum | pending, ready, dispatched, delivered, failed | No | — | No |
| `driver_name` | String | size 120 | No | — | No |
| `quoted_wait_minutes` | Integer | — | No | — | No |
| `eta_minutes` | Integer | — | No | — | No |
| `prep_minutes` | Integer | — | No | — | No |
| `discounts_applied` | String | size 4000 | No | — | No |
| `loyalty_points_earned` | Integer | — | No | 0 | No |
| `loyalty_points_redeemed` | Integer | — | No | 0 | No |

**Indexes** (13)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `idem_unique` | unique | `idem_key` |
| `order_no_unique` | unique | `venue_id`, `order_no` |
| `order_no` | key | `order_no` |
| `shift_status` | key | `shift_id`, `status` |
| `status_created` | key | `status`, `$createdAt` |
| `session` | key | `session_id` |
| `table` | key | `table_id` |
| `fulfilment_status` | key | `venue_id`, `fulfilment`, `status` |
| `pickup_point` | key | `pickup_point_id`, `scheduled_for` |
| `due` | key | `venue_id`, `status`, `fire_at` |
| `customer` | key | `customer_id` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 17. `order_items` — Order items

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: All users · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins

**Attributes** (19)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `order_id` | String | size 64 | **Yes** | — | No |
| `menu_item_id` | String | size 64 | **Yes** | — | No |
| `name_snapshot` | String | size 160 | **Yes** | — | No |
| `unit_price` | Integer | — | **Yes** | — | No |
| `qty` | Integer | — | **Yes** | — | No |
| `addons` | String | size 2000 | No | — | No |
| `line_total` | Integer | — | **Yes** | — | No |
| `notes` | String | size 300 | No | — | No |
| `station` | Enum | hot, cold, bar, dessert | **Yes** | — | No |
| `station_key` | String | size 40 | No | — | No |
| `status` | Enum | queued, preparing, ready, served, void | **Yes** | — | No |
| `due_at` | Datetime | — | No | — | No |
| `prep_minutes` | Integer | — | No | — | No |
| `void_reason` | String | size 300 | No | — | No |
| `voided_by` | String | size 64 | No | — | No |
| `course` | Integer | — | **Yes** | — | No |
| `seat_no` | Integer | — | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `order` | key | `order_id` |
| `station_status` | key | `station`, `status` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 18. `payments` — Payments

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: _none — server only_

**Attributes** (16)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `order_id` | String | size 64 | **Yes** | — | No |
| `shift_id` | String | size 64 | **Yes** | — | No |
| `method_id` | String | size 64 | **Yes** | — | No |
| `method_kind_snapshot` | String | size 20 | **Yes** | — | No |
| `amount` | Integer | — | **Yes** | — | No |
| `tip` | Integer | — | **Yes** | — | No |
| `change_given` | Integer | — | **Yes** | — | No |
| `reference` | String | size 120 | No | — | No |
| `status` | Enum | pending, captured, failed, refunded, voided | **Yes** | — | No |
| `gateway_ref` | String | size 120 | No | — | No |
| `gateway_payload` | String | size 4000 | No | — | No |
| `taken_by` | String | size 64 | **Yes** | — | No |
| `refund_of` | String | size 64 | No | — | No |
| `refund_reason` | String | size 300 | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `order` | key | `order_id` |
| `shift_status` | key | `shift_id`, `status` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 19. `shifts` — Shifts

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: _none — server only_

**Attributes** (28)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `code` | String | size 40 | **Yes** | — | No |
| `status` | Enum | open, closing, closed, reopened | **Yes** | — | No |
| `opened_by` | String | size 64 | **Yes** | — | No |
| `opened_at` | Datetime | — | **Yes** | — | No |
| `opening_floats` | String | size 2000 | **Yes** | — | No |
| `float_source` | Enum | zero, manual, carried_over | **Yes** | — | No |
| `carried_from_shift_id` | String | size 64 | No | — | No |
| `carry_approved_by` | String | size 64 | No | — | No |
| `closed_by` | String | size 64 | No | — | No |
| `closed_at` | Datetime | — | No | — | No |
| `expected` | String | size 2000 | No | — | No |
| `counted` | String | size 2000 | No | — | No |
| `variance` | String | size 2000 | No | — | No |
| `variance_note` | String | size 1000 | No | — | No |
| `sales_total` | Integer | — | **Yes** | — | No |
| `expense_total` | Integer | — | **Yes** | — | No |
| `tax_total` | Integer | — | **Yes** | — | No |
| `tip_total` | Integer | — | **Yes** | — | No |
| `discount_total` | Integer | — | **Yes** | — | No |
| `void_total` | Integer | — | **Yes** | — | No |
| `refund_total` | Integer | — | **Yes** | — | No |
| `cogs_total` | Integer | — | **Yes** | — | No |
| `covers` | Integer | — | **Yes** | — | No |
| `stock_check_status` | Enum | pending, complete | **Yes** | — | No |
| `posted_to_ledger` | Boolean | — | **Yes** | — | No |
| `notes` | String | size 1000 | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue_status_opened` | key | `venue_id`, `status`, `opened_at` |
| `code_unique` | unique | `venue_id`, `code` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 20. `shift_expenses` — Shift expenses

**Read**: Team: cashiers, Team: managers, Team: admins · **Create**: Team: cashiers, Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (16)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `shift_id` | String | size 64 | No | — | No |
| `category` | Enum | supplies, transport, utilities, repairs, staff_advance, petty_cash, other | **Yes** | — | No |
| `category_key` | String | size 60 | No | — | No |
| `payee` | String | size 160 | No | — | No |
| `paid_to_kind` | Enum | supplier, staff, open_market, other | No | other | No |
| `supplier_id` | String | size 64 | No | — | No |
| `paid_to_staff_id` | String | size 64 | No | — | No |
| `amount` | Integer | — | **Yes** | — | No |
| `paid_from_method_id` | String | size 64 | **Yes** | — | No |
| `note` | String | size 500 | No | — | No |
| `receipt_file_id` | String | size 64 | No | — | No |
| `created_by` | String | size 64 | **Yes** | — | No |
| `approved_by` | String | size 64 | No | — | No |
| `approval_status` | Enum | not_required, pending, approved, rejected | **Yes** | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `shift` | key | `shift_id` |
| `supplier` | key | `supplier_id` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 21. `item_availability` — Item availability log

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (12)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `menu_item_id` | String | size 64 | **Yes** | — | No |
| `name_snapshot` | String | size 160 | **Yes** | — | No |
| `shift_id` | String | size 64 | No | — | No |
| `marked_off_at` | Datetime | — | **Yes** | — | No |
| `marked_off_by` | String | size 64 | No | — | No |
| `marked_off_name` | String | size 120 | No | — | No |
| `reason` | String | size 200 | No | — | No |
| `restored_at` | Datetime | — | No | — | No |
| `restored_by` | String | size 64 | No | — | No |
| `alerted_at` | Datetime | — | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `item_marked` | key | `menu_item_id`, `marked_off_at` |
| `shift` | key | `shift_id` |
| `open_alerts` | key | `restored_at`, `alerted_at` |
| `org` | key | `org_id` |

---

### 22. `order_notices` — Order notices

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (7)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `order_id` | String | size 64 | **Yes** | — | No |
| `stage` | Enum | accepted, ready, group_placed | **Yes** | — | No |
| `to_email` | String | size 160 | No | — | No |
| `status` | Enum | queued, sent, failed, skipped | **Yes** | — | No |
| `last_error` | String | size 500 | No | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `order_stage` | key | `order_id`, `stage` |
| `org` | key | `org_id` |

---

### 23. `order_cancellations` — Order cancellations

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: All users · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: _none — server only_

**Attributes** (6)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | No | — | No |
| `order_id` | String | size 64 | **Yes** | — | No |
| `requested_at` | Datetime | — | No | — | No |
| `status` | Enum | requested, cancelled, refused | **Yes** | — | No |
| `refused_reason` | String | size 200 | No | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `order` | key | `order_id` |
| `org` | key | `org_id` |

---

### 24. `expense_categories` — Expense categories

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (6)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `key` | String | size 60 | **Yes** | — | No |
| `name` | String | size 80 | **Yes** | — | No |
| `account_code` | String | size 10 | No | 6090 | No |
| `sort` | Integer | — | No | 0 | No |
| `active` | Boolean | — | No | true | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `key_unique` | unique | `key` |
| `org` | key | `org_id` |

---

### 25. `expense_items` — Expense items

**Read**: Team: cashiers, Team: managers, Team: admins · **Create**: Team: cashiers, Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (8)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `expense_id` | String | size 64 | **Yes** | — | No |
| `ingredient_id` | String | size 64 | **Yes** | — | No |
| `name_snapshot` | String | size 160 | **Yes** | — | No |
| `qty` | Float | — | **Yes** | — | No |
| `unit_cost` | Integer | — | No | 0 | No |
| `line_total` | Integer | — | No | 0 | No |
| `stocked` | Boolean | — | No | false | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `expense` | key | `expense_id` |
| `ingredient` | key | `ingredient_id` |
| `org` | key | `org_id` |

---

### 26. `ingredient_categories` — Ingredient categories

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (5)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `key` | String | size 60 | **Yes** | — | No |
| `name` | String | size 80 | **Yes** | — | No |
| `sort` | Integer | — | No | 0 | No |
| `active` | Boolean | — | No | true | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `key_unique` | unique | `key` |
| `org` | key | `org_id` |

---

### 27. `shift_stock_checks` — Shift stock checks

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: cashiers, Team: cooks, Team: managers, Team: admins · **Update**: Team: cashiers, Team: cooks, Team: managers, Team: admins · **Delete**: _none — server only_

**Attributes** (13)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `shift_id` | String | size 64 | **Yes** | — | No |
| `ingredient_id` | String | size 64 | **Yes** | — | No |
| `opening_qty` | Float | — | **Yes** | — | No |
| `theoretical_qty` | Float | — | **Yes** | — | No |
| `counted_qty` | Float | — | No | — | No |
| `status` | Enum | OK, LOW, OUT | **Yes** | — | No |
| `status_source` | Enum | auto, manual_override | **Yes** | — | No |
| `variance_qty` | Float | — | **Yes** | — | No |
| `variance_value` | Integer | — | **Yes** | — | No |
| `checked_by` | String | size 64 | No | — | No |
| `note` | String | size 300 | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `shift_ing` | key | `shift_id`, `ingredient_id` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 28. `ingredients` — Ingredients

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (18)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `name` | String | size 160 | **Yes** | — | No |
| `unit` | Enum | g, kg, ml, l, each, pack | **Yes** | — | No |
| `base_unit_cost` | Integer | — | **Yes** | — | No |
| `current_qty` | Float | — | **Yes** | — | No |
| `par_level` | Float | — | **Yes** | — | No |
| `low_threshold` | Float | — | No | — | No |
| `critical` | Boolean | — | **Yes** | — | No |
| `supplier_id` | String | size 64 | No | — | No |
| `category` | String | size 80 | No | — | No |
| `check_guide` | String | size 160 | No | — | No |
| `expense_category_key` | String | size 60 | No | — | No |
| `shelf_life_days` | Integer | — | No | — | No |
| `consecutive_low_count` | Integer | — | No | 0 | No |
| `consecutive_low_since` | Datetime | — | No | — | No |
| `last_low_severity` | Enum | low, out | No | — | No |
| `active` | Boolean | — | **Yes** | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `active_name` | key | `active`, `name` |
| `critical` | key | `critical` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 29. `recipes` — Recipes

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (6)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `menu_item_id` | String | size 64 | No | — | No |
| `addon_option_id` | String | size 64 | No | — | No |
| `ingredient_id` | String | size 64 | **Yes** | — | No |
| `qty_per_unit` | Float | — | **Yes** | — | No |
| `wastage_bp` | Integer | — | **Yes** | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `item` | key | `menu_item_id` |
| `ingredient` | key | `ingredient_id` |
| `addon` | key | `addon_option_id` |
| `org` | key | `org_id` |

---

### 30. `suppliers` — Suppliers

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (8)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `name` | String | size 160 | **Yes** | — | No |
| `contact` | String | size 120 | No | — | No |
| `phone` | String | size 40 | No | — | No |
| `email` | String | size 160 | No | — | No |
| `payment_terms` | String | size 80 | No | — | No |
| `active` | Boolean | — | **Yes** | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 31. `purchases` — Purchases

**Read**: Team: managers, Team: admins · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (12)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `supplier_id` | String | size 64 | **Yes** | — | No |
| `invoice_no` | String | size 80 | No | — | No |
| `purchased_at` | Datetime | — | **Yes** | — | No |
| `subtotal` | Integer | — | **Yes** | — | No |
| `tax` | Integer | — | **Yes** | — | No |
| `total` | Integer | — | **Yes** | — | No |
| `paid_from_method_id` | String | size 64 | No | — | No |
| `shift_id` | String | size 64 | No | — | No |
| `received_by` | String | size 64 | **Yes** | — | No |
| `document_file_id` | String | size 64 | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `supplier_date` | key | `supplier_id`, `purchased_at` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 32. `purchase_items` — Purchase items

**Read**: Team: managers, Team: admins · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (7)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `purchase_id` | String | size 64 | **Yes** | — | No |
| `ingredient_id` | String | size 64 | **Yes** | — | No |
| `qty` | Float | — | **Yes** | — | No |
| `unit_cost` | Integer | — | **Yes** | — | No |
| `line_total` | Integer | — | **Yes** | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `purchase` | key | `purchase_id` |
| `ingredient` | key | `ingredient_id` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 33. `stock_movements` — Stock movements

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: _none — server only_ · **Delete**: _none — server only_

**Attributes** (11)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `ingredient_id` | String | size 64 | **Yes** | — | No |
| `type` | Enum | purchase, sale_depletion, waste, adjustment, count_correction, transfer | **Yes** | — | No |
| `qty_delta` | Float | — | **Yes** | — | No |
| `unit_cost` | Integer | — | **Yes** | — | No |
| `ref_type` | String | size 40 | No | — | No |
| `ref_id` | String | size 64 | No | — | No |
| `shift_id` | String | size 64 | No | — | No |
| `created_by` | String | size 64 | No | — | No |
| `note` | String | size 300 | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `ingredient_created` | key | `ingredient_id`, `$createdAt` |
| `shift` | key | `shift_id` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 34. `stock_flags` — Stock variance flags

**Read**: Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (15)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `ingredient_id` | String | size 64 | **Yes** | — | No |
| `period_start` | Datetime | — | **Yes** | — | No |
| `period_end` | Datetime | — | **Yes** | — | No |
| `theoretical_usage` | Float | — | **Yes** | — | No |
| `actual_usage` | Float | — | **Yes** | — | No |
| `variance_qty` | Float | — | **Yes** | — | No |
| `variance_bp` | Integer | — | **Yes** | — | No |
| `variance_value` | Integer | — | **Yes** | — | No |
| `severity` | Enum | info, warn, critical | **Yes** | — | No |
| `likely_causes` | String | size 40 | No | — | Yes |
| `status` | Enum | open, investigating, resolved | **Yes** | — | No |
| `resolution_note` | String | size 1000 | No | — | No |
| `resolved_by` | String | size 64 | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `status_severity` | key | `status`, `severity` |
| `ingredient` | key | `ingredient_id` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 35. `accounts` — Chart of accounts

**Read**: Team: managers, Team: admins · **Create**: Team: admins · **Update**: Team: admins · **Delete**: Team: admins

**Attributes** (6)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `code` | String | size 10 | **Yes** | — | No |
| `name` | String | size 120 | **Yes** | — | No |
| `type` | Enum | asset, liability, equity, revenue, expense | **Yes** | — | No |
| `parent_code` | String | size 10 | No | — | No |
| `system` | Boolean | — | **Yes** | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `code_unique` | unique | `code` |
| `org` | key | `org_id` |

---

### 36. `journal_entries` — Journal entries

**Read**: Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: _none — server only_ · **Delete**: _none — server only_

**Attributes** (9)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `date` | Datetime | — | **Yes** | — | No |
| `source` | Enum | shift_close, purchase, expense, refund, adjustment, reversal | **Yes** | — | No |
| `source_id` | String | size 64 | No | — | No |
| `shift_id` | String | size 64 | No | — | No |
| `memo` | String | size 500 | No | — | No |
| `posted_by` | String | size 64 | **Yes** | — | No |
| `reversed_by` | String | size 64 | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `date` | key | `date` |
| `shift` | key | `shift_id` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 37. `journal_lines` — Journal lines

**Read**: Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: _none — server only_ · **Delete**: _none — server only_

**Attributes** (7)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `entry_id` | String | size 64 | **Yes** | — | No |
| `account_code` | String | size 10 | **Yes** | — | No |
| `debit` | Integer | — | **Yes** | — | No |
| `credit` | Integer | — | **Yes** | — | No |
| `memo` | String | size 300 | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `entry` | key | `entry_id` |
| `account` | key | `account_code` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 38. `staff_profiles` — Staff profiles

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (21)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `user_id` | String | size 64 | No | — | No |
| `email` | String | size 160 | No | — | No |
| `display_name` | String | size 120 | **Yes** | — | No |
| `role` | Enum | cook, waiter, cashier, manager, admin | **Yes** | — | No |
| `pin_hash` | String | size 255 | No | — | No |
| `pin_set_at` | Datetime | — | No | — | No |
| `active` | Boolean | — | **Yes** | — | No |
| `phone` | String | size 40 | No | — | No |
| `hired_at` | Datetime | — | No | — | No |
| `can_open_shift` | Boolean | — | **Yes** | — | No |
| `can_close_shift` | Boolean | — | **Yes** | — | No |
| `can_void` | Boolean | — | **Yes** | — | No |
| `can_discount_up_to_bp` | Integer | — | **Yes** | — | No |
| `can_mark_paid` | Boolean | — | No | true | No |
| `can_apply_discount_codes` | Boolean | — | No | true | No |
| `can_record_waste` | Boolean | — | No | true | No |
| `hourly_rate` | Integer | — | No | — | No |
| `login_link_requested_at` | Datetime | — | No | — | No |
| `login_link_sent_at` | Datetime | — | No | — | No |
| `venue_ids` | String | size 64 | No | — | Yes |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `user_unique` | unique | `user_id` |
| `email` | key | `email` |
| `active_role` | key | `active`, `role` |
| `org` | key | `org_id` |

---

### 39. `devices` — Devices

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (8)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `name` | String | size 80 | **Yes** | — | No |
| `kind` | Enum | kds, pos, admin | **Yes** | — | No |
| `station` | Enum | hot, cold, bar, dessert, all | **Yes** | — | No |
| `last_seen` | Datetime | — | **Yes** | — | No |
| `audio_ok` | Boolean | — | **Yes** | — | No |
| `app_version` | String | size 40 | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `kind_seen` | key | `kind`, `last_seen` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 40. `audit_log` — Audit log

**Read**: Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: _none — server only_ · **Delete**: _none — server only_

**Attributes** (13)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `actor_id` | String | size 64 | **Yes** | — | No |
| `actor_role` | String | size 20 | No | — | No |
| `action` | String | size 80 | **Yes** | — | No |
| `entity_type` | String | size 60 | No | — | No |
| `entity_id` | String | size 64 | No | — | No |
| `before` | String | size 4000 | No | — | No |
| `after` | String | size 4000 | No | — | No |
| `reason` | String | size 500 | No | — | No |
| `ip` | String | size 60 | No | — | No |
| `device` | String | size 120 | No | — | No |
| `shift_id` | String | size 64 | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `actor_created` | key | `actor_id`, `$createdAt` |
| `action` | key | `action` |
| `venue` | key | `venue_id` |
| `org` | key | `org_id` |

---

### 41. `feature_flags` — Feature flags

**Read**: Any · **Create**: Team: admins · **Update**: Team: admins · **Delete**: Team: admins

**Attributes** (6)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `key` | String | size 60 | **Yes** | — | No |
| `venue_id` | String | size 64 | No | — | No |
| `enabled` | Boolean | — | **Yes** | — | No |
| `config` | String | size 8000 | No | — | No |
| `updated_by` | String | size 64 | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `key_venue` | unique | `key`, `venue_id` |
| `key` | key | `key` |
| `org` | key | `org_id` |

---

### 42. `receipts` — Receipts

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (16)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `order_id` | String | size 64 | **Yes** | — | No |
| `channel` | Enum | email, print, none | **Yes** | — | No |
| `to_email` | String | size 160 | No | — | No |
| `status` | Enum | queued, sent, failed, skipped, bounced | **Yes** | — | No |
| `skip_reason` | Enum | no_email, customer_declined, feature_off | No | — | No |
| `attempts` | Integer | — | **Yes** | — | No |
| `last_error` | String | size 500 | No | — | No |
| `sent_at` | Datetime | — | No | — | No |
| `provider_ref` | String | size 200 | No | — | No |
| `pdf_file_id` | String | size 64 | No | — | No |
| `requested_by` | String | size 64 | No | — | No |
| `resend_requested_at` | Datetime | — | No | — | No |
| `resend_requested_by` | String | size 64 | No | — | No |
| `email_source` | Enum | guest_at_order, staff_entered, customer_profile | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `order` | key | `order_id` |
| `status_created` | key | `status`, `$createdAt` |
| `email` | key | `to_email` |
| `org` | key | `org_id` |

---

### 43. `pickup_points` — Pickup points

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (13)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `name` | String | size 120 | **Yes** | — | No |
| `kind` | Enum | counter, window, kiosk, locker, partner_site, kerbside | **Yes** | — | No |
| `address` | String | size 300 | No | — | No |
| `directions` | String | size 500 | No | — | No |
| `phone` | String | size 40 | No | — | No |
| `lead_minutes` | Integer | — | **Yes** | — | No |
| `opening_hours` | String | size 2000 | No | — | No |
| `station` | String | size 40 | No | — | No |
| `accepts_delivery` | Boolean | — | **Yes** | — | No |
| `active` | Boolean | — | **Yes** | — | No |
| `sort` | Integer | — | **Yes** | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue_active_sort` | key | `venue_id`, `active`, `sort` |
| `org` | key | `org_id` |

---

### 44. `delivery_zones` — Delivery zones

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (9)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `pickup_point_id` | String | size 64 | No | — | No |
| `name` | String | size 120 | **Yes** | — | No |
| `fee` | Integer | — | **Yes** | — | No |
| `min_order_total` | Integer | — | **Yes** | — | No |
| `eta_minutes` | Integer | — | **Yes** | — | No |
| `active` | Boolean | — | **Yes** | — | No |
| `sort` | Integer | — | **Yes** | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue_active` | key | `venue_id`, `active`, `sort` |
| `org` | key | `org_id` |

---

### 45. `preorder_slots` — Pre-order slots

**Read**: Any · **Create**: All users · **Update**: All users · **Delete**: Team: managers, Team: admins

**Attributes** (9)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `pickup_point_id` | String | size 64 | No | — | No |
| `slot_start` | Datetime | — | **Yes** | — | No |
| `slot_end` | Datetime | — | **Yes** | — | No |
| `capacity` | Integer | — | **Yes** | — | No |
| `booked_count` | Integer | — | **Yes** | — | No |
| `status` | Enum | open, full, closed | **Yes** | — | No |
| `closed_reason` | String | size 200 | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue_slot` | unique | `venue_id`, `pickup_point_id`, `slot_start` |
| `venue_start` | key | `venue_id`, `slot_start` |
| `org` | key | `org_id` |

---

### 46. `waste_log` — Waste log

**Read**: Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (13)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `shift_id` | String | size 64 | No | — | No |
| `ingredient_id` | String | size 64 | No | — | No |
| `menu_item_id` | String | size 64 | No | — | No |
| `qty` | Float | — | **Yes** | — | No |
| `unit` | String | size 20 | **Yes** | — | No |
| `reason` | Enum | spoiled, expired, dropped, burnt, prep_error, customer_return, staff_meal, trim, other | **Yes** | — | No |
| `note` | String | size 500 | No | — | No |
| `value` | Integer | — | **Yes** | — | No |
| `photo_file_id` | String | size 64 | No | — | No |
| `recorded_by` | String | size 64 | **Yes** | — | No |
| `approved_by` | String | size 64 | No | — | No |

**Indexes** (5)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue_created` | key | `venue_id`, `$createdAt` |
| `shift` | key | `shift_id` |
| `ingredient` | key | `ingredient_id` |
| `reason` | key | `reason` |
| `org` | key | `org_id` |

---

### 47. `time_entries` — Time entries

**Read**: Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (14)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `user_id` | String | size 64 | **Yes** | — | No |
| `shift_id` | String | size 64 | No | — | No |
| `clock_in` | Datetime | — | **Yes** | — | No |
| `clock_out` | Datetime | — | No | — | No |
| `break_minutes` | Integer | — | **Yes** | — | No |
| `minutes_worked` | Integer | — | No | — | No |
| `hourly_rate_snapshot` | Integer | — | No | — | No |
| `labour_cost` | Integer | — | No | — | No |
| `source` | Enum | pin, manager, auto_close | **Yes** | — | No |
| `edited_by` | String | size 64 | No | — | No |
| `edit_reason` | String | size 300 | No | — | No |
| `note` | String | size 300 | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `user_in` | key | `user_id`, `clock_in` |
| `venue_in` | key | `venue_id`, `clock_in` |
| `open` | key | `user_id`, `clock_out` |
| `org` | key | `org_id` |

---

### 48. `customers` — Customers

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Any · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (16)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `phone` | String | size 40 | No | — | No |
| `email` | String | size 160 | No | — | No |
| `name` | String | size 160 | No | — | No |
| `locale` | String | size 10 | No | — | No |
| `marketing_opt_in` | Boolean | — | **Yes** | — | No |
| `receipt_opt_in` | Boolean | — | **Yes** | — | No |
| `venue_ids` | String | size 64 | No | — | Yes |
| `first_seen` | Datetime | — | No | — | No |
| `last_seen` | Datetime | — | No | — | No |
| `order_count` | Integer | — | **Yes** | — | No |
| `total_spent` | Integer | — | **Yes** | — | No |
| `avg_order_value` | Integer | — | **Yes** | — | No |
| `tags` | String | size 40 | No | — | Yes |
| `notes` | String | size 1000 | No | — | No |
| `blocked` | Boolean | — | **Yes** | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `phone_unique` | unique | `phone` |
| `email` | key | `email` |
| `last_seen` | key | `last_seen` |
| `org` | key | `org_id` |

---

### 49. `loyalty_programs` — Loyalty programs

**Read**: Any · **Create**: Team: admins · **Update**: Team: admins · **Delete**: Team: admins

**Attributes** (12)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `name` | String | size 120 | **Yes** | — | No |
| `venue_ids` | String | size 64 | No | — | Yes |
| `kind` | Enum | points, stamps, spend_tiers | **Yes** | — | No |
| `earn_per_currency_unit` | Float | — | No | — | No |
| `stamp_target` | Integer | — | No | — | No |
| `stamp_qualifying_item_ids` | String | size 64 | No | — | Yes |
| `redeem_value_per_point` | Integer | — | No | — | No |
| `min_redeem_points` | Integer | — | **Yes** | — | No |
| `reward_description` | String | size 300 | No | — | No |
| `expiry_days` | Integer | — | No | — | No |
| `active` | Boolean | — | **Yes** | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `active` | key | `active` |
| `org` | key | `org_id` |

---

### 50. `loyalty_ledger` — Loyalty ledger

**Read**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: _none — server only_ · **Delete**: _none — server only_

**Attributes** (11)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `customer_id` | String | size 64 | **Yes** | — | No |
| `program_id` | String | size 64 | **Yes** | — | No |
| `order_id` | String | size 64 | No | — | No |
| `type` | Enum | earn, redeem, adjust, expire, reverse | **Yes** | — | No |
| `delta` | Integer | — | **Yes** | — | No |
| `balance_after` | Integer | — | **Yes** | — | No |
| `expires_at` | Datetime | — | No | — | No |
| `note` | String | size 300 | No | — | No |
| `created_by` | String | size 64 | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `customer_created` | key | `customer_id`, `$createdAt` |
| `order` | key | `order_id` |
| `org` | key | `org_id` |

---

### 51. `feedback` — Feedback

**Read**: Team: managers, Team: admins · **Create**: Any · **Update**: Team: managers, Team: admins · **Delete**: Team: admins

**Attributes** (17)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `order_id` | String | size 64 | No | — | No |
| `customer_id` | String | size 64 | No | — | No |
| `rating` | Integer | — | **Yes** | — | No |
| `food_rating` | Integer | — | No | — | No |
| `service_rating` | Integer | — | No | — | No |
| `speed_rating` | Integer | — | No | — | No |
| `tags` | String | size 40 | No | — | Yes |
| `comment` | String | size 2000 | No | — | No |
| `item_ids` | String | size 64 | No | — | Yes |
| `served_by` | String | size 64 | No | — | No |
| `shift_id` | String | size 64 | No | — | No |
| `status` | Enum | new, seen, responded, resolved, ignored | **Yes** | — | No |
| `response` | String | size 2000 | No | — | No |
| `responded_by` | String | size 64 | No | — | No |
| `responded_at` | Datetime | — | No | — | No |

**Indexes** (5)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue_created` | key | `venue_id`, `$createdAt` |
| `rating` | key | `rating` |
| `status` | key | `status` |
| `served_by` | key | `served_by` |
| `org` | key | `org_id` |

---

### 52. `translations` — Translations

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (8)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `entity_type` | Enum | menu_item, category, addon_group, addon_option, venue, pickup_point, discount | **Yes** | — | No |
| `entity_id` | String | size 64 | **Yes** | — | No |
| `locale` | String | size 10 | **Yes** | — | No |
| `field` | String | size 40 | **Yes** | — | No |
| `value` | String | size 2000 | **Yes** | — | No |
| `machine_translated` | Boolean | — | **Yes** | — | No |
| `updated_by` | String | size 64 | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `entity_locale_field` | unique | `entity_type`, `entity_id`, `locale`, `field` |
| `locale` | key | `locale` |
| `org` | key | `org_id` |

---

### 53. `purchase_orders` — Purchase orders

**Read**: Team: managers, Team: admins · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (14)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `supplier_id` | String | size 64 | **Yes** | — | No |
| `po_number` | String | size 40 | **Yes** | — | No |
| `status` | Enum | draft, sent, part_received, received, cancelled | **Yes** | — | No |
| `expected_at` | Datetime | — | No | — | No |
| `sent_at` | Datetime | — | No | — | No |
| `subtotal` | Integer | — | **Yes** | — | No |
| `tax` | Integer | — | **Yes** | — | No |
| `total` | Integer | — | **Yes** | — | No |
| `ordered_by` | String | size 64 | **Yes** | — | No |
| `approved_by` | String | size 64 | No | — | No |
| `note` | String | size 1000 | No | — | No |
| `auto_generated` | Boolean | — | **Yes** | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue_status` | key | `venue_id`, `status` |
| `po_number_unique` | unique | `venue_id`, `po_number` |
| `supplier` | key | `supplier_id` |
| `org` | key | `org_id` |

---

### 54. `purchase_order_items` — Purchase order items

**Read**: Team: managers, Team: admins · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (12)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `purchase_order_id` | String | size 64 | **Yes** | — | No |
| `ingredient_id` | String | size 64 | **Yes** | — | No |
| `qty_ordered` | Float | — | **Yes** | — | No |
| `qty_received` | Float | — | **Yes** | — | No |
| `unit` | String | size 20 | **Yes** | — | No |
| `unit_cost_expected` | Integer | — | **Yes** | — | No |
| `unit_cost_actual` | Integer | — | No | — | No |
| `line_total` | Integer | — | **Yes** | — | No |
| `discrepancy` | Enum | none, short, over, price_up, price_down, quality, not_delivered | **Yes** | — | No |
| `discrepancy_note` | String | size 500 | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `po` | key | `purchase_order_id` |
| `ingredient` | key | `ingredient_id` |
| `org` | key | `org_id` |

---

### 55. `report_subscriptions` — Report subscriptions

**Read**: Team: managers, Team: admins · **Create**: Team: admins · **Update**: Team: admins · **Delete**: Team: admins

**Attributes** (7)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_ids` | String | size 64 | No | — | Yes |
| `user_id` | String | size 64 | No | — | No |
| `channel` | Enum | email, whatsapp, sms, push | **Yes** | — | No |
| `destination` | String | size 200 | **Yes** | — | No |
| `events` | String | size 40 | **Yes** | — | Yes |
| `active` | Boolean | — | **Yes** | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `active` | key | `active` |
| `org` | key | `org_id` |

---

### 56. `summary_reports` — Summary reports

**Read**: Team: managers, Team: admins · **Create**: _none — server only_ · **Update**: _none — server only_ · **Delete**: _none — server only_

**Attributes** (13)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `kind` | Enum | shift_close, daily_digest, backup | **Yes** | — | No |
| `shift_id` | String | size 64 | No | — | No |
| `period_start` | Datetime | — | **Yes** | — | No |
| `period_end` | Datetime | — | **Yes** | — | No |
| `payload` | String | size 20000 | **Yes** | — | No |
| `new_stock_ids` | String | size 64 | No | — | Yes |
| `persistent_stock_ids` | String | size 64 | No | — | Yes |
| `delivery_status` | Enum | queued, sent, partial, failed | **Yes** | — | No |
| `delivered_to` | String | size 2000 | No | — | No |
| `last_error` | String | size 500 | No | — | No |
| `sent_at` | Datetime | — | No | — | No |

**Indexes** (3)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue_kind_created` | key | `venue_id`, `kind`, `$createdAt` |
| `shift` | key | `shift_id` |
| `org` | key | `org_id` |

---

### 57. `kitchen_status` — Kitchen status

**Read**: Any · **Create**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Update**: Team: cooks, Team: waiters, Team: cashiers, Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (10)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `station` | String | size 40 | **Yes** | — | No |
| `mode` | Enum | normal, busy, paused | **Yes** | — | No |
| `pending_count` | Integer | — | **Yes** | — | No |
| `quoted_wait_minutes` | Integer | — | **Yes** | — | No |
| `auto` | Boolean | — | **Yes** | — | No |
| `set_by` | String | size 64 | No | — | No |
| `reason` | String | size 300 | No | — | No |
| `until` | Datetime | — | No | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `venue_station` | unique | `venue_id`, `station` |
| `org` | key | `org_id` |

---

### 58. `price_rules` — Price rules

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (17)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `name` | String | size 120 | **Yes** | — | No |
| `venue_ids` | String | size 64 | No | — | Yes |
| `scope` | Enum | all, category, item, tag | **Yes** | — | No |
| `target_ids` | String | size 64 | No | — | Yes |
| `adjust_kind` | Enum | percent_off, amount_off, fixed_price | **Yes** | — | No |
| `adjust_value` | Integer | — | **Yes** | — | No |
| `days_of_week` | String | size 3 | No | — | Yes |
| `time_start` | String | size 5 | No | — | No |
| `time_end` | String | size 5 | No | — | No |
| `starts_at` | Datetime | — | No | — | No |
| `ends_at` | Datetime | — | No | — | No |
| `channels` | String | size 20 | No | — | Yes |
| `priority` | Integer | — | **Yes** | — | No |
| `show_original_price` | Boolean | — | **Yes** | — | No |
| `badge_text` | String | size 40 | No | — | No |
| `active` | Boolean | — | **Yes** | — | No |

**Indexes** (2)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `active_priority` | key | `active`, `priority` |
| `org` | key | `org_id` |

---

### 59. `discounts` — Discounts

**Read**: Any · **Create**: Team: managers, Team: admins · **Update**: Team: managers, Team: admins · **Delete**: Team: managers, Team: admins

**Attributes** (29)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `name` | String | size 120 | **Yes** | — | No |
| `code` | String | size 40 | No | — | No |
| `description` | String | size 500 | No | — | No |
| `venue_ids` | String | size 64 | No | — | Yes |
| `kind` | Enum | percent, amount, free_item, item_percent, free_delivery | **Yes** | — | No |
| `value` | Integer | — | **Yes** | — | No |
| `free_item_id` | String | size 64 | No | — | No |
| `scope` | Enum | order, category, item, tag | **Yes** | — | No |
| `target_ids` | String | size 64 | No | — | Yes |
| `min_order_total` | Integer | — | **Yes** | — | No |
| `max_discount_amount` | Integer | — | No | — | No |
| `guest_applicable` | Boolean | — | **Yes** | — | No |
| `staff_applicable` | Boolean | — | **Yes** | — | No |
| `requires_manager` | Boolean | — | **Yes** | — | No |
| `auto_apply` | Boolean | — | **Yes** | — | No |
| `stackable` | Boolean | — | **Yes** | — | No |
| `starts_at` | Datetime | — | No | — | No |
| `ends_at` | Datetime | — | No | — | No |
| `days_of_week` | String | size 3 | No | — | Yes |
| `time_start` | String | size 5 | No | — | No |
| `time_end` | String | size 5 | No | — | No |
| `channels` | String | size 20 | No | — | Yes |
| `usage_limit_total` | Integer | — | No | — | No |
| `usage_limit_per_customer` | Integer | — | No | — | No |
| `first_order_only` | Boolean | — | **Yes** | — | No |
| `used_count` | Integer | — | **Yes** | — | No |
| `active` | Boolean | — | **Yes** | — | No |
| `created_by` | String | size 64 | No | — | No |

**Indexes** (4)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `code_unique` | unique | `code` |
| `active_code` | key | `active`, `code` |
| `active` | key | `active` |
| `org` | key | `org_id` |

---

### 60. `discount_redemptions` — Discount redemptions

**Read**: Team: managers, Team: admins · **Create**: All users · **Update**: Team: managers, Team: admins · **Delete**: _none — server only_

**Attributes** (13)

| Key | Type | Size / Enum values | Required | Default | Array |
| --- | --- | --- | --- | --- | --- |
| `org_id` | String | size 64 | No | — | No |
| `venue_id` | String | size 64 | **Yes** | — | No |
| `discount_id` | String | size 64 | **Yes** | — | No |
| `code_snapshot` | String | size 40 | No | — | No |
| `order_id` | String | size 64 | **Yes** | — | No |
| `customer_id` | String | size 64 | No | — | No |
| `amount` | Integer | — | **Yes** | — | No |
| `stage` | Enum | guest_ordering, staff_post_accept, auto | **Yes** | — | No |
| `applied_by` | String | size 64 | No | — | No |
| `approved_by` | String | size 64 | No | — | No |
| `status` | Enum | applied, reversed | **Yes** | — | No |
| `reversed_by` | String | size 64 | No | — | No |
| `reverse_reason` | String | size 300 | No | — | No |

**Indexes** (5)

| Index key | Type | Attributes (in this order) |
| --- | --- | --- |
| `order` | key | `order_id` |
| `discount_created` | key | `discount_id`, `$createdAt` |
| `customer` | key | `customer_id` |
| `applied_by` | key | `applied_by` |
| `org` | key | `org_id` |

---

## Stage 6 — Seed documents

These rows must exist before the apps will run. Create them from
**Databases → snpos → [collection] → Add document**.

### 6.1 `settings` — one document, ID `main`

Set the **Document ID** to `main` manually (do not let it auto-generate).
Fill every required field; the values below are sensible starting points and
can all be changed later in the admin screens.

| Field | Value |
| --- | --- |
| `restaurant_name` | `My Restaurant` |
| `timezone` | `Africa/Accra` |
| `currency_code` | `GHS` |
| `currency_symbol` | `GH₵` |
| `currency_decimals` | `2` |
| `symbol_position` | `before` |
| `primary_color` | `#0F766E` |
| `secondary_color` | `#F59E0B` |
| `tax_rate_bp` | `0` |
| `tax_inclusive` | `true` |
| `service_charge_bp` | `0` |
| `shift_float_policy` | `zero` |
| `shift_float_default` | `0` |
| `kitchen_ack_sla_seconds` | `60` |
| `kitchen_ping_max_level` | `4` |
| `require_reject_reason` | `true` |
| `qr_orders_need_approval` | `false` |
| `low_stock_default_bp` | `3000` |
| `stock_variance_threshold_bp` | `1000` |
| `stock_variance_value_floor` | `2000` |
| `expense_approval_threshold` | `20000` |
| `cash_variance_tolerance` | `500` |
| `terminal_idle_lock_seconds` | `180` |

Leave the rest blank for now.

### 6.2 `venues` — one document, ID `main`

Set the **Document ID** to `main`.

| Field | Value |
| --- | --- |
| `name` | `My Restaurant` |
| `slug` | `main` |
| `timezone` | `Africa/Accra` |
| `active` | `true` |
| `sort` | `0` |
| `shift_float_policy` | `inherit` |
| `shift_float_default` | `0` |

Add `opening_hours` later from the admin screens — it is JSON and far easier
to set there than by hand here.

### 6.3 `accounts` — 20 documents (chart of accounts)

Auto-generated Document IDs are fine. Set `system` to `true` on all of them.

| code | name | type |
| --- | --- | --- |
| `1000` | Cash on hand | `asset` |
| `1010` | Card clearing | `asset` |
| `1020` | Mobile money clearing | `asset` |
| `1200` | Inventory | `asset` |
| `2100` | Tax payable | `liability` |
| `2200` | Tips payable | `liability` |
| `2300` | Accounts payable | `liability` |
| `3000` | Owner equity | `equity` |
| `4000` | Food sales | `revenue` |
| `4010` | Beverage sales | `revenue` |
| `4900` | Discounts given | `revenue` |
| `5000` | Cost of goods sold | `expense` |
| `6000` | Supplies | `expense` |
| `6010` | Transport | `expense` |
| `6020` | Utilities | `expense` |
| `6030` | Repairs & maintenance | `expense` |
| `6040` | Staff advances | `expense` |
| `6050` | Petty cash | `expense` |
| `6090` | Other expenses | `expense` |
| `7000` | Cash over / short | `expense` |

### 6.4 `payment_methods` — 2 documents

| venue_id | name | kind | sort | opens_cash_drawer | requires_reference | counted_at_close | enabled | gateway | surcharge_bp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `main` | Cash | `cash` | 1 | true | false | true | true | `none` | 0 |
| `main` | Card | `card` | 2 | false | true | true | true | `none` | 0 |

### 6.5 `pickup_points` — 1 document

| Field | Value |
| --- | --- |
| `venue_id` | `main` |
| `name` | `Front counter` |
| `kind` | `counter` |
| `lead_minutes` | `0` |
| `accepts_delivery` | `false` |
| `active` | `true` |
| `sort` | `0` |

### 6.6 `feature_flags` — 19 documents

One per feature. Leave `venue_id` **blank** — that makes each row the
group-wide default. `config` is a JSON string: copy the whole block from the
`config` column into the field as-is, including the outer braces.

| key | enabled | config (paste as one line) |
| --- | --- | --- |
| `receipts` | `true` | `{"receipt_delivery":"email","ask_email_at_qr_order":true,"allow_staff_enter_email":true,"allow_skip_email":true,"email_subject":"Your receipt from {{venue}}","notify_on_accepted":true,"notify_on_ready":true,"attach_pdf":true,"print_kitchen_slips":false,"kitchen_slip_printer":"","kitchen_slip_copies":1,"receipt_printer":"","receipt_footer":""}` |
| `takeaway` | `true` | `{"takeaway_enabled":true,"delivery_enabled":false,"require_pickup_point_choice":true,"default_pickup_point_id":"","show_pickup_directions_to_guest":true,"require_customer_phone":true,"default_prep_minutes":20,"allow_scheduled_pickup":true,"max_days_ahead":2}` |
| `preorders` | `true` | `{"allow_when_closed":true,"allow_when_open":true,"fulfilments":["takeaway","delivery","dine_in"],"max_days_ahead":7,"min_lead_minutes":30,"slot_minutes":15,"slot_capacity":0,"cutoff_minutes_before_close":30,"fire_lead_uses_prep_time":true,"fire_lead_extra_minutes":5,"require_staff_confirmation":false,"auto_cancel_unconfirmed_hours":0,"closed_message":"We're closed right now — order ahead and pick a time."}` |
| `combined_mode` | `false` | `{"show_kitchen_in_terminal":true,"show_ordering_in_kitchen":true,"allow_cook_to_mark_paid":true}` |
| `overdue_alerts` | `true` | `{"grace_minutes":5,"repeat_minutes":3,"escalate_to_manager_after_minutes":15}` |
| `waste_log` | `true` | `{"require_photo_above_value":0,"require_manager_above_value":0,"prompt_at_shift_close":true}` |
| `time_clock` | `true` | `{"clock_in_with_pin":true,"auto_clock_out_hours":14,"track_labour_cost":true,"require_manager_edit_reason":true}` |
| `customers` | `true` | `{"collect_phone":true,"collect_email":true,"collect_name":true,"optional_always":true,"merge_on_matching_phone":true}` |
| `loyalty` | `true` | `{"requires":["customers"],"kind":"stamps","stamp_target":9,"show_progress_on_receipt":true}` |
| `feedback` | `true` | `{"prompt_after_payment":true,"prompt_on_receipt_email":true,"ask_food_and_service":true,"alert_managers_below_rating":3}` |
| `multilingual` | `true` | `{"locales":["en"],"show_language_picker":true,"fall_back_to_default":true}` |
| `purchase_orders` | `true` | `{"require_approval_above":0,"auto_suggest_from_par_levels":true,"flag_price_rise_bp":1000,"block_receive_without_check":true}` |
| `shift_summary` | `true` | `{"send_on_shift_close":true,"also_send_daily_digest":false,"include_sales":true,"include_cash_variance":true,"include_voids_and_discounts":true,"include_waste":true,"include_new_stock_alerts":true,"include_persistent_stock":true,"persistent_stock_threshold":3,"channels":["email"]}` |
| `busy_mode` | `true` | `{"auto_trip":true,"busy_pending_threshold":12,"pause_pending_threshold":20,"busy_extra_minutes":15,"hold_qr_orders_when_paused":true,"message_to_guest":"The kitchen is very busy — your order may take a little longer."}` |
| `time_pricing` | `true` | `{"show_original_price":true,"apply_to_qr":true,"apply_to_pos":true,"badge_text":"Happy hour"}` |
| `discounts` | `true` | `{"guest_codes_enabled":true,"staff_discounts_enabled":true,"staff_apply_window":"before_payment","manager_pin_above_bp":2000,"max_stacked":1,"show_savings_on_receipt":true,"invalid_code_message":"That code isn't valid for this order."}` |
| `item_availability` | `true` | `{"who_can_mark":"all","require_reason":false,"alert_after_hours":24,"alert_emails":"","include_in_shift_summary":true}` |
| `group_orders` | `false` | `{"require_reservation_number":true,"reservation_label":"Hotel reservation number","min_group_size":6,"notify_emails":"","notify_on_placed":true,"notify_group_on_accepted":true}` |
| `help` | `true` | `{"audiences":{},"show_on_customer_menu":true}` |

If pasting that much JSON is painful, you can set `config` to `{}` for now and
edit the options in the admin screens once the apps are running — the code
falls back to the defaults in `scripts/schema.mjs` for anything missing.

---

## Stage 7 — First admin user

1. **Auth → Users → Create user** with your email, a name, and a password.
2. Copy the resulting **User ID**.
3. **Auth → Teams → admins → Add membership** → that user.
4. **Databases → snpos → staff_profiles → Add document**:

| Field | Value |
| --- | --- |
| `user_id` | the User ID from step 2 |
| `display_name` | your name |
| `role` | `admin` |
| `active` | `true` |
| `can_open_shift` | `true` |
| `can_close_shift` | `true` |
| `can_void` | `true` |
| `can_discount_up_to_bp` | `10000` |
| `venue_ids` | leave empty — empty means all venues |

**Verify:** you can log into the admin app and see Settings.

---

## Progress checklist

Tick these off as you go — it is a long job and losing your place is the main
way mistakes creep in.

- [ ] Stage 1 — platforms, auth, API key
- [ ] Stage 2 — 5 teams
- [ ] Stage 3 — 3 buckets
- [ ] Stage 4 — database `snpos`

**Stage 5 — collections**

- [ ]  1. `venues` (19 fields, 3 indexes)
- [ ]  2. `venue_menu_items` (7 fields, 2 indexes)
- [ ]  3. `organisations` (13 fields, 3 indexes)
- [ ]  4. `org_requests` (10 fields, 1 indexes)
- [ ]  5. `settings` (48 fields, 1 indexes)
- [ ]  6. `payment_methods` (11 fields, 3 indexes)
- [ ]  7. `categories` (11 fields, 2 indexes)
- [ ]  8. `menu_items` (22 fields, 3 indexes)
- [ ]  9. `menu_item_categories` (5 fields, 4 indexes)
- [ ] 10. `stations` (7 fields, 3 indexes)
- [ ] 11. `addon_groups` (7 fields, 1 indexes)
- [ ] 12. `addon_options` (8 fields, 2 indexes)
- [ ] 13. `menu_item_addon_groups` (6 fields, 2 indexes)
- [ ] 14. `tables` (13 fields, 4 indexes)
- [ ] 15. `dining_sessions` (9 fields, 3 indexes)
- [ ] 16. `orders` (61 fields, 13 indexes)
- [ ] 17. `order_items` (19 fields, 4 indexes)
- [ ] 18. `payments` (16 fields, 4 indexes)
- [ ] 19. `shifts` (28 fields, 4 indexes)
- [ ] 20. `shift_expenses` (16 fields, 4 indexes)
- [ ] 21. `item_availability` (12 fields, 4 indexes)
- [ ] 22. `order_notices` (7 fields, 2 indexes)
- [ ] 23. `order_cancellations` (6 fields, 2 indexes)
- [ ] 24. `expense_categories` (6 fields, 2 indexes)
- [ ] 25. `expense_items` (8 fields, 3 indexes)
- [ ] 26. `ingredient_categories` (5 fields, 2 indexes)
- [ ] 27. `shift_stock_checks` (13 fields, 3 indexes)
- [ ] 28. `ingredients` (18 fields, 4 indexes)
- [ ] 29. `recipes` (6 fields, 4 indexes)
- [ ] 30. `suppliers` (8 fields, 2 indexes)
- [ ] 31. `purchases` (12 fields, 3 indexes)
- [ ] 32. `purchase_items` (7 fields, 4 indexes)
- [ ] 33. `stock_movements` (11 fields, 4 indexes)
- [ ] 34. `stock_flags` (15 fields, 4 indexes)
- [ ] 35. `accounts` (6 fields, 2 indexes)
- [ ] 36. `journal_entries` (9 fields, 4 indexes)
- [ ] 37. `journal_lines` (7 fields, 4 indexes)
- [ ] 38. `staff_profiles` (21 fields, 4 indexes)
- [ ] 39. `devices` (8 fields, 3 indexes)
- [ ] 40. `audit_log` (13 fields, 4 indexes)
- [ ] 41. `feature_flags` (6 fields, 3 indexes)
- [ ] 42. `receipts` (16 fields, 4 indexes)
- [ ] 43. `pickup_points` (13 fields, 2 indexes)
- [ ] 44. `delivery_zones` (9 fields, 2 indexes)
- [ ] 45. `preorder_slots` (9 fields, 3 indexes)
- [ ] 46. `waste_log` (13 fields, 5 indexes)
- [ ] 47. `time_entries` (14 fields, 4 indexes)
- [ ] 48. `customers` (16 fields, 4 indexes)
- [ ] 49. `loyalty_programs` (12 fields, 2 indexes)
- [ ] 50. `loyalty_ledger` (11 fields, 3 indexes)
- [ ] 51. `feedback` (17 fields, 5 indexes)
- [ ] 52. `translations` (8 fields, 3 indexes)
- [ ] 53. `purchase_orders` (14 fields, 4 indexes)
- [ ] 54. `purchase_order_items` (12 fields, 3 indexes)
- [ ] 55. `report_subscriptions` (7 fields, 2 indexes)
- [ ] 56. `summary_reports` (13 fields, 3 indexes)
- [ ] 57. `kitchen_status` (10 fields, 2 indexes)
- [ ] 58. `price_rules` (17 fields, 2 indexes)
- [ ] 59. `discounts` (29 fields, 4 indexes)
- [ ] 60. `discount_redemptions` (13 fields, 5 indexes)

**Stage 6 — seed documents**

- [ ] `settings/main`
- [ ] `venues/main`
- [ ] 20 × `accounts`
- [ ] 2 × `payment_methods`
- [ ] 1 × `pickup_points`
- [ ] 19 × `feature_flags`

**Stage 7**

- [ ] admin user + team membership + `staff_profiles` row

---

## When you are done

Sanity-check before building on top of it:

1. The `snpos` database lists **60 collections**.
2. `settings/main` exists and `shift_float_policy` reads `zero`.
3. `venues/main` exists and is active.
4. `feature_flags` holds **19 rows**, each with a blank `venue_id`.
5. `accounts` holds **20 rows**.

If you later get access to a terminal, running `npm run provision` against
this same project is still safe — it creates only what is missing and reports
the rest as already present. It is a good way to catch anything mistyped here.
