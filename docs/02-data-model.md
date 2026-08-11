# 02, Data model

Database ID: `snpos`. All IDs are Appwrite `$id` strings. `int` money fields are
**minor units** (see 01.6). Timestamps are ISO-8601 in the restaurant's timezone
offset; `settings.timezone` is the single source of truth for day boundaries.

Legend for permissions: `T:x` = team `x`. Read/write are Appwrite document- or
collection-level permissions applied by `scripts/provision.mjs`.

---

## Configuration

### `settings` (single document, `$id = "main"`)

| Attribute | Type | Notes |
| --- | --- | --- |
| `restaurant_name` | string(120) | |
| `timezone` | string(64) | e.g. `Africa/Accra`, drives availability + shift days |
| `currency_code` | string(3) | ISO 4217, admin-set |
| `currency_symbol` | string(8) | e.g. `GH₵` |
| `currency_decimals` | int | 2 |
| `symbol_position` | enum | `before` / `after` |
| `primary_color` | string(9) | `#RRGGBB` |
| `secondary_color` | string(9) | |
| `accent_color` | string(9) | derived default, overridable |
| `logo_light_id` | string | file in `branding` bucket |
| `logo_dark_id` | string | |
| `favicon_id` | string | |
| `tax_rate_bp` | int | basis points, e.g. `1500` = 15% |
| `tax_inclusive` | bool | whether menu prices already include tax |
| `service_charge_bp` | int | |
| `shift_float_policy` | enum | `zero` \| `carry_over` \| `prompt`, **default `zero`** |
| `shift_float_default` | int | opening float when policy is `zero` |
| `kitchen_ack_sla_seconds` | int | default 60, ping escalates past this |
| `kitchen_ping_max_level` | int | default 4 |
| `require_reject_reason` | bool | default `true`, cannot be disabled below manager |
| `order_number_prefix` | string(8) | |
| `low_stock_default_bp` | int | % of par level counting as LOW, default 3000 (30%) |
| `stock_variance_threshold_bp` | int | flag when |theoretical − actual| exceeds, default 1000 |

Permissions: read `any` (the menu app needs branding + currency), update
`T:admins` only.

### `payment_methods`

| Attribute | Type | Notes |
| --- | --- | --- |
| `name` | string(40) | "Cash", "Card", "MoMo, MTN" |
| `kind` | enum | `cash` \| `card` \| `mobile_money` \| `voucher` \| `on_account` |
| `enabled` | bool | |
| `sort` | int | |
| `opens_cash_drawer` | bool | |
| `requires_reference` | bool | forces the cashier to key a terminal/txn ref |
| `counted_at_close` | bool | whether it appears in the blind count at shift close |
| `gateway` | enum | `none` \| `paystack` \| `stripe`, `none` until you enable one |
| `surcharge_bp` | int | optional card surcharge |

Read `users`, write `T:admins`.

---

## Menu

### `categories`

`name`, `description`, `sort` (int), `image_id`, `active` (bool),
`availability` (string 4000, JSON, see 03.2), `station` (enum:
`hot` \| `cold` \| `bar` \| `dessert`), the default routing for its items.

Read `any`. Write `T:admins`, `T:managers`.

### `menu_items`

| Attribute | Type | Notes |
| --- | --- | --- |
| `category_id` | string | |
| `name`, `description` | string | |
| `price` | int | base price, minor units |
| `image_id` | string | `menu-images` bucket |
| `image_focal_x/_y` | float | 0–1, drives phone cropping (03.5) |
| `sku` | string(40) | |
| `active` | bool | admin on/off |
| `availability` | string(4000) | JSON rules, overrides category when present |
| `sold_out_until` | datetime | quick 86 from the POS without editing the item |
| `prep_minutes` | int | drives kitchen ETA |
| `station` | enum | overrides category |
| `tags` | string[] | `vegan`, `spicy`, `halal`, `contains_nuts` |
| `sort` | int | |
| `track_stock` | bool | when true, availability also respects ingredient stock |

Indexes: `category_id`, `active`, fulltext on `name`.
Read `any`. Write `T:admins`, `T:managers`.

### `addon_groups`

`name` ("Choose your side"), `min_select` (int), `max_select` (int),
`required` (bool), `sort`. `min_select=1, max_select=1` renders as radio;
otherwise checkboxes.

### `addon_options`

`group_id`, `name`, `price_delta` (int, **can be negative**, e.g. "No cheese
−GH₵2"), `active`, `sort`, `default_selected` (bool), `max_qty` (int, allows
"×2 bacon").

### `menu_item_addon_groups`

Join: `menu_item_id`, `group_id`, `sort`, plus per-item overrides
`price_delta_override` (nullable int) and `required_override` (nullable bool), 
so "Extra cheese" can cost GH₵3 on a burger and GH₵5 on a pizza without
duplicating the group.

---

## Service floor

### `tables`

