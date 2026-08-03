// Declarative schema for SNPOS. Consumed by provision.mjs.
// Types: s(size) string, i integer, f float, b boolean, d datetime, e(...) enum
// Suffix ! = required, [] = array. Money fields are integers in minor units.

export const DB_ID = process.env.DB_ID || 'snpos';

export const TEAMS = [
  { id: 'cooks', name: 'Cooks' },
  { id: 'waiters', name: 'Waiters' },
  { id: 'cashiers', name: 'Cashiers' },
  { id: 'managers', name: 'Managers' },
  { id: 'admins', name: 'Admins' },
];

export const BUCKETS = [
  {
    id: 'menu-images',
    name: 'Menu images',
    maxSize: 10 * 1024 * 1024,
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'avif'],
    read: ['any'],
    write: ['team:managers', 'team:admins'],
  },
  {
    id: 'branding',
    name: 'Branding',
    maxSize: 5 * 1024 * 1024,
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'svg', 'ico'],
    read: ['any'],
    write: ['team:admins'],
  },
  {
    id: 'receipts',
    name: 'Expense receipts',
    maxSize: 10 * 1024 * 1024,
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
    read: ['team:managers', 'team:admins'],
    write: ['team:cashiers', 'team:managers', 'team:admins'],
  },
];

const ALL_STAFF = ['team:cooks', 'team:waiters', 'team:cashiers', 'team:managers', 'team:admins'];
const MGMT = ['team:managers', 'team:admins'];
const ADMIN = ['team:admins'];

/**
 * perms.read / .create / .update / .delete — arrays of Appwrite role strings.
 * An empty create/update array means: functions only (server API key).
 */
