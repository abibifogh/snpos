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
 * perms.read / .create / .update / .delete, arrays of Appwrite role strings.
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
      // A QR for people not sitting at a table, the counter queue, a poster
      // in the window, a flyer. Opens the menu in takeaway mode.
      ['walkin_token', 's', 64, false],
      // A separate address for group and party ordering. Kept off the ordinary
      // menu entirely: a walk-in should not be offered a set meal for twenty,
      // and a hotel's platter prices are not for the whole dining room to read.
      ['group_token', 's', 64, false],
      /**
       * A screen that stays where it is and serves one customer after another.
       *
       * A tablet on a counter or a wall, not somebody's phone. Everything
       * about the ordinary menu assumes the person holding it is the person
       * who ordered: it goes to a live status page and stays there, which is
       * right on a phone and wrong on a shared screen, where it leaves the
       * next customer looking at a stranger's food and a member of staff
       * having to reset it between every order.
       *
       * So this mode thanks them, says how long it will be, and puts the menu
       * back by itself.
       */
      ['screen_token', 's', 64, false],
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

  // ------------------------------------------------------------ the hotels
  {
    /**
     * One row per hotel using the system.
     *
     * Everything else in this database belongs to one of these. The row is
     * created by the owner of the platform when a request is approved, not by
     * whoever is signing up, which is why nobody but a platform owner may
     * write here.
     *
     * `team_id` is the Appwrite team that owns this hotel's data. Every
     * document written for this organisation is created readable by that team
     * and nobody else, so isolation is enforced by the database rather than by
     * every query remembering to ask for it.
     */
    id: 'organisations',
    name: 'Organisations',
    // Readable by any signed-in user: an app has to be able to look up which
    // organisation the person signing in belongs to before it knows anything
    // else. The row holds a name and a status, never anything operational.
    perms: { read: ['users'], create: [], update: [], delete: [] },
    attributes: [
      ['name', 's', 160, true],
      // Used in addresses and in support conversations. Never changes.
      ['slug', 's', 60, true],
      ['team_id', 's', 64, true],
      // trial, using it, not paying yet, ends on trial_ends_at
      // active, paying
      // overdue, payment failed; still working, being chased
      // suspended, read-only; nobody can take an order
      // closed, gone, kept only so their history still reads
      ['status', 'e', ['trial', 'active', 'overdue', 'suspended', 'closed'], true, 'trial'],
      ['plan', 's', 40, false],
      ['trial_ends_at', 'd', null, false],
      ['owner_email', 's', 160, true],
      ['owner_name', 's', 160, false],
      ['country', 's', 60, false],
      ['phone', 's', 40, false],
      // Which of the six tools this hotel has asked for. The POS reads its own
      // name here and refuses to open if it is not listed.
      ['tools', 's[]', 40, false],
      ['note', 's', 1000, false],
      ['suspended_reason', 's', 300, false],
    ],
    indexes: [
      ['slug_unique', 'unique', ['slug']],
      ['team', 'key', ['team_id']],
      ['status', 'key', ['status']],
    ],
  },
  {
    /**
     * Somebody asking to be set up.
     *
     * Written by the public website, read only by a platform owner. Deliberately
     * a separate collection from `organisations`: a request is a stranger's
     * typing, and it must not be able to become a hotel without somebody
     * pressing a button.
     */
    id: 'org_requests',
    name: 'Setup requests',
    perms: { read: [], create: ['any'], update: [], delete: [] },
    attributes: [
      ['hotel_name', 's', 160, true],
      ['contact_name', 's', 160, true],
      ['email', 's', 160, true],
      ['phone', 's', 40, false],
      ['country', 's', 60, false],
      ['rooms', 's', 40, false],
      ['tools', 's[]', 40, false],
      ['message', 's', 2000, false],
      ['status', 'e', ['new', 'contacted', 'approved', 'declined'], true, 'new'],
      ['org_id_created', 's', 64, false],
    ],
    indexes: [['status_new', 'key', ['status']]],
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
      // possible, you cannot hand over less than no money, so a negative
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
      // Where the tip box appears, which is not one question.
      //
      // A waiter closing a table and a cook handing food over a counter are
      // different moments: one has had ten minutes of service to justify the
      // ask, the other is a person collecting a bag. A restaurant can
      // reasonably want the box on one screen and not the other, and
      // `tips_enabled` alone could only say all or nothing.
      //
      // `tips_enabled` is still honoured as a master switch so an older build,
      // or a database provisioned before this existed, keeps working.
      ['tips_ask_on', 'e', ['both', 'till', 'kitchen', 'none'], false, 'both'],
      /**
       * What a shift expense may be paid out of.
       *
       * 'cash_only', the drawer, and nothing else. This is the default because
       * it matches what actually happens: somebody takes notes out of the till
       * for a shop run. It also closes a hole. A cash expense reduces what the
       * drawer should hold at close, so it is checked against a physical count
       * within hours; an expense filed against mobile money reduces nothing
       * anybody counts, which makes "spent GH₵200, paid by momo" the easiest
       * unverifiable entry in the system to write.
       *
       * 'any', every payment method. For a restaurant that genuinely pays
       * suppliers by transfer from the same screen, and accepts that those
       * entries rest on the receipt rather than on a count.
       */
      ['expense_paid_from', 'e', ['cash_only', 'any'], false, 'cash_only'],
      /**
       * What a craft sale's number starts with.
       *
       * Its own sequence, separate from the kitchen's. One shared run of
       * numbers meant a shop receipt and a restaurant receipt could look alike
       * and sort together, and the two sides keep separate books everywhere
       * else. Blank falls back to the kitchen's prefix, which is what a
       * business running only one side wants.
       */
      ['craft_order_prefix', 's', 10, false, 'S'],
      /**
       * What a bar sale's number starts with.
       *
       * BLANK BY DEFAULT, and that is not the same choice as the shop's.
       *
       * The counter follows the prefix — see order-numbers — so a bar sharing
       * the kitchen's prefix shares its run of numbers, which is correct and
       * is what a business that thinks of one sequence expects. Giving the bar
       * a prefix of its own splits the run in two from that moment: the bar
       * starts again at the beginning under the new letters, and the numbers
       * already issued keep the numbers they were given.
       *
       * Left blank rather than defaulted to something, because a house with
       * one run of numbers is not wrong and should not have its receipts
       * renumbered by an upgrade.
       */
      ['bar_order_prefix', 's', 10, false],
      /**
       * What kind of business this is.
       *
       * One codebase, two trades. A restaurant and a consignment craft shop
       * share almost everything that matters, a catalogue, a till, shifts,
       * staff, receipts, reports, and differ in ownership of the goods and in
       * what the screens are called. Forking would have meant every fix made
       * twice and, in practice, made once.
       *
       * This decides which sections appear and what they are called. It does
       * not hide data: a shop that switches back still has its consignors.
       */
      ['business_type', 'e', ['restaurant', 'craft_shop'], false, 'restaurant'],
      /**
       * Which trades this business actually runs, as switches rather than as a
       * label.
       *
       * `business_type` said what a business WAS, which turned out to be the
       * wrong question: a place can have a kitchen and a craft corner under one
       * roof, one till and one set of staff, and asking it to pick was asking
       * it to run two systems. These say what it DOES, and any combination is
       * allowed except neither.
       *
       * Kept alongside the old field rather than replacing it, so a setup made
       * before this still opens with the sections it had.
       */
      ['kitchen_enabled', 'b', null, false, true],
      ['craft_enabled', 'b', null, false, false],
      /**
       * Whether customers may scan a code and order for themselves.
       *
       * On in a restaurant, where a table code is the point. Off by default in
       * a shop, where the normal way to buy is to hand something to a cashier, 
       * but available, because a market stall with a queue is exactly where
       * letting people order from their phone earns its keep.
       */
      ['self_order_enabled', 'b', null, false, true],
      /** What the shop keeps by default, in basis points. 3000 = 30%. */
      ['default_commission_bp', 'i', null, false, 3000],
      ['low_stock_default_bp', 'i', null, true, 3000],
      /**
       * Which accounts add up to "Costs" on the reports dashboard.
       *
       * A comma-separated list of account codes. Empty — which is what every
       * existing venue has — means every expense counts, which is what the
       * figure did before this setting existed. A new setting must never
       * silently rewrite last month's dashboard.
       *
       * Optional, for the reason set out on menu_items: a field that arrives
       * after the rows do can never be required.
       */
      ['cost_account_codes', 's', 2000, false],
      /**
       * Whether this business runs a bar.
       *
       * Its own switch rather than a category of drinks on the restaurant's
       * menu, for the reasons set out on `Module` in access.ts: a bar counts
       * bottles at both ends of a shift, pours cocktails whose ingredients
       * have to leave the shelf as they are poured, and answers for its own
       * drawer. Folded into the kitchen, a short till has two possible owners
       * and therefore none.
       */
      ['bar_enabled', 'b', null, false, false],
      // How the shift-end stock check asks its question.
      //
      // 'levels', a cook taps OK, Low or Out. Fast, and honest about being a
      // glance at a shelf rather than a measurement.
      //
      // 'counts', a cook types how much is actually there, and the system
      // works out the status from the ingredient's own thresholds. Slower, but
      // the answer stops being an opinion: two cooks looking at the same four
      // crates file the same status, and the number can be set against what the
      // recipes say should have been used, which is where waste and
      // over-portioning show up at all.
      ['stock_check_mode', 'e', ['levels', 'counts'], false, 'levels'],
      // Half a bucket, a quarter of a bottle. Real for anything measured, and
      // nonsense for anything counted in pieces, nobody has 2.5 eggs, and a
      // till with a numeric keypad will produce one by accident if the decimal
      // point is there to be pressed.
      ['stock_count_decimals', 'b', null, false, true],
      // Whether the bar's count at the start and end of a shift may be left
      // unfinished. Off, so it may not. See countGate: a count that can be
      // waved past is waved past on the nights it would have caught something,
      // and a shortage with two shifts to belong to belongs to neither.
      ['bar_count_skippable', 'b', null, false, false],
      // Whether whoever holds a petty cash box may count it themselves. Off:
      // a count is the check ON the custodian and catches nothing when the
      // person answerable for the money is the one answering. See canCountBox.
      ['imprest_custodian_counts', 'b', null, false, false],
      ['stock_variance_threshold_bp', 'i', null, true, 1000],
      ['stock_variance_value_floor', 'i', null, true, 2000],
      ['expense_approval_threshold', 'i', null, true, 20000],
      ['cash_variance_tolerance', 'i', null, true, 500],
      ['terminal_idle_lock_seconds', 'i', null, true, 180],
      /*
        THESE TWO LIVE HERE, ON SETTINGS, AND NOWHERE ELSE.

        Both were declared inside the ORDERS collection, a few hundred lines
        down, immediately after a field about waiting for the doors to open.
        Provisioning did exactly as it was told and created them there, so
        every run reported everything present and correct — while the settings
        screen, which is the only thing that writes them, was told by the
        database that it had never heard of either.

        The effect was a save that half worked and an instruction that could
        not help: "those settings do not exist yet, run Provision Appwrite",
        followed by a provision run that had nothing to add, followed by the
        same message. Nothing in the log ever said the field had been made
        somewhere else, because from the schema's point of view nothing was
        wrong.
      */
      // Minutes of quiet before a till puts a clock up. 0, and absent, is off.
      // Not required and off by default: a shop that has not asked for a
      // screensaver should not find one.
      ['idle_minutes', 'i', null, false, 0],
      // The margin below which a drink or dish is flagged, in basis points.
      // 3000 is 30%. Absent reads as the default rather than as "flag
      // nothing": a house that has not set a line still wants the obviously
      // thin ones coloured.
      ['margin_warn_bp', 'i', null, false, 3000],
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
      // and never restricted, a switch that can lock the owner out of their
      // own settings is a switch that eventually will.
      // Four roles' lists of sections, plus which of them have been decided.
      // Was 2000, which four well-populated roles could run past — and a value
      // too long to store is a save that silently does not happen.
      ['role_access', 's', 6000, false],
      // The hour, in the restaurant's own timezone, at which the once-a-day
      // report and the nightly backup go out. After close, not at midnight, 
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
      /*
        A colour for the till, where there is no picture.

        The categories along the top of a till are words, and words at arm's
        length on a busy counter all look like each other. A colour turns
        "read four labels" into "reach for the blue one".

        Second to a picture on purpose: a photograph of the thing is more
        recognisable than any swatch, and one uploaded deliberately must not be
        overridden by a colour chosen in a hurry. Blank is the default and
        keeps the plain chip. See category-colour.ts.
      */
      ['colour', 's', 9, false],
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
      // Which side of the business this belongs to. A kitchen category and a
      // craft category are managed on different screens by different people
      // and would otherwise pile into one list.
      ['module', 'e', ['kitchen', 'craft', 'bar'], false, 'kitchen'],
    ],
    indexes: [['active_sort', 'key', ['active', 'sort']], ['module_sort', 'key', ['module', 'sort']]],
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
      // timed block; these say who did it, when, and why, which is what makes
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
      // ---------------------------------------------------------- craft shop
      //
      // A shop sells the same table this restaurant sells dishes from, a thing
      // with a name, a price, a picture and a category, so the catalogue is
      // shared rather than duplicated. What a shop adds is ownership: who this
      // piece belongs to, what it was worth when it arrived, and how many are
      // left. Blank on every restaurant row, and nothing reads them there.
      // Kitchen or craft. Set from the category it is created under, and kept
      // on the row so a list can be filtered without joining.
      ['module', 'e', ['kitchen', 'craft', 'bar'], false, 'kitchen'],
      ['consignor_id', 's', 64, false],
      ['intake_id', 's', 64, false],
      // Overrides the consignor's rate for this piece. Used when one item is
      // negotiated differently, a large commissioned work, say.
      ['commission_bp', 'i', null, false],
      // A commission agreed as a flat amount per piece instead of a share.
      // Zero, or absent, means the percentage applies. Some agreements are
      // genuinely "two cedis a basket, whatever it sells for", and forcing
      // that into a percentage makes it a different number at every price.
      ['commission_flat', 'i', null, false, 0],
      ['barcode', 's', 60, false],
      // Pieces on the shelf. Only meaningful when the product has no variants;
      // with variants the count lives on each one, because that is what sells.
      // Optional, not required. A required attribute has to appear in every
      // write even though it carries a default, and the first form that
      // forgot it failed with "Missing required attribute on_hand" rather
      // than quietly using the zero it already had.
      ['on_hand', 'i', null, false, 0],
      /**
       * A single handmade piece. Optional, and the note above on_hand is the
       * whole reason why.
       *
       * This was required, and it was added to a table that already held every
       * dish the restaurant sells. Appwrite checks a document against the
       * requirements as they stand NOW, so a dish written before this existed
       * has no value for it and fails the check — not only when saved, but on
       * any change at all. Marking jollof sold out at the pass came back
       * "missing required attribute is_one_off", which names a craft shop
       * field to a cook who has run out of chicken.
       *
       * A field that arrives after the rows do cannot be required. There is no
       * moment at which the existing rows were ever going to have it.
       */
      ['is_one_off', 'b', null, false, false],
      ['maker_note', 's', 500, false], // the card that sits beside it
      /**
       * Work the shop does, rather than a thing the shop sells.
       *
       * Alterations, sewing, a repair. Rung up at the same counter into the
       * same takings, and with no shelf at all — so nothing comes off when it
       * sells, it is never counted, it never runs out, and it is not part of
       * anybody's unsold stock. See craft-services.ts for what each of those
       * did before there was a way to say this.
       *
       * Optional, for the reason written twice above: a field that arrives
       * after the rows do cannot be required, or every dish written before it
       * fails its next save.
       */
      ['is_service', 'b', null, false, false],
      /**
       * People who may change THIS product's price at the till.
       *
       * Named, rather than granted across the board. The blanket permission on
       * a staff record is a manager's grant — any price, any item, any sale —
       * and it is the wrong shape for what a shop asks for, which is narrow:
       * the display baskets get haggled over, so the two people on that
       * counter should be able to drop the price of a basket and nothing else.
       *
       * Staff ids, and the till matches either the staff record's own id or
       * the account behind it. See canRepriceLine.
       */
      ['price_editors', 's[]', 64, false],
    ],
    indexes: [
      ['category_active', 'key', ['category_id', 'active']],
      ['name_search', 'fulltext', ['name']],
      ['consignor', 'key', ['consignor_id']],
      ['intake', 'key', ['intake_id']],
      ['barcode', 'key', ['barcode']],
    ],
  },
  {
    /**
     * A dish can sit in several categories at once, Jollof in both "Lunch"
     * and "Mains", and each category has its own availability hours, so the
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
     * A station is WHERE FOOD IS COOKED, hot line, grill, bar, pastry. It is
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
      /*
        Whose choices these are.

        Without it every side saw every group, so "Rare, medium, well done"
        was offered on a gin and tonic and "Single or double" on a steak. A
        list that offers nonsense is one people stop reading, including the
        lines on it that were right.

        Absent means the kitchen's, which is what every group written before
        this one existed was.
      */
      ['module', 'e', ['kitchen', 'craft', 'bar'], false, 'kitchen'],
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
    // being a meaningful secret the moment that list existed, anyone can pick
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
    // table code could read every order in the restaurant, the anonymous
    // session that lets them order is indistinguishable from any other. Staff
    // read the collection; a guest is granted read on their own order document
    // as it is created (see createOrder), which is all they ever needed.
    //
    // delete is an admin's, and nobody else's. It was nobody's at all, which
    // read as "an order is never thrown away" and is right for a cook, a
    // waiter and a cashier — an order is the record that money is owed, and
    // deleting one is how a night's takings quietly shrink.
    //
    // But the Erase records page is an admin deliberately clearing a period,
    // and it could not: the deletes failed, silently, while the same run
    // removed the order's ITEMS, which staff may delete. So a purge left every
    // order in place with nothing on it, and reported success. Something a
    // screen offers has to be something the database allows.
    perms: { read: ALL_STAFF, create: ['users'], update: ALL_STAFF, delete: ADMIN },
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
      // Set when an order was taken after its shift had already run past its
      // limit. The shift is allowed to close over it; the order is not closed,
      // it waits here and the next shift opened picks it up. The one exception
      // to a shift never closing over an open order, and deliberately narrow.
      ['shelved_at', 'd', null, false],
      ['shelved_from_shift', 's', 64, false],
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
      // Which side of the business sold this, so the two sets of books can be
      // read apart. Taken from the till that rang it up.
      ['module', 'e', ['kitchen', 'craft', 'bar'], false, 'kitchen'],
      /**
       * What the CUSTOMER was told to expect, end to end.
       *
       * Cooking time plus however long the tickets already on the pass will
       * take before this one is started. Stored rather than recomputed so the
       * figure a customer was told is the figure that stays on their screen, 
       * a menu edited at seven must not quietly change what was promised at six.
       */
      ['eta_minutes', 'i', null, false],
      /**
       * How much of `eta_minutes` was spent waiting for the doors.
       *
       * Zero, or absent, for anything ordered while the kitchen was open.
       *
       * Stored because the two audiences need different figures from the same
       * order. `eta_minutes` is the kitchen's real schedule, uncapped, so a
       * cook is judged against a time they could actually hit. What the
       * customer is told caps the KITCHEN's share at an hour and adds the door
       * wait whole — and working that split out needs to know which part was
       * which. Re-deriving it later from the opening hours would give a
       * slightly different answer every time it was asked, because the doors
       * get closer while the order sits there.
       *
       * Optional, for the reason set out on menu_items: a field that arrives
       * after the rows do can never be required.
       */
      ['opening_wait_minutes', 'i', null, false],
      /**
       * What the KITCHEN is measured against: the cooking time alone, summed
       * from the prep time set on each dish.
       *
       * Deliberately not the same number as `eta_minutes`, and separating the
       * two is the whole point. The customer's wait includes queueing, which is
       * time before a cook touches the ticket, judging the kitchen by it would
       * hand them extra minutes on a busy night for the very orders where being
       * late matters most, and only because other people were also waiting.
       *
       * Lateness is measured from when the ticket was accepted, against this.
       */
      ['prep_minutes', 'i', null, false],

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
      ['module_status', 'key', ['module', 'status']],
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
      // The prep time the dish had when it was ordered.
      //
      // Snapshotted like the price, and for the same reason: an admin raising
      // a dish from 10 minutes to 25 must not make every ticket already on the
      // pass suddenly on time, nor lowering it make them all late at once.
      ['prep_minutes', 'i', null, false],
      // ---------------------------------------------------------- craft shop
      //
      // Who this piece belonged to and what was agreed, snapshotted at the
      // moment of sale. Rates change and consignors leave; a statement worked
      // out from today's rate would quietly restate what somebody was paid
      // last year. The line has to carry its own terms.
      ['variant_id', 's', 64, false],
      ['variant_label', 's', 60, false],
      /**
       * What this line would have cost at the menu price.
       *
       * Set only when somebody with permission changed the price at the till.
       * Two jobs, and the second is the important one.
       *
       * It is the record: a line sold under is a decision somebody made, and
       * "sold for 40 instead of 55" is a sentence a report can produce a month
       * later, which "sold for 40" is not.
       *
       * And it is the flag order-guard reads. The guard reprices every line
       * from the menu a moment after an order lands, which is what stops a
       * customer's phone sending its own prices — and would otherwise undo a
       * legitimate override a second after the till applied it. A line with
       * this set is left at what the till said.
       */
      ['list_price', 'i', null, false],
      ['price_changed_by', 's', 64, false],
      ['consignor_id', 's', 64, false],
      ['commission_bp', 'i', null, false],
      // The flat per-piece commission agreed for this line, when that is what
      // was agreed. Snapshotted for the same reason the rate is.
      ['commission_flat', 'i', null, false, 0],
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
    /**
     * Taking money is front-line work, and so is admitting you pressed the
     * wrong button while doing it.
     *
     * Update was management-only, which left staff able to CREATE a payment of
     * any amount by any method and unable to correct one. That asymmetry is
     * what put a cook in the position of watching the cash drawer read over by
     * the amount the card machine read short, all night, with no way to say
     * so. The screens only ever offer the METHOD — never the amount, never the
     * order — because which drawer the money went into is the thing that is
     * routinely mistyped and harmlessly fixed.
     *
     * Appwrite has no field-level permission, so the narrowness lives in the
     * screens and the honesty lives in the audit log: every correction is
     * written there with a name against it.
     *
     * delete is an admin's, for the Erase records page and nothing else. A
     * payment is the record that money came in; a cashier who could remove one
     * could remove a night's takings. Voiding one is an admin's too.
     */
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: ALL_STAFF, delete: ADMIN },
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
    // delete is an admin's, for the Erase records page. A shift is what the
    // money hangs off, so it goes last and only ever deliberately.
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: ALL_STAFF, delete: ADMIN },
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
      /*
        An admin asking for the closing report to go out again.

        On the SHIFT rather than on the report, for two reasons. Nobody can
        write to summary_reports from a browser — it is the record of what was
        sent, and an admin able to edit it could rewrite what a report said —
        and the shift is already an update the background job is subscribed to,
        so asking here needs no new trigger and no new permission.

        Cleared by the job once the report has gone, so the field is a request
        rather than a setting: present means somebody is waiting for an email.
      */
      ['summary_resend_at', 'd', null, false],
      ['summary_resend_by', 's', 64, false],
      ['stock_check_status', 'e', ['pending', 'complete'], true, 'pending'],
      ['posted_to_ledger', 'b', null, true, false],
      /**
       * Settled: this night is finished and nothing in it may be changed.
       *
       * Closing a shift ends it; it does not settle it. The close time can be
       * corrected, an order moved onto or off it, a payment voided, an expense
       * reclassified — all deliberate, all needed. What was missing was any
       * way to say "this one has been reported on now", so a figure somebody
       * has read and acted upon could quietly become a different figure a week
       * later.
       *
       * Not the same as closing an accounting PERIOD, which draws a line under
       * every entry up to a date. This is one night and the rows hanging off
       * it, and a business can want either without the other.
       */
      ['locked_at', 'd', null, false],
      ['locked_by', 's', 64, false],
      ['lock_reason', 's', 300, false],
      ['notes', 's', 1000, false],
      /**
       * Which side of the business this shift belongs to.
       *
       * A kitchen and a craft shop under one roof keep separate books. They
       * take money at different counters, spend on different things and answer
       * to different people, so one shift covering both would produce a figure
       * neither side could act on.
       *
       * Each side has its own open shift, and closing one never closes the
       * other. Rows written before this are kitchen, which is what they were.
       */
      ['module', 'e', ['kitchen', 'craft', 'bar'], false, 'kitchen'],
    ],
    // One shift may be open per venue PER SIDE, the query that enforces it
    // filters on both, so this index carries both.
    indexes: [
      ['venue_status_opened', 'key', ['venue_id', 'status', 'opened_at']],
      ['venue_module_status', 'key', ['venue_id', 'module', 'status']],
      ['code_unique', 'unique', ['venue_id', 'code']],
    ],
  },
  {
    id: 'shift_expenses',
    name: 'Shift expenses',
    /**
     * Cashiers may correct what they wrote.
     *
     * They could record an expense and then not touch it, so a figure typed
     * wrongly at eight o'clock stood until an admin noticed, which is usually
     * after the drawer has been counted against it. The person who was there
     * is the person who knows what the receipt says.
     *
     * The app only offers this while the shift is still open, because after it
     * closes the number has been counted against and correcting it is a
     * decision with consequences elsewhere — that is an admin's to make. The
     * permission itself cannot express "while open", so that part is the app's
     * rule rather than the database's. Deleting is still an admin's alone: a
     * corrected expense leaves a trail, a deleted one leaves a hole.
     */
    perms: {
      read: ['team:cashiers', ...MGMT],
      create: ['team:cashiers', ...MGMT],
      update: ['team:cashiers', ...MGMT],
      delete: ADMIN,
    },
    attributes: [
      ['shift_id', 's', 64, false], // blank = recorded outside a shift
      // Which side of the business paid for this. Carried on the row rather
      // than read from the shift, because an expense recorded outside a shift
      // still belongs to one side's books.
      ['module', 'e', ['kitchen', 'craft', 'bar'], false, 'kitchen'],
      // The old fixed list. Kept because an enum cannot be widened in place
      // without dropping the column and the data with it; `category_key` is
      // what the app reads and writes now, and it points at a row the
      // restaurant created in `expense_categories`.
      ['category', 'e', ['supplies', 'transport', 'utilities', 'repairs', 'staff_advance', 'petty_cash', 'other'], true],
      ['category_key', 's', 60, false],
      ['payee', 's', 160, false],
      // Who the money went to. Often there is no supplier at all, a driver, a
      // cook sent to the market, a one-off stall, and pretending otherwise is
      // what makes people type "market" into a supplier field forever.
      ['paid_to_kind', 'e', ['supplier', 'staff', 'open_market', 'other'], false, 'other'],
      ['supplier_id', 's', 64, false],
      ['paid_to_staff_id', 's', 64, false],
      ['amount', 'i', null, true, 0],
      ['paid_from_method_id', 's', 64, true],
      /**
       * The petty cash box this came out of, when it came out of one.
       *
       * Blank on everything else, which is most of it. What it changes is
       * which account the expense is credited against: money out of a box
       * reduces the box, not the till's cash, and crediting the till for
       * money that never left it is how a drawer ends up chased for a
       * shortage that is sitting in a tin in the office. See postExpense.
       */
      ['imprest_float_id', 's', 64, false],
      /**
       * Whether this came out of the money taken during the shift.
       *
       * Two different things were being filed as one. A cook sent to the market
       * with cash from the drawer has spent the drawer's money, and the count
       * at the end of the night must expect that much less. A cook who paid out
       * of their own pocket, or from money brought from home, has spent
       * something the drawer never held — recording it as a deduction makes the
       * drawer look short by an amount that was never in it, and the shift is
       * chased for a shortage that did not happen.
       *
       * Optional and true by default, because everything written before this
       * existed was money out of the drawer and must keep counting that way.
       * Optional rather than required for the reason set out on menu_items:
       * a field that arrives after the rows do can never be required.
       */
      ['from_takings', 'b', null, false, true],
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
     * a customer would be told four times that their food is ready, which is
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
     * A customer asking to call an order back, in the first couple of minutes
     * after sending it.
     *
     * A request rather than an action, because a guest cannot be allowed to
     * write to an order. Document permissions in Appwrite are per document, not
     * per field: letting a phone change the status would let it change the
     * total, and the whole reason order-guard exists is that a phone is not
     * trusted with what things cost.
     *
     * So the guest writes here, which is the only thing they may do, and the
     * server decides whether the window is still open. The row stays either
     * way, a cancellation inside two minutes and a request that arrived too
     * late are both worth being able to look up when somebody asks why food
     * they thought they had called off turned up.
     */
    id: 'order_cancellations',
    name: 'Order cancellations',
    perms: { read: ALL_STAFF, create: ['users'], update: ALL_STAFF, delete: [] },
    attributes: [
      ['venue_id', 's', 64, false],
      ['order_id', 's', 64, true],
      ['requested_at', 'd', null, false],
      ['status', 'e', ['requested', 'cancelled', 'refused'], true, 'requested'],
      ['refused_reason', 's', 200, false],
    ],
    indexes: [['order', 'key', ['order_id']]],
  },
  {
    /**
     * Taking a sale back out, after it has been paid for.
     *
     * A request rather than an action, for the same reason cancellations are:
     * the consignor ledger has NO create, update or delete permission for
     * anybody at all. That is deliberate — it is what a maker is paid from,
     * and a balance somebody can type into is not evidence. So an admin says
     * what should happen here, and the server, which holds the API key, is the
     * only thing that touches the ledger.
     *
     * `mode` is the difference between two jobs that get asked for in the same
     * words. A TEST sale should leave no trace anywhere, including on the
     * maker's statement. A MISTAKE is a real sale coming back: the money goes
     * out, the piece goes back on the shelf, and the order stays on the record
     * marked void, because somebody was genuinely served and it genuinely came
     * back.
     *
     * The row stays either way. "Why is this piece back in stock and where did
     * the money go" is a question somebody asks weeks later, and the answer
     * should not be a gap.
     */
    /**
     * The same product, from a different supplier.
     *
     * A request rather than an action, for the reason order_reversals is one:
     * the consignor ledger has no create, update or delete permission for
     * anybody at all, deliberately, because it is what a maker is paid from.
     * An admin says what should happen; the thing holding the API key does it.
     *
     * `mode` is the whole question. Moving a supplier is not one decision but
     * four, differing in whether the stock on the shelf changes hands and
     * whether anything already recorded does — and picking the wrong one
     * leaves a maker paid for somebody else's work, or unpaid for their own.
     *
     * The row stays afterwards. "Why did Ama's statement drop by four hundred
     * cedis in August" is a question somebody asks in November, and the answer
     * should not be a gap.
     */
    id: 'consignor_reassignments',
    name: 'Supplier reassignments',
    perms: { read: MGMT, create: ADMIN, update: [], delete: [] },
    attributes: [
      ['venue_id', 's', 64, false],
      ['menu_item_id', 's', 64, true],
      ['from_consignor_id', 's', 64, false],
      ['to_consignor_id', 's', 64, true],
      ['mode', 'e', ['future_and_stock', 'split', 'all_time', 'period'], true, 'future_and_stock'],
      // Only read for the 'period' mode; both ends included.
      ['from_at', 'd', null, false],
      ['to_at', 'd', null, false],
      ['requested_at', 'd', null, false],
      ['requested_by', 's', 64, false],
      ['reason', 's', 300, false],
      ['status', 'e', ['requested', 'done', 'failed'], false, 'requested'],
      // What actually moved, in words. A reassignment that could not shift a
      // paid-out entry has to say so somewhere, and the admin who asked for it
      // is not reading a log.
      ['note', 's', 1000, false],
    ],
    indexes: [['item', 'key', ['menu_item_id']], ['status_requested', 'key', ['status', 'requested_at']]],
  },
  {
    id: 'order_reversals',
    name: 'Order reversals',
    perms: { read: MGMT, create: ADMIN, update: [], delete: [] },
    attributes: [
      ['venue_id', 's', 64, false],
      ['order_id', 's', 64, true],
      ['mode', 'e', ['erase', 'refund'], true, 'refund'],
      ['requested_at', 'd', null, false],
      ['requested_by', 's', 64, false],
      ['reason', 's', 300, false],
      ['status', 'e', ['requested', 'done', 'failed'], false, 'requested'],
      // What the server actually managed to do, in words. A reversal that
      // could not remove a paid-out consignment entry has to say so somewhere,
      // and the person who asked for it is not watching a log.
      ['note', 's', 1000, false],
    ],
    indexes: [['order', 'key', ['order_id']], ['status_requested', 'key', ['status', 'requested_at']]],
  },
  {
    /**
     * Expense categories, defined by the restaurant.
     *
     * `account_code` is what makes a category more than a label: it decides
     * which line of the accounts the money lands on when the shift is closed.
     */
    /**
     * Whose spending this is a kind of.
     *
     * A bar recording a crate of tonic should not scroll past "Kitchen gas"
     * and "Craft packaging" to find it, and a category list that is three
     * trades long is one people file under whatever is nearest.
     *
     * "general" shows everywhere, and is what an absent value means — because
     * every category that existed before this was used by everybody, and
     * quietly narrowing them to the kitchen would empty the other two lists.
     */
    id: 'expense_categories',
    name: 'Expense categories',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['key', 's', 60, true],
      ['name', 's', 80, true],
      // 'admin_only' is the odd one out: it answers "who may see this",
      // not "which trade is it". It shares the column because it is one
      // question on the form — a category is either one side's, everybody's,
      // or the office's — and a category cannot be both bar-only and
      // admin-only. If that combination is ever wanted it needs its own flag.
      ['module', 'e', ['kitchen', 'craft', 'bar', 'general', 'admin_only'], false, 'general'],
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
    /** Ingredient groupings, Produce, Dry goods, Drinks, the restaurant's own. */
    /**
     * What a thing is bought in: a bottle, a crate, a case.
     *
     * A list the house owns rather than a box everybody types into, because a
     * typed box gives you "crate", "Crate" and "crates" on three items and no
     * way to see they are the same thing.
     *
     * `units` is a SUGGESTION, not a rule. Crates are the reason: some hold
     * twelve and some hold twenty-four, so the number that counts stays on the
     * item. This only saves typing it when the answer is usually the same.
     */
    id: 'pack_kinds',
    name: 'Pack kinds',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['key', 's', 60, true],
      ['name', 's', 80, true],
      ['units', 'f', null, false, 0],
      ['sort', 'i', null, false, 0],
      ['active', 'b', null, false, true],
    ],
    indexes: [['key_unique', 'unique', ['key']]],
  },
  {
    id: 'ingredient_categories',
    name: 'Ingredient categories',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['key', 's', 60, true],
      ['name', 's', 80, true],
      /**
       * Whose groupings these are.
       *
       * Sauces, proteins and vegetables are a kitchen's way of walking its
       * larder, and they were appearing on the bar's bottles because the list
       * was shared. Absent is the kitchen, which is what every grouping that
       * existed before the bar did actually was.
       */
      ['module', 'e', ['kitchen', 'craft', 'bar'], false, 'kitchen'],
      ['sort', 'i', null, false, 0],
      ['active', 'b', null, false, true],
    ],
    indexes: [['key_unique', 'unique', ['key']]],
  },
  {
    id: 'shift_stock_checks',
    name: 'Shift stock checks',
    // delete is an admin's, so a shift can be erased with its counts rather
    // than leaving rows pointing at a shift that no longer exists.
    perms: { read: ALL_STAFF, create: ['team:cashiers', 'team:cooks', ...MGMT], update: ['team:cashiers', 'team:cooks', ...MGMT], delete: ADMIN },
    attributes: [
      ['shift_id', 's', 64, true],
      ['ingredient_id', 's', 64, true],
      /**
       * Which end of the shift this count was taken at.
       *
       * A bar counts its bottles when it opens and again when it closes, and
       * the two are not the same record: the opening count is what the person
       * coming on is accepting responsibility for, and the closing one is what
       * they are handing over. One row per shift per ingredient could only ever
       * hold one of them, so a bar's variance would be measured against
       * whatever the last shift happened to leave behind.
       *
       * Rows written before this existed are closing counts, which is what
       * they were.
       */
      ['phase', 'e', ['open', 'close'], false, 'close'],
      ['opening_qty', 'f', null, true, 0],
      ['theoretical_qty', 'f', null, true, 0],
      ['counted_qty', 'f', null, false],
      ['status', 'e', ['OK', 'LOW', 'OUT'], true, 'OK'],
      ['status_source', 'e', ['auto', 'manual_override'], true, 'auto'],
      ['variance_qty', 'f', null, true, 0],
      ['variance_value', 'i', null, true, 0],
      ['checked_by', 's', 64, false],
      ['note', 's', 300, false],
      /**
       * When an admin took this count back, and who did.
       *
       * A count that was wrong is not deleted. It happened: somebody stood at
       * the shelf and wrote a number down, and the shelf moved because of it.
       * Erasing the row would leave the movement that corrected the stock with
       * nothing behind it and the next person unable to see that the figure
       * they are looking at was ever disputed.
       *
       * So the count stays, marked, and the shelf is put back by an opposite
       * movement — the same way the books undo an entry. See undoBarCount.
       */
      ['undone_at', 'd', null, false],
      ['undone_by', 's', 64, false],
    ],
    indexes: [['shift_ing', 'key', ['shift_id', 'ingredient_id']], ['shift_phase', 'key', ['shift_id', 'phase']]],
  },

  // --------------------------------------------------------------- inventory
  {
    id: 'ingredients',
    name: 'Ingredients',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['name', 's', 160, true],
      /**
       * What this is counted in.
       *
       * A bar counts in bottles and pours in measures, and neither is a
       * kitchen unit — "0.7 l of gin" is a sentence nobody at a bar says while
       * holding a bottle. The count sheet groups by this, so the person
       * walking the shelves counts all the bottles, then all the crates,
       * rather than switching units every third line.
       */
      ['unit', 'e', ['g', 'kg', 'ml', 'l', 'each', 'pack', 'bottle', 'case', 'shot', 'cl'], true],
      ['base_unit_cost', 'i', null, true, 0],
      /**
       * Which side of the business keeps this on its shelves.
       *
       * A bar counting rice and a kitchen counting gin are both counting
       * somebody else's larder, and a count sheet with forty lines that are
       * not yours on it is one people tap through. Rows written before the bar
       * existed are the kitchen's, which is what they were.
       */
      ['module', 'e', ['kitchen', 'craft', 'bar'], false, 'kitchen'],
      ['current_qty', 'f', null, true, 0],
      ['par_level', 'f', null, true, 0],
      ['low_threshold', 'f', null, false],
      ['critical', 'b', null, true, false],
      ['supplier_id', 's', 64, false],
      ['category', 's', 80, false],
      /**
       * How many counting units arrive in one pack, and what the pack is
       * called.
       *
       * A bar buys a bottle of Havana Club and pours it as shots. Both are
       * true, and neither is a sum anybody should be doing in their head after
       * a shop run. Without this, "1 bottle" is recorded as one shot and the
       * price paid for the bottle becomes the price of a shot — which values
       * the shelf at twenty-eight times what is on it and poisons every dish
       * costing downstream.
       *
       * Not required, and nought on everything that came before: a kitchen
       * buying rice by the kilo has no pack and must never be asked for one.
       * See packs.ts — a size of 0 or 1 means no pack at all.
       */
      ['pack_size', 'f', null, false, 0],
      ['pack_name', 's', 40, false],
      /**
       * Counted by the bartender at the start and end of every shift.
       *
       * The bottled drinks, in practice: things that leave whole and are quick
       * to see. Spirits are measured far less often, because forty open
       * bottles eyeballed at two in the morning produce numbers nobody
       * believes.
       *
       * Not required, and false everywhere to begin with — see shiftCounted:
       * a bar that has marked nothing keeps counting everything, so upgrading
       * cannot silently switch the count off.
       */
      ['count_each_shift', 'b', null, false, false],
      // The sentence a cook reads at the end of a shift, in the restaurant's
      // own words: "OK = 10pcs or more . Low = under 10pcs".
      //
      // Par levels and thresholds are numbers in a unit the system understands
      //, kilograms, litres, each. The shelf does not hold kilograms, it holds
      // buckets, crates, half a bottle and a tubber of yam. Asking somebody to
      // convert at eleven at night is how three people end up with three
      // different meanings of "low", and the report that comes out is worth
      // nothing. So the rule is written once, by whoever knows, in the units
      // actually on the shelf.
      ['check_guide', 's', 160, false],
      // What buying this counts as, so recording a delivery does not also ask
      // somebody to classify it. Rice is always Supplies; nobody should have
      // to say so twice a week.
      ['expense_category_key', 's', 60, false],
      /**
       * Whether somebody has to count this at the end of a shift.
       *
       * Not everything bought sits on a shelf. Transport, a delivery fee, gas
       * for the van, a repair: these are worth recording as items so a shop run
       * can be broken down and the spending is not one lump called "other" —
       * but there is nothing to walk over and look at, and putting them on the
       * closing list asks a cook to count a taxi. A list with nonsense in it is
       * a list people learn to tap through, which costs the count on the things
       * that do matter.
       *
       * True by default: everything that existed before this question is food
       * on a shelf and must keep being counted.
       */
      ['counted_at_close', 'b', null, false, true],
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
      /*
        The size this applies to, where it applies to one.
        
        A cocktail's recipe belongs to the drink: a mojito is a mojito however
        it is rung up. A bottled drink's sizes are not like that — a small Club
        and a large Club are two objects, bought, stacked and counted
        separately, and running out of one says nothing about the other.

        Without this both sizes poured the same measure of the same thing, so
        selling a large took a small off the shelf and the count drifted by the
        difference every time. Nothing reported it: as far as the books were
        concerned, one drink had left.

        Absent means the whole drink, which is what every recipe written before
        this meant.
      */
      ['variant_id', 's', 64, false],
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
    // delete is an admin's, for the Erase records page. Erasing these does not
    // recalculate what is on the shelf, which is said on the page itself.
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: [], delete: ADMIN },
    attributes: [
      ['ingredient_id', 's', 64, true],
      ['type', 'e', ['purchase', 'sale_depletion', 'waste', 'adjustment', 'count_correction', 'transfer'], true],
      /**
       * Where it happened, and for a transfer, the other end.
       *
       * Optional, because every movement written before locations existed
       * happened at the one place the business had. A transfer writes a pair
       * of rows carrying both ids, so neither half can exist without naming
       * where the stock went — an independent subtraction and addition can
       * half-fail, and stock that exists in neither place is the hardest kind
       * of discrepancy to find.
       */
      ['location_id', 's', 64, false],
      ['to_location_id', 's', 64, false],
      ['qty_delta', 'f', null, true, 0],
      ['unit_cost', 'i', null, true, 0],
      ['ref_type', 's', 40, false],
      ['ref_id', 's', 64, false],
      ['shift_id', 's', 64, false],
      ['created_by', 's', 64, false],
      ['note', 's', 300, false],
    ],
    indexes: [['ingredient_created', 'key', ['ingredient_id', '$createdAt']], ['shift', 'key', ['shift_id']], ['location', 'key', ['location_id']]],
  },
  {
    /**
     * A count of the shop's shelves, waiting to be applied.
     *
     * The shelf does not move when somebody counts it. It moves when an admin
     * approves what they found, and the gap between those two moments is the
     * whole point of this collection existing: an adjustment is the one write
     * in the shop that can make stock disappear without a sale behind it, and
     * the person holding the clipboard should not also be the person who signs
     * it off.
     *
     * Which is why the count is stored rather than applied and reversed. A
     * pending count changes nothing — the till still sells what the shelf says
     * — so an approval that never comes costs nothing, and a rejection is not
     * an unpicking.
     */
    id: 'stock_counts',
    name: 'Stock counts',
    // Anybody on the shop floor may submit one; only an admin may apply it.
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: ADMIN, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, false],
      ['counted_by', 's', 64, true],
      ['counted_at', 'd', null, true],
      ['note', 's', 300, false],
      ['status', 'e', ['pending', 'approved', 'rejected'], true, 'pending'],
      ['reviewed_by', 's', 64, false],
      ['reviewed_at', 'd', null, false],
      ['review_note', 's', 300, false],
      // Totals as counted, so the list of pending counts reads without
      // fetching every line of every one of them.
      ['line_count', 'i', null, true, 0],
      ['missing_pieces', 'i', null, true, 0],
      ['missing_value', 'i', null, true, 0],
      ['surplus_pieces', 'i', null, true, 0],
    ],
    indexes: [
      ['status_counted', 'key', ['status', 'counted_at']],
      ['venue_status', 'key', ['venue_id', 'status']],
    ],
  },
  {
    /**
     * One difference a count found.
     *
     * `expected` is what the shelf said WHEN IT WAS COUNTED, and it is kept
     * rather than re-read at approval so the approver can see whether the
     * ground has moved underneath the count. `delta` is what gets applied —
     * not the counted figure — because sales between the count and the
     * approval are real movements of their own, and overwriting the shelf with
     * an absolute number would erase them.
     */
    id: 'stock_count_lines',
    name: 'Stock count lines',
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: ADMIN, delete: ADMIN },
    attributes: [
      ['count_id', 's', 64, true],
      ['menu_item_id', 's', 64, true],
      ['variant_id', 's', 64, false],
      ['name_snapshot', 's', 160, true],
      ['variant_label', 's', 60, false],
      ['consignor_id', 's', 64, false],
      ['consignor_name', 's', 160, false],
      ['expected', 'i', null, true, 0],
      ['counted', 'i', null, true, 0],
      ['delta', 'i', null, true, 0],
      ['reason', 'e', ['counted', 'damaged', 'lost', 'returned'], true, 'counted'],
      ['unit_price', 'i', null, true, 0],
      // Set when the movement has been written, so re-approving cannot apply
      // the same difference twice.
      ['applied', 'b', null, false, false],
    ],
    indexes: [['count', 'key', ['count_id']]],
  },
  {
    /**
     * A place stock physically sits: a store room, a bar, a shop floor.
     *
     * A bar buys a case of tonic into a store and carries bottles out as the
     * night needs them, and one number cannot describe that. "Forty-two
     * tonics" is true of the business and useless to the person behind the
     * bar, who has nine and is about to run out — and useless to whoever does
     * the ordering, who sees forty-two and buys nothing.
     *
     * A business that has never thought about this gets one location per side
     * and everything behaves exactly as it did.
     */
    id: 'stock_locations',
    name: 'Stock locations',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, false],
      ['name', 's', 120, true],
      // store: deliveries land here, nothing is sold from it.
      // counter: the bar or shop floor, what a sale comes off and what gets
      // counted at the start and end of a shift.
      ['kind', 'e', ['store', 'counter'], true, 'counter'],
      ['module', 'e', ['kitchen', 'craft', 'bar'], false, 'kitchen'],
      ['active', 'b', null, false, true],
      ['sort', 'i', null, false, 0],
    ],
    indexes: [['venue_module', 'key', ['venue_id', 'module', 'active']]],
  },
  {
    /**
     * How much of one thing is in one place.
     *
     * The total on `ingredients.current_qty` is the SUM of these, not a
     * separate record of the same fact. That ordering is deliberate: a total
     * kept as its own number drifts away from the places it claims to add up,
     * and the drift is invisible because both figures look authoritative.
     */
    id: 'stock_levels',
    name: 'Stock levels',
    // Written by a sale and by a pour, so front-line staff need to write it.
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: ALL_STAFF, delete: ADMIN },
    attributes: [
      ['ingredient_id', 's', 64, true],
      ['location_id', 's', 64, true],
      ['qty', 'f', null, true, 0],
    ],
    indexes: [
      ['ing_loc', 'key', ['ingredient_id', 'location_id']],
      ['location', 'key', ['location_id']],
    ],
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
      /**
       * Retired, not removed.
       *
       * An account with money posted to it can never be deleted — the postings
       * are what make last month's figures readable, and taking the account
       * away turns them into a row of bare numbers. So the only honest way to
       * stop using one is to archive it: it disappears from every list that
       * offers a choice, and stays wherever it has already been used.
       *
       * Optional and true by default, for the reason set out on menu_items: a
       * field that arrives after the rows do can never be required.
       */
      ['active', 'b', null, false, true],
    ],
    indexes: [['code_unique', 'unique', ['code']]],
  },
  {
    /**
     * Things the business owns and uses rather than sells.
     *
     * A fridge, an oven, a van, the fit-out of a room. They are not an expense
     * on the day they are bought — the money left, but the business still has
     * the fridge — so the cost sits on the balance sheet and is charged to the
     * profit and loss a month at a time over the years it is used. That is the
     * whole of what depreciation is, and doing it is the difference between
     * knowing what a month cost to run and being told the month you bought an
     * oven was a disaster.
     *
     * The register is here rather than worked out from journal entries because
     * an asset has facts of its own — what it cost, when it arrived, how long
     * it is expected to last, whether it has been sold — and none of those
     * survive being flattened into debits and credits.
     */
    id: 'fixed_assets',
    name: 'Fixed assets',
    perms: { read: MGMT, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, false],
      ['name', 's', 160, true],
      ['category', 's', 80, false],
      ['acquired_on', 'd', null, true],
      ['cost', 'i', null, true, 0],
      // What it is expected to fetch at the end of its life. Usually nothing,
      // and never depreciated past.
      ['salvage_value', 'i', null, false, 0],
      // Straight line spreads the cost evenly, which is what management
      // accounts want. Reducing balance charges a share of what is left each
      // year, more early and less later, which is how tax authorities
      // generally want capital allowances worked out.
      ['method', 'e', ['straight_line', 'reducing_balance'], true, 'straight_line'],
      ['life_months', 'i', null, false, 48],
      ['rate_bp', 'i', null, false, 2000],
      // Which accounts this asset's own postings land on, so a restaurant that
      // wants vehicles kept apart from kitchen equipment can have that without
      // any of it being hard-coded.
      ['asset_account_code', 's', 10, false, '1500'],
      ['accum_account_code', 's', 10, false, '1510'],
      ['expense_account_code', 's', 10, false, '6060'],
      // Sold, scrapped or written off. Nothing is charged for the month it
      // went or afterwards.
      ['disposed_on', 'd', null, false],
      ['disposal_proceeds', 'i', null, false, 0],
      ['note', 's', 500, false],
      ['active', 'b', null, false, true],
    ],
    indexes: [['venue', 'key', ['venue_id']], ['acquired', 'key', ['acquired_on']]],
  },
  {
    /**
     * A bank or cash account, checked against what the bank says.
     *
     * The books say what the business believes it has. A statement says what
     * somebody else believes. Reconciling is the act of finding out which
     * postings the other side has seen — and the difference that will not go
     * away is where the missing transaction is.
     *
     * One row per statement checked. The lines ticked off live next door, one
     * row each, rather than as a list inside this one: a list in a text field
     * has a length limit, and the limit is reached on the night somebody is
     * doing a busy month.
     */
    id: 'bank_reconciliations',
    name: 'Reconciliations',
    perms: { read: MGMT, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, false],
      ['account_code', 's', 10, true],
      // The date the statement runs to, and what it says was there on that day.
      ['statement_date', 'd', null, true],
      ['closing_balance', 'i', null, true, 0],
      ['status', 'e', ['open', 'agreed'], true, 'open'],
      ['note', 's', 500, false],
      ['reconciled_by', 's', 64, false],
      ['reconciled_at', 'd', null, false],
    ],
    indexes: [['account', 'key', ['account_code', 'statement_date']]],
  },
  {
    /**
     * One posting the bank has also seen.
     *
     * Kept as its own row rather than a flag on the journal line, because a
     * line belongs to an entry and an entry is a fact about the business;
     * whether a bank has got round to processing it is a fact about the bank.
     * Mixing the two means every reconciliation rewrites the books.
     */
    id: 'reconciled_lines',
    name: 'Reconciled lines',
    perms: { read: MGMT, create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, false],
      ['rec_id', 's', 64, true],
      ['line_id', 's', 64, true],
      ['account_code', 's', 10, true],
    ],
    indexes: [
      ['rec', 'key', ['rec_id']],
      // One line cannot be ticked off twice, on one statement or across two.
      ['line_unique', 'unique', ['line_id']],
    ],
  },
  {
    /**
     * What a bank says happened, as its own record.
     *
     * Kept rather than matched and thrown away, because the useful question
     * afterwards is not "did it reconcile" but "which line did not, and what
     * did the bank call it". A line the books have nothing for is the reason
     * this exercise exists, and it needs somewhere to sit while somebody works
     * out what it was.
     */
    id: 'statement_lines',
    name: 'Statement lines',
    perms: { read: MGMT, create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, false],
      ['account_code', 's', 10, true],
      ['statement_date', 'd', null, false],
      ['line_date', 'd', null, true],
      ['description', 's', 300, false],
      // Signed: positive into the account, negative out of it. One column
      // rather than two, because a bank that exports two is normalised on the
      // way in and everything downstream then has one thing to reason about.
      ['amount', 'i', null, true, 0],
      // The posting this turned out to be, once somebody agreed it.
      ['matched_line_id', 's', 64, false],
      ['imported_at', 'd', null, false],
    ],
    indexes: [
      ['account_date', 'key', ['account_code', 'line_date']],
      ['matched', 'key', ['matched_line_id']],
    ],
  },
  {
    /**
     * A line drawn under the books, and who drew it.
     *
     * Once a month has been reported on — to an owner, an accountant, a tax
     * authority — anything posted into it afterwards changes a figure somebody
     * has already read and acted upon. That is not a bookkeeping nuisance; it
     * is the difference between accounts that can be relied on and accounts
     * that were true on the day they were printed.
     *
     * A row per act rather than a field that gets overwritten, so unlocking
     * leaves a trace. Somebody reopening January to change one number is
     * exactly the event worth being able to see afterwards, and a field would
     * simply forget it happened.
     */
    id: 'accounting_locks',
    name: 'Locked periods',
    // Nobody deletes a lock. Reopening a period is done by locking to an
    // earlier date, which is itself recorded.
    perms: { read: MGMT, create: ADMIN, update: [], delete: [] },
    attributes: [
      ['venue_id', 's', 64, false],
      // Everything on or before this day is closed. One date rather than a
      // pair, because periods are locked in order: there is no such thing as
      // an open January inside a closed February.
      ['locked_through', 'd', null, true],
      ['locked_by', 's', 64, true],
      ['locked_at', 'd', null, true],
      ['note', 's', 300, false],
    ],
    indexes: [['venue', 'key', ['venue_id', 'locked_at']]],
  },
  {
    id: 'journal_entries',
    name: 'Journal entries',
    /**
     * Created by whoever closes the shift, which may be the cook. Edited and
     * removed by an admin, and by nobody else.
     *
     * This was append-only, on the usual argument: a wrong entry is corrected
     * by posting its opposite, never by editing history, because books that
     * can be quietly edited are not books. That argument is sound and it is
     * why an auditor asks what a ledger USED to say.
     *
     * The owner asked for editing anyway, and for a business of this size the
     * trade is theirs to make: reversals double the length of a journal, and a
     * journal nobody can read is its own kind of unreliable. So the edit is
     * allowed and the history is kept elsewhere — every change writes the
     * previous version into the audit log, which this page cannot touch and
     * the erase page never clears. Quietly is the part that was worth
     * preventing, not editing.
     */
    perms: { read: MGMT, create: ALL_STAFF, update: ADMIN, delete: ADMIN },
    attributes: [
      ['date', 'd', null, true],
      ['source', 'e', ['shift_close', 'purchase', 'expense', 'refund', 'adjustment', 'reversal'], true],
      ['source_id', 's', 64, false],
      ['shift_id', 's', 64, false],
      ['memo', 's', 500, false],
      // The evidence, attached to the posting itself. A receipt in a drawer
      // proves nothing a year later, and one attached to an expense is only
      // reachable from the expense — a posting made by hand, which is exactly
      // the kind somebody will be asked to justify, had nowhere to put one.
      ['receipt_file_id', 's', 64, false],
      ['posted_by', 's', 64, true],
      // Two halves of the same fact, kept on both entries so it can be read
      // from either end: the original names what undid it, the reversal names
      // what it undid. An entry is never edited, so a correction is a second
      // entry and the pair has to be recognisable as a pair.
      ['reversed_by', 's', 64, false],
      ['reversal_of', 's', 64, false],
    ],
    indexes: [
      ['date', 'key', ['date']],
      ['shift', 'key', ['shift_id']],
      ['reversal', 'key', ['reversal_of']],
    ],
  },
  {
    id: 'journal_lines',
    name: 'Journal lines',
    // An edit replaces an entry's lines rather than patching them: the number
    // of lines changes, and matching old to new is guesswork. See the note on
    // journal_entries for why this is editable at all.
    perms: { read: MGMT, create: ALL_STAFF, update: ADMIN, delete: ADMIN },
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
      /**
       * May change what a LINE costs, at the till, before it is sent.
       *
       * Not the menu price — that stays where an admin set it, and a till that
       * could rewrite it would have one person's haggle follow every customer
       * for the rest of the week. This is the craft counter's real problem: a
       * piece with a chip in it, a maker's own price for a friend, a display
       * item going for less than a new one. The price on the shelf is a
       * starting point there in a way it never is for a plate of jollof.
       *
       * Off for everybody until an admin grants it, and every overridden line
       * carries what it should have cost so the difference can be read back.
       *
       * Optional, for the reason set out on menu_items: a field that arrives
       * after the rows do can never be required.
       */
      ['can_change_line_price', 'b', null, false, false],
      /**
       * May permanently delete something from the catalogue.
       *
       * Off for everybody, admins aside, and deliberately separate from being
       * allowed to EDIT the catalogue. A manager fixing a price and a manager
       * removing a dish are not the same act: one is reversible by typing the
       * old number back, and the other takes the item, its recipe and its
       * options with it. Archiving does the day-to-day job of getting
       * something off the board, and leaves all of that intact.
       *
       * Optional, for the reason set out on menu_items: a field that arrives
       * after the rows do can never be required.
       */
      ['can_delete_items', 'b', null, false, false],
      /**
       * May see the spending categories marked admin only.
       *
       * Rent, the owner's drawings, a legal bill — real spending that has to
       * be recorded and that the floor has no business reading off a
       * dropdown. Admins see them always; this is how an admin lets a
       * particular manager see them too, without making them an admin.
       *
       * Optional, and off by default: a field that arrives after the rows do
       * can never be required, and the safe answer for everybody already on
       * the staff list is no.
       */
      ['can_see_private_expenses', 'b', null, false, false],
      /*
        May put money into a petty cash box, take it out, or set one up.

        Separate from holding one, and that separation is the only real control
        in the imprest system: recording a top-up credits the till's cash and
        debits the box, so a custodian who could invent one could top their own
        box back up on paper and no count would ever find the shortage. Off for
        everybody until an owner hands it to somebody by name.
      */
      ['can_fund_petty_cash', 'b', null, false, false],
      ['can_record_waste', 'b', null, false, true],
      ['hourly_rate', 'i', null, false], // feature 4: labour cost
      // Getting somebody their first sign-in.
      //
      // An admin sets `requested`; the server notices, makes sure the account
      // and the team membership exist, and emails a link through the
      // restaurant's own mail provider, the one that already delivers
      // receipts, rather than Appwrite's shared sender, which is throttled and
      // lands in spam. `sent` is stamped afterwards so an ordinary edit to
      // somebody's phone number does not post them another one.
      /**
       * Which side of the business this person works on.
       *
       * A shop assistant has no reason to see a kitchen display or a list of
       * dishes, and a cook has none to see consignor payouts. 'both' is the
       * default because most small places genuinely are both, and guessing
       * wrong in that direction only shows somebody a page they ignore, 
       * guessing wrong the other way hides the work they came in to do.
       */
      /*
        The old single answer. Kept, and still read as a fallback.

        It cannot say "kitchen and bar but not the shop", which is an ordinary
        way to staff a place with three trades — and an enum cannot be widened
        into a combination without listing every one of them. See
        `works_in_modules`, which is what the app writes now.
      */
      ['works_in', 'e', ['both', 'kitchen', 'craft', 'bar'], false, 'both'],
      /**
       * The sides this person actually works on, any combination.
       *
       * A list rather than one choice, because "both" is a two-trade word in a
       * business running three. A bartender should see the bar and nothing
       * else; somebody who covers the bar and the bistro should see those two
       * and not the craft shop; and neither of those can be said with a single
       * value.
       *
       * Empty means every side the business runs, which is what an unanswered
       * question has always meant here and is the only safe reading for the
       * rows written before this existed.
       */
      ['works_in_modules', 's[]', 20, false],
      ['login_link_requested_at', 'd', null, false],
      ['login_link_sent_at', 'd', null, false],
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
  //  Every one of these is switched on or off by an admin, see FEATURES
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
      // a receipt row but not delete one, an audit trail the audited can
      // remove is not one, so a resend is a request rather than a deletion.
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
    // 12:00, capacity is checked and incremented server-side in one step, so
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
  /*
    WHAT AN OPENING-LEVELS UPLOAD SAID, KEPT.

    The upload sets a shelf to a figure. Until this existed, the figures
    themselves were gone the moment they were applied: the movements record how
    far each shelf MOVED, which is not the same as what the file said, and
    working one back from the other means knowing what every shelf held
    beforehand — which is precisely the thing that has since changed.

    So the upload is stored as it was read. An opening balance is a statement
    somebody made about a room on a day, and being able to put a bar back to
    the day it opened is worth one row per upload.
  */
  {
    id: 'stock_level_uploads',
    name: 'Opening level uploads',
    // Nobody updates one: an upload is a record of what was said rather than a
    // document to be edited. Restoring writes a NEW row, so the history reads
    // forwards and never has to be untangled backwards.
    perms: { read: MGMT, create: MGMT, update: [], delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, true],
      ['uploaded_at', 'd', null, true],
      ['uploaded_by', 's', 64, false],
      ['note', 's', 300, false],
      // JSON: [{ i: ingredientId, l: locationId, q: qty }]. Short keys because
      // the column is the limit and a hundred bottles across two rooms is two
      // hundred entries. See levelPayload.
      ['payload', 's', 20000, true],
      ['lines', 'i', null, true, 0],
      // Set when this upload was itself a restore of an earlier one.
      ['restored_from', 's', 64, false],
    ],
    indexes: [['venue_when', 'key', ['venue_id', 'uploaded_at']]],
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
      //    shifts running (default 3), the ones that need a decision
      ['new_stock_ids', 's[]', 64, false],
      ['persistent_stock_ids', 's[]', 64, false],
      ['delivery_status', 'e', ['queued', 'sent', 'partial', 'failed'], true, 'queued'],
      ['delivered_to', 's', 2000, false],
      ['last_error', 's', 500, false],
      ['sent_at', 'd', null, false],
      /*
        What the mail server said when it took the message.

        Its own reference and its reply, kept because "sent" and "arrived" are
        two different facts and this row could only ever report the first. A
        report that the provider accepted and then dropped — an unverified
        sender, a bounce, a spam filter — looked identical here to one sitting
        in somebody's inbox, and there was nothing to search the provider's
        own records with.
      */
      ['provider_ref', 's', 200, false],
      ['provider_reply', 's', 300, false],
    ],
    indexes: [
      ['venue_kind_created', 'key', ['venue_id', 'kind', '$createdAt']],
      ['shift', 'key', ['shift_id']],
    ],
  },

  /* ------------------------------------------- purchases worth a second look */
  {
    /**
     * A purchase that looked dear, or larger than usual, when it was recorded.
     *
     * Written at the moment somebody was asked to check it, whatever they then
     * answered. That is the point: the question is asked and got out of the
     * way of, and the fact that it was asked survives. A prompt nobody records
     * is a prompt that teaches nothing — the same wrong price gets typed every
     * month and no report can say so.
     *
     * These are questions, not accusations. Prices genuinely triple, and a bulk
     * buy before a function is not a mistake. What makes the list worth reading
     * is that somebody can tick off the ones that were fine and be left with
     * the ones that were not.
     */
    id: 'purchase_alerts',
    name: 'Purchase alerts',
    // Anybody may raise one, because anybody may record a spend, and the alert
    // is written by the same act. Ticking one off is management's: "that was
    // fine" is a judgement about somebody else's purchase.
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, true],
      ['ingredient_id', 's', 64, false],
      // The name as it was, so an alert still reads after somebody renames or
      // archives the ingredient behind it.
      ['ingredient_name', 's', 160, true],
      ['unit', 's', 20, false],
      ['expense_id', 's', 64, false],
      ['kind', 'e', ['price', 'qty'], true, 'price'],
      // What was paid or bought, and what this normally goes for. Both stored:
      // the typical figure moves as more is bought, and an alert that
      // recomputed it would stop describing the moment it was raised.
      ['value', 'i', null, true, 0],
      ['typical', 'i', null, true, 0],
      ['rise_bp', 'i', null, true, 0],
      // How many past purchases the typical figure rested on.
      ['seen', 'i', null, true, 0],
      ['module', 'e', ['kitchen', 'craft', 'bar'], false, 'kitchen'],
      ['created_by', 's', 64, true],
      // Whether somebody has looked and decided. Absent is outstanding, which
      // is what every row written before this could be ticked really is.
      ['acknowledged', 'b', null, false, false],
      ['acknowledged_by', 's', 64, false],
      ['acknowledged_at', 'd', null, false],
      ['note', 's', 500, false],
    ],
    indexes: [
      ['venue_created', 'key', ['venue_id', '$createdAt']],
      ['outstanding', 'key', ['acknowledged', '$createdAt']],
      ['ingredient', 'key', ['ingredient_id']],
    ],
  },

  /* ------------------------------------------------------ petty cash boxes */
  {
    /**
     * A petty cash box, run on the imprest system.
     *
     * Set at a fixed amount, spent against receipts, topped back up by exactly
     * what was spent. The fixed amount is what makes the box checkable: cash
     * in the box plus receipts held should always come to it, so a shortage
     * shows up at the next count rather than being noticed by somebody who
     * happens to remember what was in there.
     */
    id: 'imprest_floats',
    name: 'Petty cash boxes',
    // Read by anybody who might be sent to the market with it; changed by
    // management only. What a box is SET at is a decision about how much cash
    // the business is prepared to have walking around, which is not a
    // cashier's to make.
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, true],
      ['name', 's', 120, true],
      // What it holds when full, in minor units.
      ['fixed_amount', 'i', null, true, 0],
      // Where it sits on the balance sheet. Its own account by default; a
      // business running several boxes can point each at one of its own.
      ['account_code', 's', 20, false],
      // Whose box it is. A box with nobody's name on it is a box nobody counts.
      ['custodian_id', 's', 64, false],
      // Which side of the business it serves. Blank serves all of them.
      ['module', 'e', ['kitchen', 'craft', 'bar'], false],
      ['note', 's', 500, false],
      ['active', 'b', null, true, true],
      ['sort', 'i', null, true, 0],
    ],
    indexes: [['venue_active', 'key', ['venue_id', 'active']]],
  },
  {
    /**
     * Every change in what a box holds.
     *
     * The balance is the sum of these and is never stored anywhere. A running
     * total kept as a field drifts the first time a write half fails, and once
     * it has drifted nothing in the system can say so. Summed from the
     * movements it cannot be wrong, only incomplete — and incomplete is
     * visible.
     */
    id: 'imprest_movements',
    name: 'Petty cash movements',
    // Created by anybody who can spend from a box. Never updated: a movement
    // is a statement that money moved, and correcting one is done by recording
    // the movement that puts it back.
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, true],
      ['float_id', 's', 64, true],
      // Signed minor units: positive into the box, negative out of it. One
      // signed figure rather than a pair of columns, so the balance is a sum
      // and cannot be got wrong by reading the wrong one.
      ['amount', 'i', null, true, 0],
      ['kind', 'e', ['top_up', 'spend', 'adjust', 'return'], true, 'spend'],
      // What it was: an expense, a count, a hand-back to the safe.
      ['ref_type', 's', 40, false],
      ['ref_id', 's', 64, false],
      // The journal entry this movement posted, so the box and the books can
      // be walked from either end.
      ['entry_id', 's', 64, false],
      ['note', 's', 500, false],
      ['created_by', 's', 64, true],
      // When the money actually moved, which is not always when it was typed.
      ['occurred_at', 'd', null, false],
    ],
    indexes: [
      ['float_created', 'key', ['float_id', '$createdAt']],
      ['ref', 'key', ['ref_type', 'ref_id']],
    ],
  },
  {
    /**
     * A count of what is actually in a box.
     *
     * Kept even when it balances, which is the point of it. "We counted it and
     * it was right" is a fact worth being able to show, and a record that only
     * exists when something was wrong makes every entry in it look like an
     * accusation.
     */
    id: 'imprest_counts',
    name: 'Petty cash counts',
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, true],
      ['float_id', 's', 64, true],
      // What the movements said, and what was in the tin.
      ['expected', 'i', null, true, 0],
      ['counted', 'i', null, true, 0],
      ['variance', 'i', null, true, 0],
      ['counted_by', 's', 64, true],
      ['counted_at', 'd', null, false],
      /**
       * Where this count's window starts: the previous count's moment.
       *
       * A count is a line drawn under everything that had happened up to it,
       * and this is the other end of that line. Held as a timestamp rather
       * than stamped onto every movement it covers — a movement is a statement
       * that money moved, nothing about it changes when somebody counts, and
       * writing to forty rows to record a fact about one is forty chances to
       * half finish the job.
       *
       * Blank on the first count, which sweeps up everything the box has ever
       * done including the top-up that opened it.
       */
      ['covers_from', 'd', null, false],
      ['note', 's', 500, false],
      // What was put back in to restore the box, if anything was, at the same
      // sitting. Zero when the count was only a count.
      ['topped_up', 'i', null, true, 0],
    ],
    indexes: [['float_created', 'key', ['float_id', '$createdAt']]],
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
    // Every application, including ones later reversed; this is the audit
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

  {
    /**
     * What a member of staff handed over at the end of their time on the till.
     *
     * A shift is not a person. Three people can work one shift, take money in
     * turn out of the same drawer, and leave at different times, and the shift
     * close, which happens once, cannot say who left what. So the answer to
     * "what did Ama end with?" was nowhere in the system, and the only record
     * was whatever the manager wrote on a pad.
     *
     * This is that record. Written by the person handing over, naming who took
     * it, so both halves of the exchange are on file rather than one.
     *
     * Staff can create but never edit or delete: a handover somebody can
     * quietly revise afterwards is not evidence of anything. A wrong one is
     * corrected by a second entry, which leaves both on the record, which is
     * the point.
     */
    id: 'cash_handovers',
    name: 'Cash handovers',
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, false],
      ['shift_id', 's', 64, false],
      ['staff_id', 's', 64, true], // whose money this was
      ['staff_name', 's', 120, false], // snapshotted, so a leaver still reads
      ['amount', 'i', null, true],
      ['method_id', 's', 64, false], // which drawer or wallet it came from
      ['method_name', 's', 60, false],
      [
        'destination',
        'e',
        ['manager', 'safe', 'next_shift', 'bank', 'owner', 'other'],
        true,
        'manager',
      ],
      ['received_by', 's', 64, false], // the staff profile who took it
      ['received_by_name', 's', 120, false],
      ['note', 's', 300, false],
      ['handed_at', 'd', null, true],
      // A correction points at what it corrects, so the pair can be read
      // together rather than looking like two handovers.
      ['corrects_id', 's', 64, false],
      ['status', 'e', ['recorded', 'corrected'], true, 'recorded'],
    ],
    indexes: [
      ['shift_staff', 'key', ['shift_id', 'staff_id']],
      ['staff_handed', 'key', ['staff_id', 'handed_at']],
      ['handed', 'key', ['handed_at']],
    ],
  },

  // ------------------------------------------------------------ consignment
  //
  // The craft-shop side of the system. A consignment shop does not own what it
  // sells: somebody brings goods in, the shop sells them, keeps a share and
  // owes the rest. That "owes the rest" is the whole business, and it is the
  // part a spreadsheet gets wrong first, which is why it is a ledger here
  // rather than a running total on a row somebody can edit.
  //
  // These collections sit alongside the restaurant ones rather than replacing
  // them. The spine is the same: products, sales, payments, shifts, staff,
  // receipts. Only the ownership of the goods and the money that follows a sale
  // are different, so only those are new.
  {
    /**
     * Somebody who leaves goods with the shop to be sold on their behalf.
     *
     * `commission_bp` is theirs and theirs alone. A shop that has one rate for
     * everybody still wants it here rather than in settings, because the day it
     * negotiates a different rate with one maker, and it will, a global
     * number silently rewrites the past for everyone.
     */
    id: 'consignors',
    name: 'Consignors',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, false],
      ['code', 's', 24, true], // short, human, goes on labels: "AKO", "MB2"
      ['name', 's', 160, true],
      ['phone', 's', 40, false],
      ['email', 's', 160, false],
      ['address', 's', 300, false],
      // What the shop keeps, in basis points. 3000 = 30%.
      ['commission_bp', 'i', null, true, 3000],
      // Or a flat amount per piece, when that is the agreement. Zero means the
      // percentage above applies; anything above zero wins over it.
      ['commission_flat', 'i', null, false, 0],
      ['payout_method', 'e', ['cash', 'momo', 'bank', 'other'], false, 'momo'],
      ['payout_details', 's', 200, false], // momo number, account, whatever
      ['agreement_start', 'd', null, false],
      ['agreement_end', 'd', null, false],
      ['notes', 's', 1000, false],
      ['active', 'b', null, true, true],
    ],
    indexes: [
      ['code_unique', 'unique', ['code']],
      ['active_name', 'key', ['active', 'name']],
    ],
  },
  {
    /**
     * One delivery of goods from one consignor, on one day.
     *
     * Goods arrive in batches and a batch is what both sides remember: "the
     * baskets I brought in March". Without it, a consignor asking what happened
     * to that delivery can only be answered item by item.
     */
    id: 'consignment_intakes',
    name: 'Consignment intakes',
    perms: { read: ALL_STAFF, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, false],
      ['consignor_id', 's', 64, true],
      ['reference', 's', 40, true], // INT-0007
      ['received_at', 'd', null, true],
      ['received_by', 's', 64, false],
      ['piece_count', 'i', null, true, 0],
      ['total_retail', 'i', null, true, 0], // what it would all sell for
      // The consignor's share of that, worked out at the rate agreed on the
      // day it arrived. Snapshotted rather than recomputed, because a rate
      // changed next year must not rewrite what a delivery was worth.
      ['total_due', 'i', null, false, 0],
      ['notes', 's', 1000, false],
      ['status', 'e', ['open', 'closed'], true, 'open'],
    ],
    indexes: [
      ['reference_unique', 'unique', ['reference']],
      ['consignor_received', 'key', ['consignor_id', 'received_at']],
    ],
  },
  {
    /**
     * A size, colour or finish of a product that carries its own price.
     *
     * A basket in small, medium and large is one product to a customer and
     * three prices to a till. Modelled as rows rather than as a JSON blob on
     * the product because each one is counted, sold and paid out separately, 
     * anything a stock movement or a sale line points at has to have an id.
     */
    id: 'product_variants',
    name: 'Product variants',
    // Update is management, not all staff. A variant carries a price, and a
    // price anybody can change is a price customers get charged wrongly. It
    // matches the restriction on the catalogue itself.
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: MGMT },
    attributes: [
      ['venue_id', 's', 64, false],
      ['menu_item_id', 's', 64, true],
      ['label', 's', 60, true], // "Large", "40cm", "Indigo"
      // The original fixed four. Kept because an enum cannot be widened in
      // place without dropping the column and its data, so `kind_key` is what
      // the app reads and writes now and this only has to stay valid.
      ['kind', 'e', ['size', 'colour', 'finish', 'other'], true, 'size'],
      // What the shop calls this kind of variation, pointing at a row the shop
      // created in `variant_types`. A pottery studio sells by glaze, a weaver
      // by width, and neither is a "size".
      ['kind_key', 's', 40, false],
      ['price', 'i', null, true, 0],
      ['sku', 's', 40, false],
      ['barcode', 's', 60, false],
      // Optional, not required. A required attribute has to appear in every
      // write even though it carries a default, and the first form that
      // forgot it failed with "Missing required attribute on_hand" rather
      // than quietly using the zero it already had.
      ['on_hand', 'i', null, false, 0],
      ['sort', 'i', null, true, 0],
      ['active', 'b', null, true, true],
    ],
    indexes: [
      ['item_sort', 'key', ['menu_item_id', 'sort']],
      ['sku', 'key', ['sku']],
      ['barcode', 'key', ['barcode']],
    ],
  },
  {
    /**
     * The kinds of variation a shop's products come in.
     *
     * Shipped as size, colour and finish because most shops need at least one
     * of them, and editable because most shops need something else as well. A
     * pottery studio sells by glaze, a weaver by width, a framer by mount.
     * Hard-coding four words was deciding what somebody's stock is on their
     * behalf.
     */
    id: 'variant_types',
    name: 'Variant types',
    perms: { read: ['any'], create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['key', 's', 40, true],
      ['name', 's', 60, true],
      // What one of these is called on its own, for the label above a dropdown:
      // "Size" as a group, "size" when asking which one.
      ['singular', 's', 60, false],
      ['sort', 'i', null, true, 0],
      ['active', 'b', null, true, true],
      // Whose sizes these are. A bar measures in singles and doubles, a shop
      // in small, medium and large; one list holding both is a list where
      // neither side can find its own. Absent means the shop's, which is what
      // every type written before this one existed was.
      ['module', 'e', ['kitchen', 'craft', 'bar'], false, 'craft'],
    ],
    indexes: [['key_unique', 'unique', ['key']], ['sort', 'key', ['sort']]],
  },
  {
    /**
     * Every movement of a saleable piece, and why.
     *
     * The count on a product is a convenience; this is the record. A shop that
     * only keeps the count can tell you it has three left and never why it used
     * to have five, and "why" is the entire conversation when a consignor asks
     * about a piece that is neither on the shelf nor on a statement.
     */
    id: 'product_moves',
    name: 'Product movements',
    perms: { read: ALL_STAFF, create: ALL_STAFF, update: [], delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, false],
      ['menu_item_id', 's', 64, true],
      ['variant_id', 's', 64, false],
      ['consignor_id', 's', 64, false],
      [
        'type',
        'e',
        ['intake', 'sale', 'return_to_consignor', 'damaged', 'lost', 'adjustment', 'refund'],
        true,
      ],
      ['qty_delta', 'i', null, true], // negative for anything leaving
      ['unit_price', 'i', null, true, 0],
      ['ref_type', 's', 40, false], // 'order', 'intake', 'payout'
      ['ref_id', 's', 64, false],
      ['shift_id', 's', 64, false],
      ['note', 's', 300, false],
      ['created_by', 's', 64, false],
    ],
    indexes: [
      ['item_created', 'key', ['menu_item_id', '$createdAt']],
      ['consignor_created', 'key', ['consignor_id', '$createdAt']],
      ['type_created', 'key', ['type', '$createdAt']],
      ['ref', 'key', ['ref_type', 'ref_id']],
    ],
  },
  {
    /**
     * What the shop owes a consignor, one line at a time.
     *
     * A ledger, not a balance. Every sale credits, every payout debits, and the
     * balance is the sum, so it can always be explained line by line, and no
     * single wrong edit can quietly change what somebody is owed. The
     * alternative, a running total on the consignor row, is the design that
     * loses an argument with a maker holding their own notebook.
     *
     * Written by the server when a sale settles. Staff cannot create these:
     * a credit somebody can type is not a record of anything.
     */
    id: 'consignor_ledger',
    name: 'Consignor ledger',
    perms: { read: MGMT, create: [], update: [], delete: [] },
    attributes: [
      ['venue_id', 's', 64, false],
      ['consignor_id', 's', 64, true],
      ['entry_at', 'd', null, true],
      ['kind', 'e', ['sale', 'refund', 'payout', 'adjustment', 'fee'], true],
      // Positive increases what the shop owes; negative reduces it.
      ['amount', 'i', null, true],
      ['description', 's', 300, false],
      // The sale behind a credit, so a statement line can be traced to a till.
      ['order_id', 's', 64, false],
      ['order_item_id', 's', 64, false],
      ['menu_item_id', 's', 64, false],
      ['variant_label', 's', 60, false],
      ['qty', 'i', null, false, 1],
      ['gross', 'i', null, false, 0], // what the customer paid
      ['commission', 'i', null, false, 0], // what the shop kept
      ['commission_bp', 'i', null, false, 0], // the rate used, snapshotted
      ['commission_flat', 'i', null, false, 0], // or the flat amount, if that
      ['payout_id', 's', 64, false],
      ['created_by', 's', 64, false],
    ],
    indexes: [
      ['consignor_entry', 'key', ['consignor_id', 'entry_at']],
      ['order_item_unique', 'unique', ['order_item_id']],
      ['payout', 'key', ['payout_id']],
      ['kind_entry', 'key', ['kind', 'entry_at']],
    ],
  },
  {
    /**
     * Money actually handed over to a consignor.
     *
     * Recorded, never moved, the same rule the rest of the system follows. The
     * shop pays by momo or cash and writes down that it did; nothing here
     * touches anybody's money.
     */
    id: 'consignor_payouts',
    name: 'Consignor payouts',
    perms: { read: MGMT, create: MGMT, update: MGMT, delete: ADMIN },
    attributes: [
      ['venue_id', 's', 64, false],
      ['consignor_id', 's', 64, true],
      ['reference', 's', 40, true], // PAY-0012
      ['paid_at', 'd', null, true],
      ['amount', 'i', null, true],
      ['method', 'e', ['cash', 'momo', 'bank', 'other'], true, 'momo'],
      ['transaction_ref', 's', 120, false],
      // The window this settles, so a statement can say what it covers.
      ['period_start', 'd', null, false],
      ['period_end', 'd', null, false],
      ['note', 's', 500, false],
      ['status', 'e', ['recorded', 'reversed'], true, 'recorded'],
      ['reversed_reason', 's', 300, false],
      ['paid_by', 's', 64, false],
    ],
    indexes: [
      ['reference_unique', 'unique', ['reference']],
      ['consignor_paid', 'key', ['consignor_id', 'paid_at']],
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
 * not name the offending field, so catch it here instead.
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
// These attributes are all optional, so "unset" already means blank, an empty
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
 * Everything operational is SEPARATE per venue, staff, shifts, cash, stock,
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

/**
 * One database, many hotels.
 *
 * `org_id` goes on every collection without exception, not on a list of the
 * ones that seemed to need it. A list is a thing somebody forgets to add to,
 * and the collection left off it is the one that shows one hotel's figures to
 * another. There is no collection here whose rows are not owned by somebody.
 *
 * The field is deliberately NOT required. Every row that already exists
 * predates it, and making it required would refuse to save a single one of
 * them until the migration had finished, turning a careful, resumable
 * backfill into an outage. `scripts/migrate-org.mjs` stamps them; the apps
 * treat a blank as belonging to the first organisation.
 *
 * It is also not the real defence. Appwrite document permissions are: every row
 * is written readable only by its own organisation's team, so a query that
 * forgets to filter returns nothing rather than somebody else's takings. The
 * field is what makes the queries efficient and the migration checkable.
 */
export const ORG_EXEMPT = ['organisations', 'org_requests'];

for (const col of COLLECTIONS) {
  if (ORG_EXEMPT.includes(col.id)) continue;
  col.attributes.unshift(['org_id', 's', 64, false]);
  col.indexes = col.indexes || [];
  col.indexes.push(['org', 'key', ['org_id']]);
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
      // switched off on its own, a sit-down restaurant where the waiter is
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
      // Pickup points are rows in `pickup_points`, as many per venue as you
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
      closed_message: "We're closed right now, order ahead and pick a time.",
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
      //
      // Cooking has no cushion at all: past the time allowed for the order is
      // late, full stop. This figure now covers only food already cooked and
      // waiting to be collected, where somebody still has to walk over and
      // fetch it. See isOverdue in packages/core/src/orders-time.ts.
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
      message_to_guest: 'The kitchen is very busy, your order may take a little longer.',
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
      // A separate menu for parties, platters and set meals rather than the
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

/**
 * The accounts the system posts to by number when a shift closes.
 *
 * Mirrors ACCOUNTS in packages/core/src/ledger.ts. Kept as plain strings here
 * because the provisioning script cannot import TypeScript, and checked by
 * scripts/check-writes.mjs so the two cannot drift apart unnoticed.
 */
export const SYSTEM_ACCOUNT_CODES = [
  '1000', '1010', '1020', '1200', '2100', '2200', '4000', '4900', '5000', '7000',
  // A petty cash box credits this when it spends and debits it when it is
  // topped up. Deleting it would not produce an error message; it would
  // produce a box that cannot record what it paid for.
  '1030',
  // One sales and one cost-of-sales account per side of the business. A shift
  // knows which side it belongs to, so the split happens as the entry is
  // written rather than being guessed at afterwards from a merged figure.
  '4010', '4020', '5010', '5020',
  // And one stock account per trade, so what a side owns and what it has sold
  // move together instead of one shared figure hiding whichever is drifting.
  '1210', '1220',
  // Depreciation posts to these three by number, the same way a shift close
  // posts to the ten above, so they cannot be deleted either.
  '1500', '1510', '6060',
];

export const SEED_ACCOUNTS = [
  ['1000', 'Cash on hand', 'asset'],
  ['1010', 'Card clearing', 'asset'],
  ['1020', 'Mobile money clearing', 'asset'],
  /*
    Money that has left the safe but has not yet been spent.

    Its own asset account, not part of Cash on hand. A petty cash box is
    somebody else's responsibility and is counted on its own schedule, and
    folding it into the till's cash means a shortage in the box and a shortage
    in the drawer are the same number on the balance sheet — which is to say
    neither of them can be found.
  */
  ['1030', 'Petty cash (imprest)', 'asset'],
  ['1200', 'Inventory - kitchen', 'asset'],
  ['1210', 'Inventory - bar', 'asset'],
  ['1220', 'Inventory - craft shop', 'asset'],
  ['1500', 'Equipment and fittings', 'asset'],
  // A contra-asset: it is an asset account that is normally held the other way
  // round, so it shows as a negative on the balance sheet and reduces what the
  // equipment above is carried at. Kept as its own account rather than
  // subtracted from the cost, because "what it cost" and "how much of it has
  // been used up" are both worth being able to read.
  ['1510', 'Less: accumulated depreciation', 'asset'],
  ['2100', 'Tax payable', 'liability'],
  ['2200', 'Tips payable', 'liability'],
  ['2300', 'Accounts payable', 'liability'],
  ['3000', 'Owner equity', 'equity'],
  ['4000', 'Restaurant sales', 'revenue'],
  ['4010', 'Bar sales', 'revenue'],
  ['4020', 'Craft shop sales', 'revenue'],
  ['4900', 'Discounts given', 'revenue'],
  ['5000', 'Cost of food sold', 'expense'],
  ['5010', 'Cost of drinks sold', 'expense'],
  ['5020', 'Cost of craft goods sold', 'expense'],
  ['6000', 'Supplies', 'expense'],
  ['6010', 'Transport', 'expense'],
  ['6020', 'Utilities', 'expense'],
  ['6030', 'Repairs & maintenance', 'expense'],
  ['6040', 'Staff advances', 'expense'],
  ['6050', 'Petty cash', 'expense'],
  ['6060', 'Depreciation', 'expense'],
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
  /*
    Buying stock is not spending, so these point at the balance sheet rather
    than at an expense account. The money turns into something the business
    still has; it becomes a cost when the drink is poured, not when the bottle
    is carried in.
  */
  { key: 'bar_stock', name: 'Bar stock', account_code: '1210', module: 'bar', sort: 8 },
  { key: 'craft_stock', name: 'Craft stock', account_code: '1220', module: 'craft', sort: 9 },
  { key: 'kitchen_stock', name: 'Kitchen stock', account_code: '1200', module: 'kitchen', sort: 10 },
  { key: 'transport', name: 'Transport', account_code: '6010', sort: 2 },
  { key: 'utilities', name: 'Utilities', account_code: '6020', sort: 3 },
  { key: 'repairs', name: 'Repairs & maintenance', account_code: '6030', sort: 4 },
  { key: 'staff_advance', name: 'Staff advances', account_code: '6040', sort: 5 },
  { key: 'petty_cash', name: 'Petty cash', account_code: '6050', sort: 6 },
  { key: 'other', name: 'Other', account_code: '6090', sort: 7 },
];

/** Ingredient groupings to start from. Rename or delete any of them. */
/**
 * The kinds of variation a shop starts with.
 *
 * Three, not four: "other" was in the original list and is what somebody picks
 * when the list is wrong. The answer to that is to let them add the word they
 * actually want, which is the whole point of this being a list they own.
 */
/**
 * The ways a bar and a kitchen buy things, to start from.
 *
 * Crates appear twice on purpose: twelve and twenty-four are both normal, they
 * are not the same pack, and giving each its own entry means nobody has to
 * remember which supplier sends which. A house that buys only one kind can
 * archive the other.
 */
export const SEED_PACK_KINDS = [
  { key: 'bottle', name: 'Bottle', units: 0, sort: 1 },
  { key: 'crate_12', name: 'Crate of 12', units: 12, sort: 2 },
  { key: 'crate_24', name: 'Crate of 24', units: 24, sort: 3 },
  { key: 'case', name: 'Case', units: 0, sort: 4 },
  { key: 'pack', name: 'Pack', units: 0, sort: 5 },
  { key: 'sack', name: 'Sack', units: 0, sort: 6 },
];

export const SEED_VARIANT_TYPES = [
  { key: 'size', name: 'Sizes', singular: 'size', sort: 0 },
  { key: 'colour', name: 'Colours', singular: 'colour', sort: 1 },
  { key: 'finish', name: 'Finishes', singular: 'finish', sort: 2 },
];

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