`label` ("T12"), `zone` ("Terrace"), `seats` (int), `qr_token` (string 64,
unique, rotatable), `status` (enum `free` \| `seated` \| `ordered` \| `bill_requested`
\| `dirty`), `current_order_id`, `active`.

The QR encodes `https://menu.<domain>/t/<qr_token>`, never the table's `$id`,
so a leaked/photographed code can be revoked by rotating the token.

### `dining_sessions`

One per group seated at a table. `table_id`, `opened_at`, `closed_at`,
`guest_count`, `anon_user_ids` (string[], every phone that joined this table),
`status`. Lets several diners at one table add to a shared ticket, and scopes
what a diner's phone is allowed to read.

---

## Orders

### `orders`

| Attribute | Type | Notes |
| --- | --- | --- |
| `order_no` | string(20) | human-facing, `PREFIX-0042` |
| `idem_key` | string(64) | unique index, retry safety |
| `channel` | enum | `qr` \| `waiter` \| `counter` \| `takeaway` \| `delivery` |
| `table_id`, `session_id` | string | null for takeaway |
| `shift_id` | string | set at creation, immutable |
| `status` | enum | `PENDING` → `ACCEPTED` → `PREPARING` → `READY` → `SERVED` → `CLOSED`, plus `REJECTED`, `CANCELLED` |
| `alert_level` | int | 0–4, driven by `kitchen-escalate` |
| `accepted_at`, `accepted_by` | datetime/string | stops the ping |
| `rejected_at`, `rejected_by` | | |
| `reject_reason_code` | enum | `out_of_stock` \| `too_busy` \| `item_unavailable` \| `closing_soon` \| `duplicate` \| `customer_request` \| `other` |
| `reject_reason_note` | string(500) | **required when code is `other`** |
| `subtotal`, `discount_total`, `tax_total`, `service_total`, `tip_total`, `total` | int | |
| `currency_code` | string(3) | snapshot, historical orders stay correct if currency changes |
| `payment_status` | enum | `unpaid` \| `partial` \| `paid` \| `refunded` |
| `placed_by` | string | staff `$id`, or `anon:<userId>` for QR |
| `guest_count` | int | |
| `notes` | string(500) | allergies etc. |

Indexes: `shift_id`, `status`, `table_id`, `session_id`, `$createdAt`,
unique(`idem_key`), unique(`order_no`).

Permissions: create **none** (functions only). Read `T:cooks`, `T:waiters`,
`T:cashiers`, `T:managers`, `T:admins` at collection level; diners get a
**document-level read** granted to their anonymous user ID at creation, so a
phone sees only its own table's orders. Update restricted per role (doc 07).

### `order_items`

`order_id`, `menu_item_id`, `name_snapshot`, `unit_price` (int),
`qty`, `addons` (string 2000, JSON snapshot `[{option_id,name,price_delta,qty}]`),
`line_total`, `notes`, `station`, `status` (`queued`/`preparing`/`ready`/`served`/`void`),
`void_reason`, `voided_by`, `course` (int, starter/main/dessert firing),
`seat_no` (int, drives split-by-seat).

Snapshotting name and price is deliberate: editing a menu price must never
rewrite yesterday's receipts.

### `payments`

`order_id`, `shift_id`, `method_id`, `method_kind_snapshot`, `amount` (int),
`tip` (int), `change_given` (int), `reference`, `status`
(`pending`/`captured`/`failed`/`refunded`/`voided`), `gateway_ref`,
`gateway_payload` (string 4000), `taken_by`, `refund_of` (payment `$id`).

Multiple rows per order = split payment. Indexes: `order_id`, `shift_id`,
`status`.

---

## Shifts

### `shifts`

| Attribute | Type | Notes |
| --- | --- | --- |
| `code` | string | `2026-08-01-A` |
| `status` | enum | `open` \| `closing` \| `closed` \| `reopened` |
| `opened_by`, `opened_at` | | |
| `opening_floats` | string(2000) | JSON `{method_id: amount}` |
| `float_source` | enum | `zero` \| `manual` \| `carried_over`, audit of which policy applied |
| `carried_from_shift_id` | string | only set when an admin explicitly carried over |
| `closed_by`, `closed_at` | | |
| `expected` | string(2000) | JSON `{method_id: amount}` computed by `shift-close` |
| `counted` | string(2000) | JSON, blind count keyed by the closer |
| `variance` | string(2000) | JSON `{method_id: counted − expected}` |
| `expense_total`, `sales_total`, `tax_total`, `tip_total`, `discount_total`, `void_total`, `refund_total` | int | |
| `stock_check_status` | enum | `pending` \| `complete` |
| `notes` | string(1000) | |
| `posted_to_ledger` | bool | |

Only one shift may be `open` at a time per venue, enforced by `shift-close`/
`shift-open` functions checking for an existing open shift.

### `shift_expenses`