export const COLLECTIONS = [
  // ------------------------------------------------------------------ venues
  {
    id: 'venues',
    name: 'Venues',
    perms: { read: ['any'], create: ADMIN, update: ADMIN, delete: ADMIN },
    attributes: [
      ['name', 's', 120, true],
      ['slug', 's', 60, true],
      ['address', 's', 300, false],
      ['phone', 's', 40, false],
      ['timezone', 's', 64, true, 'Africa/Accra'],
      ['active', 'b', null, true, true],
      ['sort', 'i', null, true, 0],
      // Optional per-venue branding; falls back to global settings when blank.
      ['primary_color', 's', 9, false],
      ['secondary_color', 's', 9, false],
      ['logo_light_id', 's', 64, false],
      // Operational settings that genuinely differ between locations.
      ['shift_float_policy', 'e', ['inherit', 'zero', 'carry_over', 'fixed', 'prompt'], true, 'inherit'],
      ['shift_float_default', 'i', null, true, 0],
      ['order_number_prefix', 's', 8, false],
      ['tax_rate_bp', 'i', null, false],
      // Trading hours, same JSON shape as menu availability. Used to decide
      // whether the venue is open now and, when it isn't, which future slots a
      // customer may pre-order into.
      ['opening_hours', 's', 4000, false],
      ['holiday_closures', 's', 4000, false], // dated exceptions
      // A QR for people not sitting at a table — the counter queue, a poster
      // in the window, a flyer. Opens the menu in takeaway mode.
      ['walkin_token', 's', 64, false],
    ],
    indexes: [['slug_unique', 'unique', ['slug']], ['active_sort', 'key', ['active', 'sort']]],
  },
  {
    // Per-venue price / availability override on the shared menu.
    // No row means: use the master menu item as-is.
    id: 'venue_menu_items',
    name: 'Venue menu overrides',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, true],
      ['menu_item_id', 's', 64, true],
      ['available', 'b', null, true, true],
      ['price_override', 'i', null, false],
      ['sold_out_until', 'd', null, false],
      ['availability_override', 's', 4000, false],
    ],
    indexes: [['venue_item', 'unique', ['venue_id', 'menu_item_id']]],
  },

  // ---------------------------------------------------------------- settings
  {
    id: 'settings',
    name: 'Settings',
    perms: { read: ['any'], create: [], update: ADMIN, delete: [] },
    attributes: [
      ['restaurant_name', 's', 120, true],
      ['timezone', 's', 64, true, 'Africa/Accra'],
      ['currency_code', 's', 3, true, 'GHS'],
      ['currency_symbol', 's', 8, true, 'GH₵'],
      ['currency_decimals', 'i', null, true, 2],
      ['symbol_position', 'e', ['before', 'after'], true, 'before'],
      ['primary_color', 's', 9, true, '#0F766E'],
      ['secondary_color', 's', 9, true, '#F59E0B'],
      ['accent_color', 's', 9, false],
      ['logo_light_id', 's', 64, false],
      ['logo_dark_id', 's', 64, false],
      ['favicon_id', 's', 64, false],
      ['tax_rate_bp', 'i', null, true, 0],
      ['tax_inclusive', 'b', null, true, true],
      ['service_charge_bp', 'i', null, true, 0],
      // What a shift starts with in the drawer.
      //   zero       nothing carried over; count it in each time
      //   carry_over what the last shift counted at close
      //   fixed      always shift_float_default
      //   prompt     ask, with nothing filled in
      ['shift_float_policy', 'e', ['zero', 'carry_over', 'fixed', 'prompt'], true, 'zero'],
      ['shift_float_default', 'i', null, true, 0],
      // Whether a drawer may finish the night below nothing. It should not be
      // possible — you cannot hand over less than no money — so a negative
      // count almost always means an expense went unrecorded. Left as a switch
      // because a restaurant that pays out of the till all evening may
      // genuinely need to close short and explain it.
      ['allow_negative_cash', 'b', null, false, false],
      ['kitchen_ack_sla_seconds', 'i', null, true, 60],
      ['kitchen_ping_max_level', 'i', null, true, 4],
      ['require_reject_reason', 'b', null, true, true],
      ['qr_orders_need_approval', 'b', null, true, false],
      ['order_number_prefix', 's', 8, false, 'ORD'],
      // Numbering the restaurant controls. `continuous` keeps counting
      // forever; `daily` starts again each morning, which is what most
      // kitchens shout across a pass. The counter is stored rather than
      // derived so that resetting it is a decision somebody makes, not a
      // side effect of deleting an old order.
      ['order_number_mode', 'e', ['continuous', 'daily'], false, 'continuous'],
      ['order_number_next', 'i', null, false, 1],
      ['order_number_padding', 'i', null, false, 4],
      ['order_number_reset_on', 'd', null, false],
      // Some restaurants do not take tips and do not want a box asking for one
      // on every bill. Off hides it on every screen rather than defaulting it
      // to zero, which staff still have to look at and skip past.
      ['tips_enabled', 'b', null, false, true],
      ['low_stock_default_bp', 'i', null, true, 3000],
      ['stock_variance_threshold_bp', 'i', null, true, 1000],
      ['stock_variance_value_floor', 'i', null, true, 2000],
      ['expense_approval_threshold', 'i', null, true, 20000],
      ['cash_variance_tolerance', 'i', null, true, 500],
      ['terminal_idle_lock_seconds', 'i', null, true, 180],
      // Language (feature 8). All other per-feature config lives in
      // feature_flags.config so it can be overridden per venue.
      ['default_locale', 's', 10, false, 'en'],
      ['enabled_locales', 's[]', 10, false],
      // Outbound email identity, shared by receipts and shift summaries.
      ['email_from_name', 's', 120, false],
      ['email_from_address', 's', 160, false],
      ['email_reply_to', 's', 160, false],
      // Storage layout. 'multi' = one bucket per purpose (the design intent);
      // 'single' = everything in one bucket with per-file permissions, which is
      // what a plan capped at one bucket forces. Apps read this to know where
      // to upload and must set explicit file permissions in 'single' mode.
      ['storage_mode', 'e', ['multi', 'single'], false, 'multi'],
      ['shared_bucket_id', 's', 64, false],
      // Which parts of the admin app each role may open, as JSON:
      // {"manager":["orders","reports"],"cashier":[]}. Admins are not listed
      // and never restricted — a switch that can lock the owner out of their
      // own settings is a switch that eventually will.
      ['role_access', 's', 2000, false],
      // The hour, in the restaurant's own timezone, at which the once-a-day
      // report and the nightly backup go out. After close, not at midnight —
      // a kitchen still serving at 00:30 would otherwise get yesterday's
      // figures while it is still making today's.
      ['daily_report_hour', 'i', null, false, 23],
    ],
  },
  {
    id: 'payment_methods',
    name: 'Payment methods',
    // Staff only. Guests never settle a bill in the app, so they never needed
    // to know what the restaurant accepts.
    perms: { read: ALL_STAFF, create: ADMIN, update: ADMIN, delete: ADMIN },
    attributes: [
      ['name', 's', 40, true],
      ['kind', 'e', ['cash', 'card', 'mobile_money', 'voucher', 'on_account'], true],
      ['enabled', 'b', null, true, true],
      ['sort', 'i', null, true, 0],
      ['opens_cash_drawer', 'b', null, true, false],
      ['requires_reference', 'b', null, true, false],
      ['counted_at_close', 'b', null, true, true],
      ['gateway', 'e', ['none', 'paystack', 'stripe'], true, 'none'],
      ['surcharge_bp', 'i', null, true, 0],
    ],
    indexes: [['enabled_sort', 'key', ['enabled', 'sort']]],
  },

  // -------------------------------------------------------------------- menu
  {
    id: 'categories',
    name: 'Categories',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['name', 's', 120, true],
      ['description', 's', 500, false],
      ['sort', 'i', null, true, 0],
      ['image_id', 's', 64, false],
      ['active', 'b', null, true, true],
      ['availability', 's', 4000, false],
      ['unavailable_display', 'e', ['grey', 'hide'], true, 'grey'],
      ['station', 'e', ['hot', 'cold', 'bar', 'dessert'], true, 'hot'],
      // Replaces `station` over time: a free-form key referencing `stations`,
      // so a restaurant can define Grill and Pastry rather than living with
      // whatever four names we happened to pick.
      ['station_key', 's', 40, false],
      // Shown only on the group-order menu. A hotel party ordering platters
      // does not want the a la carte list, and vice versa.
      ['group_only', 'b', null, false, false],
    ],
    indexes: [['active_sort', 'key', ['active', 'sort']]],
  },
  {
    id: 'menu_items',
    name: 'Menu items',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['category_id', 's', 64, true],
      ['name', 's', 160, true],
      ['description', 's', 1000, false],
      ['price', 'i', null, true, 0],
      ['image_id', 's', 64, false],
      ['image_focal_x', 'f', null, true, 0.5],
      ['image_focal_y', 'f', null, true, 0.5],
      ['sku', 's', 40, false],
      ['active', 'b', null, true, true],
      ['availability', 's', 4000, false],
      ['sold_out_until', 'd', null, false],
      ['prep_minutes', 'i', null, true, 10],
      ['station', 'e', ['hot', 'cold', 'bar', 'dessert', 'inherit'], true, 'inherit'],
      ['station_key', 's', 40, false],
      // Marked off by staff mid-service. `sold_out_until` already existed as a
      // timed block; these say who did it, when, and why — which is what makes
      // "this has been off for two days" a question anyone can answer.
      ['unavailable_since', 'd', null, false],
      ['unavailable_by', 's', 64, false],
      ['unavailable_reason', 's', 200, false],
      // Only shown on the group-order menu. A hotel party ordering platters
      // does not want the à la carte list, and vice versa.
      ['group_only', 'b', null, false, false],
      ['tags', 's[]', 40, false],
      ['sort', 'i', null, true, 0],
      ['track_stock', 'b', null, true, false],
    ],
    indexes: [
      ['category_active', 'key', ['category_id', 'active']],
      ['name_search', 'fulltext', ['name']],
    ],
  },
  {
    /**
     * A dish can sit in several categories at once — Jollof in both "Lunch"
     * and "Mains" — and each category has its own availability hours, so the
     * same dish appears and disappears at different times depending on which
     * section the customer is looking at.
     *
     * menu_items.category_id remains the PRIMARY category: it decides the
     * default station and gives every dish one home even if these rows are
     * never created.
     */
    id: 'menu_item_categories',
    name: 'Menu item categories',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['menu_item_id', 's', 64, true],
      ['category_id', 's', 64, true],
      ['sort', 'i', null, false, 0], // position within THIS category
      ['active', 'b', null, false, true], // hide from one category, keep others
    ],
    indexes: [
      ['item_category', 'unique', ['menu_item_id', 'category_id']],
      ['category', 'key', ['category_id', 'sort']],
      ['item', 'key', ['menu_item_id']],
    ],
  },
  {
    /**
     * Kitchen stations, defined by the restaurant rather than by us.
     *
     * A station is WHERE FOOD IS COOKED — hot line, grill, bar, pastry. It is
     * not a pickup point, which is where a customer collects. One kitchen with
     * three stations can serve four pickup points, and often does.
     */
    id: 'stations',
    name: 'Stations',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, true],
      ['key', 's', 40, true], // stable id used on items and tickets
      ['name', 's', 80, true], // what staff see
      ['colour', 's', 9, false],
      ['sort', 'i', null, false, 0],
      ['active', 'b', null, false, true],
    ],
    indexes: [['venue_key', 'unique', ['venue_id', 'key']], ['venue_sort', 'key', ['venue_id', 'sort']]],
  },
  {
    id: 'addon_groups',
    name: 'Add-on groups',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['name', 's', 120, true],
      ['description', 's', 300, false], // shown under the group heading
      ['min_select', 'i', null, true, 0],
      ['max_select', 'i', null, true, 1],
      ['required', 'b', null, true, false],
      ['sort', 'i', null, true, 0],
    ],
  },
  {
    id: 'addon_options',
    name: 'Add-on options',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['group_id', 's', 64, true],
      ['name', 's', 120, true],
      ['price_delta', 'i', null, true, 0], // may be negative
      ['active', 'b', null, true, true],
      ['sort', 'i', null, true, 0],
      ['default_selected', 'b', null, true, false],
      ['max_qty', 'i', null, true, 1],
    ],
    indexes: [['group', 'key', ['group_id', 'sort']]],
  },
  {
    id: 'menu_item_addon_groups',
    name: 'Item add-on links',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['menu_item_id', 's', 64, true],
      ['group_id', 's', 64, true],
      ['sort', 'i', null, true, 0],
      ['price_delta_override', 'i', null, false],
      ['required_override', 'b', null, false],
    ],
    indexes: [['item', 'key', ['menu_item_id', 'sort']]],
  },

  // ------------------------------------------------------------------- floor
  {
    id: 'tables',
    name: 'Tables and areas',
    // Readable by guests, deliberately. A customer ordering from their phone
    // has to be able to say where they are sitting, and the qr_token stopped
    // being a meaningful secret the moment that list existed — anyone can pick
    // any seat from a dropdown whether or not they can read a token. Nothing
    // here is worth protecting: labels, zones and seat counts. Orders are
    // never paid by the customer and every one lands in front of staff.
    perms: { read: ['any'], create: MGMT, update: ALL_STAFF, delete: MGMT },
    attributes: [
      ['label', 's', 40, true],
      ['zone', 's', 60, false],
      // A place to sit is not always a table. "Poolside" has no number and no
      // fixed seat count; what the kitchen needs is somewhere to send the
      // waiter, and an area answers that as well as a table does.
      ['kind', 'e', ['table', 'area'], false, 'table'],
      // Whether a customer ordering from their phone may pick this themselves.
      ['guest_selectable', 'b', null, false, true],
      ['seats', 'i', null, true, 4],
      ['qr_token', 's', 64, true],
      ['status', 'e', ['free', 'seated', 'ordered', 'bill_requested', 'dirty'], true, 'free'],
      ['current_order_id', 's', 64, false],
      ['current_session_id', 's', 64, false],
      ['active', 'b', null, true, true],
      ['sort', 'i', null, true, 0],
    ],
    indexes: [['qr_token_unique', 'unique', ['qr_token']], ['zone_sort', 'key', ['zone', 'sort']]],
  },
  {
    id: 'dining_sessions',
    name: 'Dining sessions',
    perms: { read: ALL_STAFF, create: ['users'], update: ALL_STAFF, delete: [] },
    attributes: [
      ['table_id', 's', 64, true],
      ['opened_at', 'd', null, true],
      ['closed_at', 'd', null, false],
      ['guest_count', 'i', null, true, 1],
      ['anon_user_ids', 's[]', 64, false],
      ['status', 'e', ['open', 'billing', 'closed'], true, 'open'],
      ['shift_id', 's', 64, false],
    ],
    indexes: [['table_status', 'key', ['table_id', 'status']]],
  },

  // ------------------------------------------------------------------ orders
  {
    id: 'orders',
    name: 'Orders',
    // create by 'users' includes the anonymous sessions the customer menu
    // makes, which is what lets a guest who has only scanned a sticker place an
    // order. Prices are re-checked server-side by order-guard; a client is
    // never trusted on what something costs.
    //
    // read is NOT 'users'. It was, and that meant any guest who had scanned a
    // table code could read every order in the restaurant — the anonymous
    // session that lets them order is indistinguishable from any other. Staff
    // read the collection; a guest is granted read on their own order document
    // as it is created (see createOrder), which is all they ever needed.
    perms: { read: ALL_STAFF, create: ['users'], update: ALL_STAFF, delete: [] },
    attributes: [
      ['order_no', 's', 20, true],
      ['idem_key', 's', 64, true],
      ['version', 'i', null, true, 1],
      ['channel', 'e', ['qr', 'waiter', 'counter', 'takeaway', 'delivery'], true],
      ['table_id', 's', 64, false],
      ['session_id', 's', 64, false],
      // Optional: a pre-order placed while the restaurant is closed belongs to no
      // shift yet. It is stamped with the shift that is open when it fires.
      ['shift_id', 's', 64, false],
      // SCHEDULED = a pre-order waiting for its fire time. It is not shown to
      // the kitchen and does not alarm until then.
      ['status', 'e', ['SCHEDULED', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'CLOSED', 'REJECTED', 'CANCELLED'], true, 'PENDING'],
      ['alert_level', 'i', null, true, 0],
      ['accepted_at', 'd', null, false],
      ['accepted_by', 's', 64, false],
      ['rejected_at', 'd', null, false],
      ['rejected_by', 's', 64, false],
      ['reject_reason_code', 'e', ['out_of_stock', 'too_busy', 'item_unavailable', 'closing_soon', 'duplicate', 'customer_request', 'cannot_meet_slot', 'other'], false],
      ['reject_reason_note', 's', 500, false],
      ['subtotal', 'i', null, true, 0],
      ['discount_total', 'i', null, true, 0],
      ['tax_total', 'i', null, true, 0],
      ['service_total', 'i', null, true, 0],
      ['tip_total', 'i', null, true, 0],
      ['total', 'i', null, true, 0],
      ['currency_code', 's', 3, true],
      ['payment_status', 'e', ['unpaid', 'partial', 'paid', 'refunded'], true, 'unpaid'],
      ['placed_by', 's', 80, true],
      ['guest_count', 'i', null, true, 1],
      ['notes', 's', 500, false],
      // Where to find them when the food is ready. A table has a number; an
      // area does not, so the guest can add "by the pool bar, red shirt" and
      // save a waiter walking the whole terrace.
      ['seat_note', 's', 200, false],

      // --- Group orders. A hotel party ordering together, identified by the
      // reservation the kitchen and the front desk both recognise.
      ['is_group', 'b', null, false, false],
      ['group_reference', 's', 60, false],
      ['group_size', 'i', null, false, 0],
      ['group_contact_name', 's', 120, false],

      // --- Payment is always marked by staff. Guests never settle a bill in
      // the app, so no customer-facing route may write these two fields.
      ['marked_paid_by', 's', 64, false],
      ['marked_paid_at', 'd', null, false],

      // When the food left the pass, and when a booked order was released to
      // it. Separate from payment: a table is served long before it settles,
      // and a pre-order can be started early without changing when it was for.
      ['served_at', 'd', null, false],
      ['fired_at', 'd', null, false],

      // --- Who's eating (features 1, 5, 6, 7)
      ['customer_id', 's', 64, false],
      ['customer_name', 's', 160, false],
      ['customer_phone', 's', 40, false],
      ['customer_email', 's', 160, false],
      ['email_source', 'e', ['guest_at_order', 'staff_entered', 'customer_profile', 'declined'], false],
      ['locale', 's', 10, false],

      // --- Takeaway and delivery (feature 2)
      ['fulfilment', 'e', ['dine_in', 'takeaway', 'delivery'], false, 'dine_in'],
      ['pickup_point_id', 's', 64, false],

      // --- Scheduled / pre-orders
      // Placed while the restaurant is closed (or in advance while open) for a
      // future time. `scheduled_for` is when the customer wants it; `fire_at`
      // is when the kitchen should be told, worked back from prep time. Until
      // fire_at the order sits in `scheduled` and never alarms the kitchen.
      ['is_preorder', 'b', null, false, false],
      ['scheduled_for', 'd', null, false],
      ['fire_at', 'd', null, false],
      ['slot_id', 's', 64, false],
      ['placed_while_closed', 'b', null, false, false],
      ['delivery_zone_id', 's', 64, false],
      ['delivery_address', 's', 500, false],
      ['delivery_fee', 'i', null, false, 0],
      ['delivery_status', 'e', ['pending', 'ready', 'dispatched', 'delivered', 'failed'], false],
      ['driver_name', 's', 120, false],
      ['quoted_wait_minutes', 'i', null, false], // set by busy mode (feature 11)

      // --- Discounts and loyalty
      ['discounts_applied', 's', 4000, false], // JSON snapshot of each redemption
      ['loyalty_points_earned', 'i', null, false, 0],
      ['loyalty_points_redeemed', 'i', null, false, 0],
    ],
    indexes: [
      ['idem_unique', 'unique', ['idem_key']],
      // Order numbers restart per venue, so uniqueness is scoped to the venue.
      ['order_no_unique', 'unique', ['venue_id', 'order_no']],
      // The unique index above cannot be queried on its own: order_no is its
      // second column, and Appwrite will only use an index from the left. A
      // plain index makes "which orders are still on a placeholder" answerable.
      ['order_no', 'key', ['order_no']],
      ['shift_status', 'key', ['shift_id', 'status']],
      ['status_created', 'key', ['status', '$createdAt']],
      ['session', 'key', ['session_id']],
      ['table', 'key', ['table_id']],
      ['fulfilment_status', 'key', ['venue_id', 'fulfilment', 'status']],
      ['pickup_point', 'key', ['pickup_point_id', 'scheduled_for']],
      ['due', 'key', ['venue_id', 'status', 'fire_at']], // drives the fire-time sweep
      ['customer', 'key', ['customer_id']],
    ],
  },
  {
    id: 'order_items',
    name: 'Order items',
    // Read is staff-only for the same reason as `orders`; the guest gets their
    // own lines granted per document at creation.
    perms: { read: ALL_STAFF, create: ['users'], update: ALL_STAFF, delete: ALL_STAFF },
    attributes: [
      ['order_id', 's', 64, true],
      ['menu_item_id', 's', 64, true],
      ['name_snapshot', 's', 160, true],
      ['unit_price', 'i', null, true, 0],
      ['qty', 'i', null, true, 1],
      ['addons', 's', 2000, false],
      ['line_total', 'i', null, true, 0],
      ['notes', 's', 300, false],
      ['station', 'e', ['hot', 'cold', 'bar', 'dessert'], true, 'hot'],
      ['station_key', 's', 40, false],
      ['status', 'e', ['queued', 'preparing', 'ready', 'served', 'void'], true, 'queued'],
      // When the kitchen should have this out by, so an overdue ticket can
      // ping without anyone doing mental arithmetic mid-service.
      ['due_at', 'd', null, false],
      ['void_reason', 's', 300, false],
      ['voided_by', 's', 64, false],
      ['course', 'i', null, true, 1],
      ['seat_no', 'i', null, false],
    ],
    indexes: [['order', 'key', ['order_id']], ['station_status', 'key', ['station', 'status']]],
  },
  {
    id: 'payments',
    name: 'Payments',
    // Taking money is front-line work; reversing it is not.
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: MGMT, delete: [] },
    attributes: [
      ['order_id', 's', 64, true],
      ['shift_id', 's', 64, true],
      ['method_id', 's', 64, true],
      ['method_kind_snapshot', 's', 20, true],
      ['amount', 'i', null, true, 0],
      ['tip', 'i', null, true, 0],
      ['change_given', 'i', null, true, 0],
      ['reference', 's', 120, false],
      ['status', 'e', ['pending', 'captured', 'failed', 'refunded', 'voided'], true, 'captured'],
      ['gateway_ref', 's', 120, false],
      ['gateway_payload', 's', 4000, false],
      ['taken_by', 's', 64, true],
      ['refund_of', 's', 64, false],
      ['refund_reason', 's', 300, false],
    ],
    indexes: [['order', 'key', ['order_id']], ['shift_status', 'key', ['shift_id', 'status']]],
  },

  // ------------------------------------------------------------------ shifts
  {
    id: 'shifts',
    name: 'Shifts',
    // ALL_STAFF rather than a cashier-only role because who may open a till is
    // a decision the restaurant makes per person (can_open_shift on their
    // profile), not one we make for them by job title. On a quiet shift the
    // cook IS the cashier.
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: ALL_STAFF, delete: [] },
    attributes: [
      ['code', 's', 40, true],
      ['status', 'e', ['open', 'closing', 'closed', 'reopened'], true, 'open'],
      ['opened_by', 's', 64, true],
      ['opened_at', 'd', null, true],
      ['opening_floats', 's', 2000, true],
      ['float_source', 'e', ['zero', 'manual', 'carried_over'], true, 'zero'],
      ['carried_from_shift_id', 's', 64, false],
      ['carry_approved_by', 's', 64, false],
      ['closed_by', 's', 64, false],
      ['closed_at', 'd', null, false],
      ['expected', 's', 2000, false],
      ['counted', 's', 2000, false],
      ['variance', 's', 2000, false],
      ['variance_note', 's', 1000, false],
      ['sales_total', 'i', null, true, 0],
      ['expense_total', 'i', null, true, 0],
      ['tax_total', 'i', null, true, 0],
      ['tip_total', 'i', null, true, 0],
      ['discount_total', 'i', null, true, 0],
      ['void_total', 'i', null, true, 0],
      ['refund_total', 'i', null, true, 0],
      ['cogs_total', 'i', null, true, 0],
      ['covers', 'i', null, true, 0],
      ['stock_check_status', 'e', ['pending', 'complete'], true, 'pending'],
      ['posted_to_ledger', 'b', null, true, false],
      ['notes', 's', 1000, false],
    ],
    // Only one shift may be `open` per venue — enforced by the shift functions,
    // with this index making the check a single fast lookup.
    indexes: [['venue_status_opened', 'key', ['venue_id', 'status', 'opened_at']], ['code_unique', 'unique', ['venue_id', 'code']]],
  },
  {
    id: 'shift_expenses',
    name: 'Shift expenses',
    perms: { read: ['team:cashiers', ...MGMT], create: ['team:cashiers', ...MGMT], update: MGMT, delete: ADMIN },
    attributes: [
      ['shift_id', 's', 64, false], // blank = recorded outside a shift
      // The old fixed list. Kept because an enum cannot be widened in place
      // without dropping the column and the data with it; `category_key` is
      // what the app reads and writes now, and it points at a row the
      // restaurant created in `expense_categories`.
      ['category', 'e', ['supplies', 'transport', 'utilities', 'repairs', 'staff_advance', 'petty_cash', 'other'], true],
      ['category_key', 's', 60, false],
      ['payee', 's', 160, false],
      // Who the money went to. Often there is no supplier at all — a driver, a
      // cook sent to the market, a one-off stall — and pretending otherwise is
      // what makes people type "market" into a supplier field forever.
      ['paid_to_kind', 'e', ['supplier', 'staff', 'open_market', 'other'], false, 'other'],
      ['supplier_id', 's', 64, false],
      ['paid_to_staff_id', 's', 64, false],
      ['amount', 'i', null, true, 0],
      ['paid_from_method_id', 's', 64, true],
      ['note', 's', 500, false],
      ['receipt_file_id', 's', 64, false],
      ['created_by', 's', 64, true],
      ['approved_by', 's', 64, false],
      ['approval_status', 'e', ['not_required', 'pending', 'approved', 'rejected'], true, 'not_required'],
    ],
    indexes: [['shift', 'key', ['shift_id']], ['supplier', 'key', ['supplier_id']]],
  },
  {
    /**
     * Every time an item went off the menu, and when it came back.
     *
     * Kept as its own record rather than as a field on the dish, because the
     * questions worth asking are historical: what did we run out of during
     * that shift, and what has been off for two days without anyone noticing.
     * A field can only answer "is it off right now".
     */
    id: 'item_availability',
    name: 'Item availability log',
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: ALL_STAFF, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, true],
      ['menu_item_id', 's', 64, true],
      ['name_snapshot', 's', 160, true],
      ['shift_id', 's', 64, false],
      ['marked_off_at', 'd', null, true],
      ['marked_off_by', 's', 64, false],
      ['marked_off_name', 's', 120, false],
      ['reason', 's', 200, false],
      ['restored_at', 'd', null, false],
      ['restored_by', 's', 64, false],
      // Set once the "still off after N hours" email has gone, so the admin is
      // told once rather than every hour until somebody acts.
      ['alerted_at', 'd', null, false],
    ],
    indexes: [
      ['item_marked', 'key', ['menu_item_id', 'marked_off_at']],
      ['shift', 'key', ['shift_id']],
      ['open_alerts', 'key', ['restored_at', 'alerted_at']],
    ],
  },
  {
    /**
     * One row per notification actually sent about an order.
     *
     * Exists so that "we told them" is a fact rather than an assumption. The
     * update event fires on every edit to an order, and without a record here
     * a customer would be told four times that their food is ready — which is
     * how people learn to ignore everything you send them.
     */
    id: 'order_notices',
    name: 'Order notices',
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: ALL_STAFF, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, true],
      ['order_id', 's', 64, true],
      ['stage', 'e', ['accepted', 'ready', 'group_placed'], true],
      ['to_email', 's', 160, false],
      ['status', 'e', ['queued', 'sent', 'failed', 'skipped'], true, 'queued'],
      ['last_error', 's', 500, false],
    ],
    indexes: [['order_stage', 'key', ['order_id', 'stage']]],
  },
  {
    /**
     * Expense categories, defined by the restaurant.
     *
     * `account_code` is what makes a category more than a label: it decides
     * which line of the accounts the money lands on when the shift is closed.
     */
    id: 'expense_categories',
    name: 'Expense categories',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['key', 's', 60, true],
      ['name', 's', 80, true],
      ['account_code', 's', 10, false, '6090'],
      ['sort', 'i', null, false, 0],
      ['active', 'b', null, false, true],
    ],
    indexes: [['key_unique', 'unique', ['key']]],
  },
  {
    /**
     * What was actually bought on an expense.
     *
     * An expense of GHS 400 tells you money left. These lines tell you it was
     * 20kg of rice and 5kg of onions, which is what lets the same trip raise
     * stock instead of being typed in twice.
     */
    id: 'expense_items',
    name: 'Expense items',
    perms: { read: ['team:cashiers', ...MGMT], create: ['team:cashiers', ...MGMT], update: MGMT, delete: MGMT },
    attributes: [
      ['expense_id', 's', 64, true],
      ['ingredient_id', 's', 64, true],
      ['name_snapshot', 's', 160, true],
      ['qty', 'f', null, true, 0],
      ['unit_cost', 'i', null, false, 0],
      ['line_total', 'i', null, false, 0],
      // Whether this line has already been added to stock. Set once, so
      // editing an expense cannot deliver the same sack of rice twice.
      ['stocked', 'b', null, false, false],
    ],
    indexes: [['expense', 'key', ['expense_id']], ['ingredient', 'key', ['ingredient_id']]],
  },
  {
    /** Ingredient groupings — Produce, Dry goods, Drinks — the restaurant's own. */
    id: 'ingredient_categories',
    name: 'Ingredient categories',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['key', 's', 60, true],
      ['name', 's', 80, true],
      ['sort', 'i', null, false, 0],
      ['active', 'b', null, false, true],
    ],
    indexes: [['key_unique', 'unique', ['key']]],
  },
  {
    id: 'shift_stock_checks',
    name: 'Shift stock checks',
    perms: { read: ALL_STAFF, create: ['team:cashiers', 'team:cooks', ...MGMT], update: ['team:cashiers', 'team:cooks', ...MGMT], delete: [] },
    attributes: [
      ['shift_id', 's', 64, true],
      ['ingredient_id', 's', 64, true],
      ['opening_qty', 'f', null, true, 0],
      ['theoretical_qty', 'f', null, true, 0],
      ['counted_qty', 'f', null, false],
      ['status', 'e', ['OK', 'LOW', 'OUT'], true, 'OK'],
      ['status_source', 'e', ['auto', 'manual_override'], true, 'auto'],
      ['variance_qty', 'f', null, true, 0],
      ['variance_value', 'i', null, true, 0],
      ['checked_by', 's', 64, false],
      ['note', 's', 300, false],
    ],
    indexes: [['shift_ing', 'key', ['shift_id', 'ingredient_id']]],
  },

  // --------------------------------------------------------------- inventory
  {
    id: 'ingredients',
    name: 'Ingredients',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['name', 's', 160, true],
      ['unit', 'e', ['g', 'kg', 'ml', 'l', 'each', 'pack'], true],
      ['base_unit_cost', 'i', null, true, 0],
      ['current_qty', 'f', null, true, 0],
      ['par_level', 'f', null, true, 0],
      ['low_threshold', 'f', null, false],
      ['critical', 'b', null, true, false],
      ['supplier_id', 's', 64, false],
      ['category', 's', 80, false],
      // What buying this counts as, so recording a delivery does not also ask
      // somebody to classify it. Rice is always Supplies; nobody should have
      // to say so twice a week.
      ['expense_category_key', 's', 60, false],
      ['shelf_life_days', 'i', null, false],
      // Persistence tracking for the shift-close summary: how many shifts in a
      // row this has come out low or out of stock. Reset the moment a count
      // comes back healthy. Anything at 3 or more is escalated by name.
      ['consecutive_low_count', 'i', null, false, 0],
      ['consecutive_low_since', 'd', null, false],
      ['last_low_severity', 'e', ['low', 'out'], false],
      ['active', 'b', null, true, true],
    ],
    indexes: [['active_name', 'key', ['active', 'name']], ['critical', 'key', ['critical']]],
  },
  {
    id: 'recipes',
    name: 'Recipes',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['menu_item_id', 's', 64, false],
      ['addon_option_id', 's', 64, false],
      ['ingredient_id', 's', 64, true],
      ['qty_per_unit', 'f', null, true, 0],
      ['wastage_bp', 'i', null, true, 0],
    ],
    indexes: [['item', 'key', ['menu_item_id']], ['ingredient', 'key', ['ingredient_id']], ['addon', 'key', ['addon_option_id']]],
  },
  {
    id: 'suppliers',
    name: 'Suppliers',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['name', 's', 160, true],
      ['contact', 's', 120, false],
      ['phone', 's', 40, false],
      ['email', 's', 160, false],
      ['payment_terms', 's', 80, false],
      ['active', 'b', null, true, true],
    ],
  },
  {
    id: 'purchases',
    name: 'Purchases',
    perms: { read: MGMT, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['supplier_id', 's', 64, true],
      ['invoice_no', 's', 80, false],
      ['purchased_at', 'd', null, true],
      ['subtotal', 'i', null, true, 0],
      ['tax', 'i', null, true, 0],
      ['total', 'i', null, true, 0],
      ['paid_from_method_id', 's', 64, false],
      ['shift_id', 's', 64, false],
      ['received_by', 's', 64, true],
      ['document_file_id', 's', 64, false],
    ],
    indexes: [['supplier_date', 'key', ['supplier_id', 'purchased_at']]],
  },
  {
    id: 'purchase_items',
    name: 'Purchase items',
    perms: { read: MGMT, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['purchase_id', 's', 64, true],
      ['ingredient_id', 's', 64, true],
      ['qty', 'f', null, true, 0],
      ['unit_cost', 'i', null, true, 0],
      ['line_total', 'i', null, true, 0],
    ],
    indexes: [['purchase', 'key', ['purchase_id']], ['ingredient', 'key', ['ingredient_id']]],
  },
  {
    id: 'stock_movements',
    name: 'Stock movements',
    // A movement is something that happened. It is never edited; a mistake is
    // corrected by recording the opposite movement, so the trail stays honest.
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: [], delete: [] },
    attributes: [
      ['ingredient_id', 's', 64, true],
      ['type', 'e', ['purchase', 'sale_depletion', 'waste', 'adjustment', 'count_correction', 'transfer'], true],
      ['qty_delta', 'f', null, true, 0],
      ['unit_cost', 'i', null, true, 0],
      ['ref_type', 's', 40, false],
      ['ref_id', 's', 64, false],
      ['shift_id', 's', 64, false],
      ['created_by', 's', 64, false],
      ['note', 's', 300, false],
    ],
    indexes: [['ingredient_created', 'key', ['ingredient_id', '$createdAt']], ['shift', 'key', ['shift_id']]],
  },
  {
    id: 'stock_flags',
    name: 'Stock variance flags',
    perms: { read: MGMT, create: ALL_STAFF, update: MGMT, delete: ADMIN },
    attributes: [
      ['ingredient_id', 's', 64, true],
      ['period_start', 'd', null, true],
      ['period_end', 'd', null, true],
      ['theoretical_usage', 'f', null, true, 0],
      ['actual_usage', 'f', null, true, 0],
      ['variance_qty', 'f', null, true, 0],
      ['variance_bp', 'i', null, true, 0],
      ['variance_value', 'i', null, true, 0],
      ['severity', 'e', ['info', 'warn', 'critical'], true, 'warn'],
      ['likely_causes', 's[]', 40, false],
      ['status', 'e', ['open', 'investigating', 'resolved'], true, 'open'],
      ['resolution_note', 's', 1000, false],
      ['resolved_by', 's', 64, false],
    ],
    indexes: [['status_severity', 'key', ['status', 'severity']], ['ingredient', 'key', ['ingredient_id']]],
  },

  // -------------------------------------------------------------- accounting
  {
    id: 'accounts',
    name: 'Chart of accounts',
    perms: { read: MGMT, create: ADMIN, update: ADMIN, delete: ADMIN },
    attributes: [
      ['code', 's', 10, true],
      ['name', 's', 120, true],
      ['type', 'e', ['asset', 'liability', 'equity', 'revenue', 'expense'], true],
      ['parent_code', 's', 10, false],
      ['system', 'b', null, true, false],
    ],
    indexes: [['code_unique', 'unique', ['code']]],
  },
  {
    id: 'journal_entries',
    name: 'Journal entries',
    // Append-only on purpose: a wrong entry is corrected by posting a reversal,
    // never by editing history. Books that can be quietly edited are not books.
    // Created by whoever closes the shift, which may be the cook.
    perms: { read: MGMT, create: ALL_STAFF, update: [], delete: [] },
    attributes: [
      ['date', 'd', null, true],
      ['source', 'e', ['shift_close', 'purchase', 'expense', 'refund', 'adjustment', 'reversal'], true],
      ['source_id', 's', 64, false],
      ['shift_id', 's', 64, false],
      ['memo', 's', 500, false],
      ['posted_by', 's', 64, true],
      ['reversed_by', 's', 64, false],
    ],
    indexes: [['date', 'key', ['date']], ['shift', 'key', ['shift_id']]],
  },
  {
    id: 'journal_lines',
    name: 'Journal lines',
    perms: { read: MGMT, create: ALL_STAFF, update: [], delete: [] },
    attributes: [
      ['entry_id', 's', 64, true],
      ['account_code', 's', 10, true],
      ['debit', 'i', null, true, 0],
      ['credit', 'i', null, true, 0],
      ['memo', 's', 300, false],
    ],
    indexes: [['entry', 'key', ['entry_id']], ['account', 'key', ['account_code']]],
  },

  // -------------------------------------------------------------- people/ops
  {
    id: 'staff_profiles',
    name: 'Staff profiles',
    // Readable by all staff because the shared terminal and kitchen screen
    // match a typed PIN against this list.
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      // Optional: a profile is created when someone is invited, before they
      // have accepted and therefore before a user account exists. First sign-in
      // matches on email and stamps the id.
      ['user_id', 's', 64, false],
      ['email', 's', 160, false],
      ['display_name', 's', 120, true],
      ['role', 'e', ['cook', 'waiter', 'cashier', 'manager', 'admin'], true],
      ['pin_hash', 's', 255, false],
      ['pin_set_at', 'd', null, false],
      ['active', 'b', null, true, true],
      ['phone', 's', 40, false],
      ['hired_at', 'd', null, false],
      ['can_open_shift', 'b', null, true, false],
      ['can_close_shift', 'b', null, true, false],
      ['can_void', 'b', null, true, false],
      ['can_discount_up_to_bp', 'i', null, true, 0],
      ['can_mark_paid', 'b', null, false, true],
      ['can_apply_discount_codes', 'b', null, false, true],
      ['can_record_waste', 'b', null, false, true],
      ['hourly_rate', 'i', null, false], // feature 4: labour cost
    ],
    indexes: [['user_unique', 'unique', ['user_id']], ['email', 'key', ['email']], ['active_role', 'key', ['active', 'role']]],
  },
  {
    id: 'devices',
    name: 'Devices',
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: ALL_STAFF, delete: MGMT },
    attributes: [
      ['name', 's', 80, true],
      ['kind', 'e', ['kds', 'pos', 'admin'], true],
      ['station', 'e', ['hot', 'cold', 'bar', 'dessert', 'all'], true, 'all'],
      ['last_seen', 'd', null, true],
      ['audio_ok', 'b', null, true, false],
      ['app_version', 's', 40, false],
    ],
    indexes: [['kind_seen', 'key', ['kind', 'last_seen']]],
  },
  {
    id: 'audit_log',
    name: 'Audit log',
    // Anyone can add to it, nobody can change or remove anything, and only
    // management can read it. An audit trail the audited can edit is theatre.
    perms: { read: MGMT, create: ALL_STAFF, update: [], delete: [] },
    attributes: [
      ['actor_id', 's', 64, true],
      ['actor_role', 's', 20, false],
      ['action', 's', 80, true],
      ['entity_type', 's', 60, false],
      ['entity_id', 's', 64, false],
      ['before', 's', 4000, false],
      ['after', 's', 4000, false],
      // Why a human did it. A before/after pair says what changed; only this
      // says whether it was a correction, a comp or a mistake being covered.
      ['reason', 's', 500, false],
      ['ip', 's', 60, false],
      ['device', 's', 120, false],
      ['shift_id', 's', 64, false],
    ],
    indexes: [['actor_created', 'key', ['actor_id', '$createdAt']], ['action', 'key', ['action']]],
  },

  // ======================================================================
  //  OPTIONAL FEATURES (1–12)
  //  Every one of these is switched on or off by an admin — see FEATURES
  //  below. Collections exist whether or not the feature is enabled; a
  //  disabled feature simply hides its UI and skips its hooks, so turning
  //  something on later never needs a migration or loses history.
  // ======================================================================

  {
    // The master switchboard. A blank venue_id row is the group-wide default;
    // a row naming a venue overrides it for that venue only.
    id: 'feature_flags',
    name: 'Feature flags',
    perms: { read: ['any'], create: ADMIN, update: ADMIN, delete: ADMIN },
    attributes: [
      ['key', 's', 60, true],
      ['venue_id', 's', 64, false],
      ['enabled', 'b', null, true, false],
      ['config', 's', 8000, false], // JSON, shape depends on the feature
      ['updated_by', 's', 64, false],
    ],
    indexes: [['key_venue', 'unique', ['key', 'venue_id']], ['key', 'key', ['key']]],
  },

  // ---- 1. Receipts and kitchen slips ------------------------------------
  {
    // One row per delivery attempt, so "did the customer get their receipt?"
    // is answerable months later.
    id: 'receipts',
    name: 'Receipts',
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: ALL_STAFF, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, true],
      ['order_id', 's', 64, true],
      ['channel', 'e', ['email', 'print', 'none'], true],
      ['to_email', 's', 160, false],
      ['status', 'e', ['queued', 'sent', 'failed', 'skipped', 'bounced'], true, 'queued'],
      ['skip_reason', 'e', ['no_email', 'customer_declined', 'feature_off'], false],
      ['attempts', 'i', null, true, 0],
      ['last_error', 's', 500, false],
      ['sent_at', 'd', null, false],
      ['provider_ref', 's', 200, false],
      ['pdf_file_id', 's', 64, false],
      ['requested_by', 's', 64, false],
      // Set when somebody asks for a receipt to be sent again. Staff can update
      // a receipt row but not delete one — an audit trail the audited can
      // remove is not one — so a resend is a request rather than a deletion.
      // Cleared once it has gone.
      ['resend_requested_at', 'd', null, false],
      ['resend_requested_by', 's', 64, false],
      ['email_source', 'e', ['guest_at_order', 'staff_entered', 'customer_profile'], false],
    ],
    indexes: [
      ['order', 'key', ['order_id']],
      ['status_created', 'key', ['status', '$createdAt']],
      ['email', 'key', ['to_email']],
    ],
  },

  // ---- 2. Takeaway and delivery -----------------------------------------
  {
    // Admin-defined collection points. A venue can have many: front counter,
    // side hatch, a kiosk in a mall, a partner shop across town.
    id: 'pickup_points',
    name: 'Pickup points',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, true],
      ['name', 's', 120, true],
      ['kind', 'e', ['counter', 'window', 'kiosk', 'locker', 'partner_site', 'kerbside'], true, 'counter'],
      ['address', 's', 300, false],
      ['directions', 's', 500, false], // shown to the customer on their phone
      ['phone', 's', 40, false],
      ['lead_minutes', 'i', null, true, 0], // extra prep time for a distant point
      ['opening_hours', 's', 2000, false], // JSON, same shape as menu availability
      ['station', 's', 40, false], // which kitchen station serves it
      ['accepts_delivery', 'b', null, true, false],
      ['active', 'b', null, true, true],
      ['sort', 'i', null, true, 0],
    ],
    indexes: [['venue_active_sort', 'key', ['venue_id', 'active', 'sort']]],
  },
  {
    id: 'delivery_zones',
    name: 'Delivery zones',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, true],
      ['pickup_point_id', 's', 64, false], // which point dispatches this zone
      ['name', 's', 120, true],
      ['fee', 'i', null, true, 0],
      ['min_order_total', 'i', null, true, 0],
      ['eta_minutes', 'i', null, true, 30],
      ['active', 'b', null, true, true],
      ['sort', 'i', null, true, 0],
    ],
    indexes: [['venue_active', 'key', ['venue_id', 'active', 'sort']]],
  },

  {
    // Bookable time slots for pre-orders. A row per slot per venue, created on
    // demand. `booked_count` is what stops fifty people all pre-ordering for
    // 12:00 — capacity is checked and incremented server-side in one step, so
    // two simultaneous orders can't both take the last place.
    id: 'preorder_slots',
    name: 'Pre-order slots',
    perms: { read: ['any'], create: ['users'], update: ['users'], delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, true],
      ['pickup_point_id', 's', 64, false],
      ['slot_start', 'd', null, true],
      ['slot_end', 'd', null, true],
      ['capacity', 'i', null, true, 0], // 0 = unlimited
      ['booked_count', 'i', null, true, 0],
      ['status', 'e', ['open', 'full', 'closed'], true, 'open'],
      ['closed_reason', 's', 200, false],
    ],
    indexes: [
      ['venue_slot', 'unique', ['venue_id', 'pickup_point_id', 'slot_start']],
      ['venue_start', 'key', ['venue_id', 'slot_start']],
    ],
  },

  // ---- 3. Waste log ------------------------------------------------------
  {
    // Deliberately separate from stock_movements so "we threw it away" can
    // never be confused with "we sold it" or "it went missing".
    id: 'waste_log',
    name: 'Waste log',
    perms: { read: MGMT, create: ALL_STAFF, update: MGMT, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, true],
      ['shift_id', 's', 64, false],
      ['ingredient_id', 's', 64, false],
      ['menu_item_id', 's', 64, false], // a finished plate, not a raw ingredient
      ['qty', 'f', null, true],
      ['unit', 's', 20, true],
      ['reason', 'e', ['spoiled', 'expired', 'dropped', 'burnt', 'prep_error', 'customer_return', 'staff_meal', 'trim', 'other'], true],
      ['note', 's', 500, false],
      ['value', 'i', null, true, 0], // cost, so waste shows up in money terms
      ['photo_file_id', 's', 64, false],
      ['recorded_by', 's', 64, true],
      ['approved_by', 's', 64, false],
    ],
    indexes: [
      ['venue_created', 'key', ['venue_id', '$createdAt']],
      ['shift', 'key', ['shift_id']],
      ['ingredient', 'key', ['ingredient_id']],
      ['reason', 'key', ['reason']],
    ],
  },

  // ---- 4. Staff clock in / out ------------------------------------------
  {
    id: 'time_entries',
    name: 'Time entries',
    perms: { read: MGMT, create: ALL_STAFF, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, true],
      ['user_id', 's', 64, true],
      ['shift_id', 's', 64, false],
      ['clock_in', 'd', null, true],
      ['clock_out', 'd', null, false],
      ['break_minutes', 'i', null, true, 0],
      ['minutes_worked', 'i', null, false], // computed on clock-out
      ['hourly_rate_snapshot', 'i', null, false],
      ['labour_cost', 'i', null, false],
      ['source', 'e', ['pin', 'manager', 'auto_close'], true, 'pin'],
      ['edited_by', 's', 64, false],
      ['edit_reason', 's', 300, false],
      ['note', 's', 300, false],
    ],
    indexes: [
      ['user_in', 'key', ['user_id', 'clock_in']],
      ['venue_in', 'key', ['venue_id', 'clock_in']],
      ['open', 'key', ['user_id', 'clock_out']],
    ],
  },

  // ---- 5 & 6. Customers and loyalty --------------------------------------
  {
    // Group-wide by design: a customer known at one venue is known at all of
    // them. `venue_ids` records where they've actually eaten.
    id: 'customers',
    name: 'Customers',
    perms: { read: ALL_STAFF, create: ['any'], update: ALL_STAFF, delete: ADMIN },
    attributes: [
      ['phone', 's', 40, false],
      ['email', 's', 160, false],
      ['name', 's', 160, false],
      ['locale', 's', 10, false],
      ['marketing_opt_in', 'b', null, true, false],
      ['receipt_opt_in', 'b', null, true, true],
      ['venue_ids', 's[]', 64, false],
      ['first_seen', 'd', null, false],
      ['last_seen', 'd', null, false],
      ['order_count', 'i', null, true, 0],
      ['total_spent', 'i', null, true, 0],
      ['avg_order_value', 'i', null, true, 0],
      ['tags', 's[]', 40, false], // 'regular', 'vip', 'allergy:nuts'
      ['notes', 's', 1000, false],
      ['blocked', 'b', null, true, false],
    ],
    indexes: [
      ['phone_unique', 'unique', ['phone']],
      ['email', 'key', ['email']],
      ['last_seen', 'key', ['last_seen']],
    ],
  },
  {
    id: 'loyalty_programs',
    name: 'Loyalty programs',
    perms: { read: ['any'], create: ADMIN, update: ADMIN, delete: ADMIN },
    attributes: [
      ['name', 's', 120, true],
      ['venue_ids', 's[]', 64, false], // empty = all venues
      ['kind', 'e', ['points', 'stamps', 'spend_tiers'], true, 'points'],
      ['earn_per_currency_unit', 'f', null, false], // points mode
      ['stamp_target', 'i', null, false], // stamps mode: buy N get 1
      ['stamp_qualifying_item_ids', 's[]', 64, false],
      ['redeem_value_per_point', 'i', null, false],
      ['min_redeem_points', 'i', null, true, 0],
      ['reward_description', 's', 300, false],
      ['expiry_days', 'i', null, false],
      ['active', 'b', null, true, true],
    ],
    indexes: [['active', 'key', ['active']]],
  },
  {
    id: 'loyalty_ledger',
    name: 'Loyalty ledger',
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: [], delete: [] },
    attributes: [
      ['venue_id', 's', 64, true],
      ['customer_id', 's', 64, true],
      ['program_id', 's', 64, true],
      ['order_id', 's', 64, false],
      ['type', 'e', ['earn', 'redeem', 'adjust', 'expire', 'reverse'], true],
      ['delta', 'i', null, true],
      ['balance_after', 'i', null, true],
      ['expires_at', 'd', null, false],
      ['note', 's', 300, false],
      ['created_by', 's', 64, false],
    ],
    indexes: [
      ['customer_created', 'key', ['customer_id', '$createdAt']],
      ['order', 'key', ['order_id']],
    ],
  },

  // ---- 7. Feedback -------------------------------------------------------
  {
    id: 'feedback',
    name: 'Feedback',
    perms: { read: MGMT, create: ['any'], update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, true],
      ['order_id', 's', 64, false],
      ['customer_id', 's', 64, false],
      ['rating', 'i', null, true], // 1–5
      ['food_rating', 'i', null, false],
      ['service_rating', 'i', null, false],
      ['speed_rating', 'i', null, false],
      ['tags', 's[]', 40, false],
      ['comment', 's', 2000, false],
      ['item_ids', 's[]', 64, false], // what they actually ate
      ['served_by', 's', 64, false],
      ['shift_id', 's', 64, false],
      ['status', 'e', ['new', 'seen', 'responded', 'resolved', 'ignored'], true, 'new'],
      ['response', 's', 2000, false],
      ['responded_by', 's', 64, false],
      ['responded_at', 'd', null, false],
    ],
    indexes: [
      ['venue_created', 'key', ['venue_id', '$createdAt']],
      ['rating', 'key', ['rating']],
      ['status', 'key', ['status']],
      ['served_by', 'key', ['served_by']],
    ],
  },

  // ---- 8. Multi-language menu -------------------------------------------
  {
    // Generic so any user-facing text can be translated without new columns:
    // one row per (thing, language, field).
    id: 'translations',
    name: 'Translations',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['entity_type', 'e', ['menu_item', 'category', 'addon_group', 'addon_option', 'venue', 'pickup_point', 'discount'], true],
      ['entity_id', 's', 64, true],
      ['locale', 's', 10, true],
      ['field', 's', 40, true], // 'name' | 'description' | ...
      ['value', 's', 2000, true],
      ['machine_translated', 'b', null, true, false],
      ['updated_by', 's', 64, false],
    ],
    indexes: [
      ['entity_locale_field', 'unique', ['entity_type', 'entity_id', 'locale', 'field']],
      ['locale', 'key', ['locale']],
    ],
  },

  // ---- 9. Purchase orders and receiving ---------------------------------
  {
    id: 'purchase_orders',
    name: 'Purchase orders',
    perms: { read: MGMT, create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, true],
      ['supplier_id', 's', 64, true],
      ['po_number', 's', 40, true],
      ['status', 'e', ['draft', 'sent', 'part_received', 'received', 'cancelled'], true, 'draft'],
      ['expected_at', 'd', null, false],
      ['sent_at', 'd', null, false],
      ['subtotal', 'i', null, true, 0],
      ['tax', 'i', null, true, 0],
      ['total', 'i', null, true, 0],
      ['ordered_by', 's', 64, true],
      ['approved_by', 's', 64, false],
      ['note', 's', 1000, false],
      ['auto_generated', 'b', null, true, false], // raised from par levels
    ],
    indexes: [
      ['venue_status', 'key', ['venue_id', 'status']],
      ['po_number_unique', 'unique', ['venue_id', 'po_number']],
      ['supplier', 'key', ['supplier_id']],
    ],
  },
  {
    id: 'purchase_order_items',
    name: 'Purchase order items',
    perms: { read: MGMT, create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, true],
      ['purchase_order_id', 's', 64, true],
      ['ingredient_id', 's', 64, true],
      ['qty_ordered', 'f', null, true],
      ['qty_received', 'f', null, true, 0],
      ['unit', 's', 20, true],
      ['unit_cost_expected', 'i', null, true, 0],
      ['unit_cost_actual', 'i', null, false],
      ['line_total', 'i', null, true, 0],
      ['discrepancy', 'e', ['none', 'short', 'over', 'price_up', 'price_down', 'quality', 'not_delivered'], true, 'none'],
      ['discrepancy_note', 's', 500, false],
    ],
    indexes: [['po', 'key', ['purchase_order_id']], ['ingredient', 'key', ['ingredient_id']]],
  },

  // ---- 10. Scheduled summaries ------------------------------------------
  {
    // Who gets the end-of-shift summary, and how.
    id: 'report_subscriptions',
    name: 'Report subscriptions',
    perms: { read: MGMT, create: ADMIN, update: ADMIN, delete: ADMIN },
    attributes: [
      ['venue_ids', 's[]', 64, false], // empty = every venue
      ['user_id', 's', 64, false],
      ['channel', 'e', ['email', 'whatsapp', 'sms', 'push'], true, 'email'],
      ['destination', 's', 200, true],
      // 'shift_close' | 'daily_digest' | 'backup' | 'stock_alert'
      ['events', 's[]', 40, true],
      ['active', 'b', null, true, true],
    ],
    indexes: [['active', 'key', ['active']]],
  },
  {
    // The generated summary itself, kept so it can be re-read and re-sent.
    id: 'summary_reports',
    name: 'Summary reports',
    perms: { read: MGMT, create: [], update: [], delete: [] },
    attributes: [
      ['venue_id', 's', 64, true],
      ['kind', 'e', ['shift_close', 'daily_digest', 'backup'], true],
      ['shift_id', 's', 64, false],
      ['period_start', 'd', null, true],
      ['period_end', 'd', null, true],
      // 20000 rather than 16000 deliberately: at or below 16383 Appwrite stores a
      // string inline as VARCHAR, which at 4 bytes/char would consume 64KB of the
      // 65535-byte row limit on its own. Above it, the column becomes TEXT and is
      // stored out of row for ~12 bytes. Bigger is genuinely cheaper here.
      ['payload', 's', 20000, true], // JSON: the full figures
      // Stock is reported in two separate sections, never merged:
      //  - new_stock_ids: flagged low/out for the FIRST time this shift
      //  - persistent_stock_ids: flagged for `persistent_stock_threshold`
      //    shifts running (default 3) — the ones that need a decision
      ['new_stock_ids', 's[]', 64, false],
      ['persistent_stock_ids', 's[]', 64, false],
      ['delivery_status', 'e', ['queued', 'sent', 'partial', 'failed'], true, 'queued'],
      ['delivered_to', 's', 2000, false],
      ['last_error', 's', 500, false],
      ['sent_at', 'd', null, false],
    ],
    indexes: [
      ['venue_kind_created', 'key', ['venue_id', 'kind', '$createdAt']],
      ['shift', 'key', ['shift_id']],
    ],
  },

  // ---- 11. Kitchen busy mode --------------------------------------------
  {
    id: 'kitchen_status',
    name: 'Kitchen status',
    perms: { read: ['any'], create: ALL_STAFF, update: ALL_STAFF, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, true],
      ['station', 's', 40, true, 'all'],
      ['mode', 'e', ['normal', 'busy', 'paused'], true, 'normal'],
      ['pending_count', 'i', null, true, 0],
      ['quoted_wait_minutes', 'i', null, true, 0],
      ['auto', 'b', null, true, true], // tripped by thresholds vs set by hand
      ['set_by', 's', 64, false],
      ['reason', 's', 300, false],
      ['until', 'd', null, false],
    ],
    indexes: [['venue_station', 'unique', ['venue_id', 'station']]],
  },

  // ---- 12. Time-based prices --------------------------------------------
  {
    // Changes the price the customer SEES (happy hour, breakfast pricing).
    // Distinct from a discount, which reduces an already-priced bill.
    id: 'price_rules',
    name: 'Price rules',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['name', 's', 120, true],
      ['venue_ids', 's[]', 64, false],
      ['scope', 'e', ['all', 'category', 'item', 'tag'], true, 'item'],
      ['target_ids', 's[]', 64, false],
      ['adjust_kind', 'e', ['percent_off', 'amount_off', 'fixed_price'], true, 'percent_off'],
      ['adjust_value', 'i', null, true], // basis points, minor units, or price
      ['days_of_week', 's[]', 3, false], // 'mon'…'sun'; empty = every day
      ['time_start', 's', 5, false], // '16:00'
      ['time_end', 's', 5, false],
      ['starts_at', 'd', null, false],
      ['ends_at', 'd', null, false],
      ['channels', 's[]', 20, false], // 'qr', 'pos', 'takeaway', 'delivery'
      ['priority', 'i', null, true, 0], // highest wins; ties broken by cheapest
      ['show_original_price', 'b', null, true, true],
      ['badge_text', 's', 40, false],
      ['active', 'b', null, true, true],
    ],
    indexes: [['active_priority', 'key', ['active', 'priority']]],
  },

  // ---- Discounts and discount codes -------------------------------------
  {
    // A discount with no `code` is a button staff can press (e.g. "Staff 20%").
    // A discount with a code can also be typed by a guest while ordering.
    id: 'discounts',
    name: 'Discounts',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['name', 's', 120, true],
      ['code', 's', 40, false], // blank = staff-applied only, no code
      ['description', 's', 500, false],
      ['venue_ids', 's[]', 64, false], // empty = all venues
      ['kind', 'e', ['percent', 'amount', 'free_item', 'item_percent', 'free_delivery'], true, 'percent'],
      ['value', 'i', null, true], // basis points for percent, minor units for amount
      ['free_item_id', 's', 64, false],
      ['scope', 'e', ['order', 'category', 'item', 'tag'], true, 'order'],
      ['target_ids', 's[]', 64, false],
      ['min_order_total', 'i', null, true, 0],
      ['max_discount_amount', 'i', null, false], // caps a percent discount
      // Who may apply it, and when.
      ['guest_applicable', 'b', null, true, false], // typed at QR ordering
      ['staff_applicable', 'b', null, true, true], // applied after accepting
      ['requires_manager', 'b', null, true, false],
      ['auto_apply', 'b', null, true, false], // applies itself when it qualifies
      ['stackable', 'b', null, true, false],
      // When it is live.
      ['starts_at', 'd', null, false],
      ['ends_at', 'd', null, false],
      ['days_of_week', 's[]', 3, false],
      ['time_start', 's', 5, false],
      ['time_end', 's', 5, false],
      ['channels', 's[]', 20, false],
      // Limits.
      ['usage_limit_total', 'i', null, false],
      ['usage_limit_per_customer', 'i', null, false],
      ['first_order_only', 'b', null, true, false],
      ['used_count', 'i', null, true, 0],
      ['active', 'b', null, true, true],
      ['created_by', 's', 64, false],
    ],
    indexes: [
      ['code_unique', 'unique', ['code']],
      ['active_code', 'key', ['active', 'code']],
      ['active', 'key', ['active']],
    ],
  },
  {
    // Every application, including ones later reversed — this is the audit
    // trail for the single easiest way to steal from a restaurant.
    id: 'discount_redemptions',
    name: 'Discount redemptions',
    // Guests apply codes themselves, so they must be able to write the record.
    // Reading stays management-only: a customer has no business seeing the
    // history of everyone else's discounts.
    perms: { read: MGMT, create: ['users'], update: MGMT, delete: [] },
    attributes: [
      ['venue_id', 's', 64, true],
      ['discount_id', 's', 64, true],
      ['code_snapshot', 's', 40, false],
      ['order_id', 's', 64, true],
      ['customer_id', 's', 64, false],
      ['amount', 'i', null, true],
      ['stage', 'e', ['guest_ordering', 'staff_post_accept', 'auto'], true],
      ['applied_by', 's', 64, false], // blank when the guest typed the code
      ['approved_by', 's', 64, false], // manager PIN, when required
      ['status', 'e', ['applied', 'reversed'], true, 'applied'],
      ['reversed_by', 's', 64, false],
      ['reverse_reason', 's', 300, false],
    ],
    indexes: [
      ['order', 'key', ['order_id']],
      ['discount_created', 'key', ['discount_id', '$createdAt']],
      ['customer', 'key', ['customer_id']],
      ['applied_by', 'key', ['applied_by']],
    ],
  },
];

/**
 * Guard the MariaDB row-size limit.
 *
 * Strings sized 16383 or under become VARCHAR and count against the 65535-byte
 * row limit at 4 bytes per character; larger ones become TEXT and cost ~12
 * bytes in-row. A collection that creeps over the limit fails part-way through
 * provisioning with "maximum number or size of attributes reached", which does
 * not name the offending field — so catch it here instead.
 */
const VARCHAR_MAX = 16383;
const ROW_LIMIT = 65535;
for (const c of COLLECTIONS) {
  let bytes = 0;
  for (const [, type, arg] of c.attributes) {
    const base = type.replace('[]', '');
    if (type.endsWith('[]')) bytes += 12;
    else if (base === 's') bytes += arg <= VARCHAR_MAX ? arg * 4 : 12;
    else if (base === 'e') bytes += Math.max(...arg.map((v) => v.length)) * 4;
    else bytes += 8;
  }
  if (bytes > ROW_LIMIT) {
    throw new Error(
      `${c.id}: estimated row size ${bytes} exceeds ${ROW_LIMIT} bytes. ` +
        `Shrink a large string, or push it above ${VARCHAR_MAX} chars so it is stored as TEXT.`,
    );
  }
}

// Appwrite rejects an empty string as an enum option (elements must be 1+ chars).
// These attributes are all optional, so "unset" already means blank — an empty
// option was both invalid and redundant. Fail loudly if one is reintroduced.
for (const c of COLLECTIONS) {
  for (const [key, type, arg] of c.attributes) {
    if (type.replace('[]', '') !== 'e') continue;
    if (!Array.isArray(arg) || arg.some((v) => typeof v !== 'string' || v.length === 0)) {
      throw new Error(`${c.id}.${key}: enum values must all be non-empty strings`);
    }
  }
}