`shift_id`, `category` (enum `supplies` \| `transport` \| `utilities` \| `repairs`
\| `staff_advance` \| `petty_cash` \| `other`), `payee`, `amount` (int),
`paid_from_method_id`, `note`, `receipt_file_id`, `created_by`, `approved_by`,
`approval_status` (enum, expenses above a threshold need manager approval).

### `shift_stock_checks`

One row per ingredient per closing shift. `shift_id`, `ingredient_id`,
`opening_qty`, `theoretical_qty`, `counted_qty` (nullable, count is optional
for non-critical items), `status` (enum `OK` \| `LOW` \| `OUT`),
`status_source` (enum `auto` \| `manual_override`), `variance_qty`,
`variance_value`, `checked_by`, `note`.

---

## Inventory

### `ingredients`

`name`, `unit` (enum `g` \| `kg` \| `ml` \| `l` \| `each` \| `pack`),
`base_unit_cost` (int, rolling weighted average), `current_qty` (float),
`par_level` (float), `low_threshold` (float, absolute; falls back to
`settings.low_stock_default_bp` × par when null), `critical` (bool, critical
items must be counted at every close), `supplier_id`, `category`,
`shelf_life_days`, `active`.

### `recipes`

`menu_item_id` (nullable), `addon_option_id` (nullable, add-ons consume stock
too), `ingredient_id`, `qty_per_unit` (float), `wastage_bp` (int, expected
trim/spill %). Exactly one of the two parent IDs is set.

This is the "mark which meal uses which ingredient" mapping and the basis of all
theoretical usage.

### `suppliers`

`name`, `contact`, `phone`, `email`, `payment_terms`, `active`.

### `purchases` / `purchase_items`

`purchases`: `supplier_id`, `invoice_no`, `purchased_at`, `subtotal`, `tax`,
`total`, `paid_from_method_id`, `shift_id` (when bought from the till),
`received_by`, `document_file_id`.

`purchase_items`: `purchase_id`, `ingredient_id`, `qty`, `unit_cost`,
`line_total`. Writing one updates the ingredient's weighted-average cost and
emits a `stock_movements` row.

### `stock_movements`

Append-only ledger: `ingredient_id`, `type` (enum `purchase` \| `sale_depletion`
\| `waste` \| `adjustment` \| `count_correction` \| `transfer`), `qty_delta`
(float, signed), `unit_cost`, `ref_type`, `ref_id`, `shift_id`, `created_by`,
`note`. `ingredients.current_qty` is a materialised sum, rebuildable from here.

### `stock_flags`

Raised by `stock-variance`: `ingredient_id`, `period_start`, `period_end`,
`theoretical_usage`, `actual_usage`, `variance_qty`, `variance_bp`,
`variance_value`, `severity` (enum `info` \| `warn` \| `critical`),
`likely_causes` (string[], `over_portioning`, `waste_unrecorded`,
`unrecorded_sale`, `theft`, `recipe_wrong`, `count_error`), `status`
(`open`/`investigating`/`resolved`), `resolution_note`, `resolved_by`.

---

## Accounting

### `journal_entries` + `journal_lines`

Double-entry, so the numbers reconcile rather than merely tally.

`journal_entries`: `date`, `source` (enum `shift_close` \| `purchase` \|
`expense` \| `refund` \| `adjustment`), `source_id`, `shift_id`, `memo`,
`posted_by`, `reversed_by`.

`journal_lines`: `entry_id`, `account_code`, `debit` (int), `credit` (int),
`memo`. Every entry must balance, `shift-close` refuses to post otherwise.

### `accounts` (chart of accounts, seeded)

`code`, `name`, `type` (enum `asset` \| `liability` \| `equity` \| `revenue` \|
`expense`), `parent_code`, `system` (bool, protected from deletion).

Seed: `1000` Cash on hand, `1010` Card clearing, `1020` Mobile money clearing,
`1200` Inventory, `2100` Tax payable, `2200` Tips payable, `4000` Food sales,
`4010` Beverage sales, `4900` Discounts (contra), `5000` COGS,
`6000`–`6xxx` operating expenses mirroring the expense categories,
`7000` Cash over/short.

---

## Access & audit

### `staff_profiles`

`user_id` (Appwrite account `$id`), `display_name`, `role` (enum, mirrors team
for fast client checks; the team is authoritative), `pin_hash` (Argon2id, set
via function only), `pin_set_at`, `active`, `phone`, `hired_at`,
`can_open_shift`, `can_discount_up_to_bp`, `can_void` (bool).

### `audit_log`

Append-only, read `T:admins`+`T:managers`, write functions only: `actor_id`,
`actor_role`, `action`, `entity_type`, `entity_id`, `before` (string 4000),
`after` (string 4000), `ip`, `device`, `shift_id`, `$createdAt`.

Logged actions: price change, item 86'd, discount applied, item voided, order
rejected, payment refunded, shift opened/closed, float carried over, stock
adjusted, role changed, settings changed.