/**
 * Multi-venue scoping.
 *
 * The menu, recipes and add-ons are SHARED across venues (edit once, use
 * everywhere) with per-venue price/availability overrides in `venue_menu_items`.
 * Everything operational is SEPARATE per venue — staff, shifts, cash, stock,
 * purchases and the ledger never mix between locations.
 *
 * `venue_id` is injected here rather than repeated 20 times above, so a venue
 * can never be accidentally omitted from a collection that needs it.
 */
export const VENUE_SCOPED = [
  'tables', 'dining_sessions', 'orders', 'order_items', 'payments',
  'shifts', 'shift_expenses', 'shift_stock_checks',
  'ingredients', 'suppliers', 'purchases', 'purchase_items',
  'stock_movements', 'stock_flags',
  'journal_entries', 'journal_lines',
  'devices', 'audit_log', 'payment_methods',
];

for (const id of VENUE_SCOPED) {
  const col = COLLECTIONS.find((c) => c.id === id);
  if (!col) throw new Error(`VENUE_SCOPED references unknown collection "${id}"`);
  col.attributes.unshift(['venue_id', 's', 64, true]);
  col.indexes = col.indexes || [];
  col.indexes.push([`venue`, 'key', ['venue_id']]);
}

// Staff belong to one or more venues; an empty list means "all venues" (owner).
COLLECTIONS.find((c) => c.id === 'staff_profiles').attributes.push(['venue_ids', 's[]', 64, false]);

/**
 * The twelve optional features, and their default configuration.
 *
 * Each one is a row in `feature_flags` that an admin flips from
 * Admin → Settings → Features. Nothing here is hard-coded into the apps: a
 * screen checks `isEnabled('takeaway')` and hides itself if not. Turning a
 * feature off never deletes its data, so it can be turned back on unchanged.
 *
 * `config` holds the per-feature options. Seeded at the group level (blank
 * venue_id); an admin can override any of it per venue.
 */
export const FEATURES = [
  {
    key: 'receipts',
    label: 'Receipts and kitchen slips',
    enabled: true,
    config: {
      // Receipts go out by EMAIL by default rather than being printed.
      receipt_delivery: 'email', // 'email' | 'print' | 'both' | 'off'
      ask_email_at_qr_order: true, // guest can type it while ordering
      allow_staff_enter_email: true, // cashier can add it at payment
      allow_skip_email: true, // "no receipt, thanks" is always allowed
      email_subject: 'Your receipt from {{venue}}',
      // Told twice, at the two moments a customer actually wants to hear:
      // somebody has taken the order, and the food is ready. Each can be
      // switched off on its own — a sit-down restaurant where the waiter is
      // standing there anyway has no use for "your food is ready".
      notify_on_accepted: true,
      notify_on_ready: true,
      attach_pdf: true,
      // Kitchen slips print separately and can be switched off on their own.
      print_kitchen_slips: false,
      kitchen_slip_printer: '',
      kitchen_slip_copies: 1,
      // Only relevant when receipt_delivery includes 'print'.
      receipt_printer: '',
      receipt_footer: '',
    },
  },
  {
    key: 'takeaway',
    label: 'Takeaway and delivery',
    enabled: true,
    config: {
      takeaway_enabled: true,
      delivery_enabled: false,
      // Pickup points are rows in `pickup_points` — as many per venue as you
      // like. This is just the default behaviour around them.
      require_pickup_point_choice: true,
      default_pickup_point_id: '',
      show_pickup_directions_to_guest: true,
      require_customer_phone: true,
      default_prep_minutes: 20,
      allow_scheduled_pickup: true,
      max_days_ahead: 2,
    },
  },
  {
    key: 'preorders',
    label: 'Order ahead / order while closed',
    enabled: true,
    config: {
      // Customers can browse and order outside trading hours, choosing a time
      // when the restaurant will be open. Nothing reaches the kitchen until
      // that time comes round.
      allow_when_closed: true,
      allow_when_open: true, // "I'll collect at 7pm" during service
      fulfilments: ['takeaway', 'delivery', 'dine_in'],
      max_days_ahead: 7,
      min_lead_minutes: 30, // no ordering for 5 minutes from now
      slot_minutes: 15, // granularity of the time picker
      slot_capacity: 0, // orders per slot; 0 = unlimited
      cutoff_minutes_before_close: 30, // last slot of a trading day
      // The kitchen is told with enough time to cook, not at ordering time.
      fire_lead_uses_prep_time: true,
      fire_lead_extra_minutes: 5,
      // Whether staff must confirm a pre-order before its fire time.
      require_staff_confirmation: false,
      auto_cancel_unconfirmed_hours: 0,
      closed_message: "We're closed right now — order ahead and pick a time.",
    },
  },
  {
    key: 'combined_mode',
    label: 'One screen for kitchen and front of house',
    enabled: false,
    config: {
      // For shifts with no waiter or cashier on: the cook takes the order,
      // cooks it and settles the bill from one screen rather than walking
      // between two devices.
      show_kitchen_in_terminal: true,
      show_ordering_in_kitchen: true,
      // A cook covering the till still needs to be able to take money.
      allow_cook_to_mark_paid: true,
    },
  },
  {
    key: 'overdue_alerts',
    label: 'Ping when an order runs late',
    enabled: true,
    config: {
      // Separate from the acknowledgement alarm: that one asks "has anyone
      // SEEN this?", this one asks "should this have been out by now?".
      grace_minutes: 5,
      repeat_minutes: 3,
      escalate_to_manager_after_minutes: 15,
    },
  },
  {
    key: 'waste_log',
    label: 'Waste log',
    enabled: true,
    config: { require_photo_above_value: 0, require_manager_above_value: 0, prompt_at_shift_close: true },
  },
  {
    key: 'time_clock',
    label: 'Staff clock in / out',
    enabled: true,
    config: { clock_in_with_pin: true, auto_clock_out_hours: 14, track_labour_cost: true, require_manager_edit_reason: true },
  },
  {
    key: 'customers',
    label: 'Customer profiles',
    enabled: true,
    config: { collect_phone: true, collect_email: true, collect_name: true, optional_always: true, merge_on_matching_phone: true },
  },
  {
    key: 'loyalty',
    label: 'Loyalty / stamp card',
    enabled: true,
    config: { requires: ['customers'], kind: 'stamps', stamp_target: 9, show_progress_on_receipt: true },
  },
  {
    key: 'feedback',
    label: 'Feedback after paying',
    enabled: true,
    config: { prompt_after_payment: true, prompt_on_receipt_email: true, ask_food_and_service: true, alert_managers_below_rating: 3 },
  },
  {
    key: 'multilingual',
    label: 'Multi-language menu',
    enabled: true,
    config: { locales: ['en'], show_language_picker: true, fall_back_to_default: true },
  },
  {
    key: 'purchase_orders',
    label: 'Purchase orders and receiving',
    enabled: true,
    config: { require_approval_above: 0, auto_suggest_from_par_levels: true, flag_price_rise_bp: 1000, block_receive_without_check: true },
  },
  {
    key: 'shift_summary',
    label: 'Summary sent at shift close',
    enabled: true,
    config: {
      // Sent the moment a shift is closed, not on a nightly timer.
      send_on_shift_close: true,
      also_send_daily_digest: false,
      include_sales: true,
      include_cash_variance: true,
      include_voids_and_discounts: true,
      include_waste: true,
      // Stock is reported as TWO separate sections, deliberately not merged.
      // "New today" is what to act on now; "ongoing" is what to make a
      // decision about. Averaging them into one list loses both signals.
      include_new_stock_alerts: true, // flagged low/out for the first time
      include_persistent_stock: true, // flagged N shifts running
      persistent_stock_threshold: 3,
      channels: ['email'],
    },
  },
  {
    key: 'busy_mode',
    label: 'Kitchen busy mode',
    enabled: true,
    config: {
      auto_trip: true,
      busy_pending_threshold: 12, // tickets waiting
      pause_pending_threshold: 20,
      busy_extra_minutes: 15,
      hold_qr_orders_when_paused: true,
      message_to_guest: 'The kitchen is very busy — your order may take a little longer.',
    },
  },
  {
    key: 'time_pricing',
    label: 'Happy hour / time-based prices',
    enabled: true,
    config: { show_original_price: true, apply_to_qr: true, apply_to_pos: true, badge_text: 'Happy hour' },
  },
  {
    key: 'discounts',
    label: 'Discounts and discount codes',
    enabled: true,
    config: {
      guest_codes_enabled: true, // guests type a code while ordering
      staff_discounts_enabled: true, // staff apply after accepting the order
      staff_apply_window: 'before_payment', // no discounting a settled bill
      manager_pin_above_bp: 2000, // >20% needs a manager
      max_stacked: 1,
      show_savings_on_receipt: true,
      invalid_code_message: "That code isn't valid for this order.",
    },
  },
  {
    key: 'item_availability',
    label: 'Staff can mark items unavailable',
    enabled: true,
    config: {
      // Anyone working can mark a dish off. The person who discovers the
      // chicken has run out is whoever opened the fridge, and making them find
      // a manager first is how a sold-out dish keeps being ordered.
      who_can_mark: 'all', // 'all' | 'management'
      require_reason: false,
      // How long a dish may stay off before the admin is emailed about it. A
      // dish nobody has restored in a day is either a supply problem or a
      // forgotten tap, and both want looking at.
      alert_after_hours: 24,
      alert_emails: '', // blank = the shift summary recipients
      // Marked-off items are listed in the shift summary by name.
      include_in_shift_summary: true,
    },
  },
  {
    key: 'group_orders',
    label: 'Group orders',
    enabled: false,
    config: {
      // A separate menu for parties — platters and set meals rather than the
      // a la carte list. Categories and dishes are flagged group_only.
      require_reservation_number: true,
      reservation_label: 'Hotel reservation number',
      min_group_size: 6,
      // Somebody is told the moment a group order arrives, because a party of
      // twenty is a kitchen planning decision, not just another ticket.
      notify_emails: '',
      notify_on_placed: true,
      notify_group_on_accepted: true,
    },
  },
  {
    key: 'help',
    label: 'In-app help and user manual',
    enabled: true,
    config: {
      // Who sees which chapter, keyed by article id. Only differences from the
      // audience each chapter was written for are stored, so a chapter added in
      // a later version arrives visible to the right people instead of being
      // invisible to everyone until somebody notices it exists.
      // Shape: { "<article_id>": ["cook", "waiter", ...] }
      audiences: {},
      // Guests see the "ordering from your phone" chapter on the QR menu.
      show_on_customer_menu: true,
    },
  },
];

export const SEED_ACCOUNTS = [
  ['1000', 'Cash on hand', 'asset'],
  ['1010', 'Card clearing', 'asset'],
  ['1020', 'Mobile money clearing', 'asset'],
  ['1200', 'Inventory', 'asset'],
  ['2100', 'Tax payable', 'liability'],
  ['2200', 'Tips payable', 'liability'],
  ['2300', 'Accounts payable', 'liability'],
  ['3000', 'Owner equity', 'equity'],
  ['4000', 'Food sales', 'revenue'],
  ['4010', 'Beverage sales', 'revenue'],
  ['4900', 'Discounts given', 'revenue'],
  ['5000', 'Cost of goods sold', 'expense'],
  ['6000', 'Supplies', 'expense'],
  ['6010', 'Transport', 'expense'],
  ['6020', 'Utilities', 'expense'],
  ['6030', 'Repairs & maintenance', 'expense'],
  ['6040', 'Staff advances', 'expense'],
  ['6050', 'Petty cash', 'expense'],
  ['6090', 'Other expenses', 'expense'],
  ['7000', 'Cash over / short', 'expense'],
];

/**
 * A starting set of expense categories, each pointed at a real account.
 *
 * Seeded so that recording an expense works on day one, and editable so that a
 * restaurant with "Gas refill" and "Okada runs" is not forced to file both
 * under Other. `key` is what gets written onto every expense, so it is fixed
 * once created; the name can change freely.
 */
export const SEED_EXPENSE_CATEGORIES = [
  { key: 'supplies', name: 'Supplies', account_code: '6000', sort: 1 },
  { key: 'transport', name: 'Transport', account_code: '6010', sort: 2 },
  { key: 'utilities', name: 'Utilities', account_code: '6020', sort: 3 },
  { key: 'repairs', name: 'Repairs & maintenance', account_code: '6030', sort: 4 },
  { key: 'staff_advance', name: 'Staff advances', account_code: '6040', sort: 5 },
  { key: 'petty_cash', name: 'Petty cash', account_code: '6050', sort: 6 },
  { key: 'other', name: 'Other', account_code: '6090', sort: 7 },
];

/** Ingredient groupings to start from. Rename or delete any of them. */
export const SEED_INGREDIENT_CATEGORIES = [
  { key: 'produce', name: 'Produce', sort: 1 },
  { key: 'protein', name: 'Meat & fish', sort: 2 },
  { key: 'dry_goods', name: 'Dry goods', sort: 3 },
  { key: 'dairy', name: 'Dairy & eggs', sort: 4 },
  { key: 'drinks', name: 'Drinks', sort: 5 },
  { key: 'packaging', name: 'Packaging', sort: 6 },
  { key: 'cleaning', name: 'Cleaning', sort: 7 },
];

export const SEED_PAYMENT_METHODS = [
  { name: 'Cash', kind: 'cash', sort: 1, opens_cash_drawer: true, counted_at_close: true },
  { name: 'Card', kind: 'card', sort: 2, requires_reference: true, counted_at_close: true },
];
