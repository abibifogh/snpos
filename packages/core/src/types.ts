/** Shapes mirroring the collections created by scripts/schema.mjs. */

// Type-only, and erased at compile time, so the pair importing each other's
// types costs nothing at runtime and keeps `Module` defined once.
import type { Module } from './access';

export interface Doc {
  $id: string;
  $createdAt: string;
  $updatedAt: string;
}

export interface Settings extends Doc {
  restaurant_name: string;
  timezone: string;
  /** Minutes of quiet before a till shows the clock. 0 or absent is off. */
  idle_minutes?: number;
  /** Margin below which an item is flagged, in basis points. Absent is 30%. */
  margin_warn_bp?: number;
  currency_code: string;
  currency_symbol: string;
  currency_decimals: number;
  symbol_position: 'before' | 'after';
  primary_color: string;
  secondary_color: string;
  accent_color?: string;
  logo_light_id?: string;
  logo_dark_id?: string;
  tax_rate_bp: number;
  tax_inclusive: boolean;
  service_charge_bp: number;
  shift_float_policy: 'zero' | 'carry_over' | 'fixed' | 'prompt';
  allow_negative_cash?: boolean;
  shift_float_default: number;
  kitchen_ack_sla_seconds: number;
  kitchen_ping_max_level: number;
  require_reject_reason: boolean;
  qr_orders_need_approval: boolean;
  order_number_prefix?: string;
  order_number_mode?: 'continuous' | 'daily';
  order_number_next?: number;
  order_number_padding?: number;
  order_number_reset_on?: string;
  tips_enabled?: boolean;
  low_stock_default_bp: number;
  /** Account codes counted as Costs. Empty or absent means all of them. */
  cost_account_codes?: string;
  /** Whether this business runs a bar alongside the kitchen and the shop. */
  bar_enabled?: boolean;
  /** Which screens ask for a tip. `tips_enabled: false` overrides all of them. */
  tips_ask_on?: 'both' | 'till' | 'kitchen' | 'none';
  /** How the shift-end check asks: tap a level, or type what is there. */
  stock_check_mode?: 'levels' | 'counts';
  /** Whether a counted amount may be a part, 0.5, 0.25, or whole only. */
  stock_count_decimals?: boolean;
  /**
   * Whether the bar's shift count may be left unfinished.
   *
   * Absent or false means it may not: the bar is counted in when a shift opens
   * and counted out when it closes, and there is no way past either. An admin
   * turns this on for a bar that genuinely cannot manage it every time.
   */
  bar_count_skippable?: boolean;
  /**
   * Whether whoever holds a petty cash box may count it themselves.
   *
   * Off unless set. A count is the check ON the custodian, and it catches
   * nothing when the person answerable for the money is the one answering it.
   * See canCountBox — there are real places with nobody else to do it, which
   * is why this exists at all.
   */
  imprest_custodian_counts?: boolean;
  /** What a shift expense may be paid out of. Cash only, or any method. */
  expense_paid_from?: 'cash_only' | 'any';
  /** Older setups said what they were. Read only as a fallback, see modulesOf. */
  business_type?: 'restaurant' | 'craft_shop';
  /** Which trades this business runs. Any combination except neither. */
  kitchen_enabled?: boolean;
  craft_enabled?: boolean;
  /** Whether customers may scan a code and order for themselves. */
  self_order_enabled?: boolean;
  /** What the shop keeps by default, in basis points. */
  default_commission_bp?: number;
  /** What a craft sale's number starts with. Blank uses the kitchen's. */
  craft_order_prefix?: string;
  cash_variance_tolerance: number;
  terminal_idle_lock_seconds: number;
  default_locale?: string;
  enabled_locales?: string[];
  email_from_name?: string;
  email_from_address?: string;
  role_access?: string;
  daily_report_hour?: number;
  storage_mode?: 'multi' | 'single';
  shared_bucket_id?: string;
}

export interface Venue extends Doc {
  name: string;
  slug: string;
  address?: string;
  phone?: string;
  timezone: string;
  active: boolean;
  sort: number;
  primary_color?: string;
  secondary_color?: string;
  opening_hours?: string;
  holiday_closures?: string;
  walkin_token?: string;
  group_token?: string;
  /** A screen that stays put and serves one customer after another. */
  screen_token?: string;
  order_number_prefix?: string;
}

/**
 * The four stations the system shipped with, kept only so that existing rows
 * still validate. What the kitchen actually uses is `station_key`, pointing at
 * a row the restaurant created in `stations`.
 */
export type Station = 'hot' | 'cold' | 'bar' | 'dessert';

/** A station as the restaurant defined it. */
export interface StationDoc extends Doc {
  venue_id: string;
  key: string;
  name: string;
  colour?: string;
  sort: number;
  active: boolean;
}

export interface Category extends Doc {
  name: string;
  description?: string;
  sort: number;
  image_id?: string;
  active: boolean;
  availability?: string;
  unavailable_display: 'grey' | 'hide';
  group_only?: boolean;
  /**
   * A colour for the till chip, where this category has no picture.
   *
   * Blank means the plain chip it has always had. See category-colour.ts: a
   * picture wins over a colour, and neither is invented.
   */
  colour?: string;
  /** Kitchen or craft. Decides which catalogue screen manages it. */
  module?: Module;
  station: Station;
  station_key?: string;
}

export interface MenuItem extends Doc {
  category_id: string;
  name: string;
  description?: string;
  price: number;
  image_id?: string;
  image_focal_x: number;
  image_focal_y: number;
  sku?: string;
  active: boolean;
  availability?: string;
  sold_out_until?: string;
  prep_minutes: number;
  unavailable_since?: string;
  unavailable_by?: string;
  unavailable_reason?: string;
  group_only?: boolean;
  station: Station | 'inherit';
  station_key?: string;
  tags?: string[];
  sort: number;
  track_stock: boolean;
  /** Kitchen or craft. Set from the category it was created under. */
  module?: Module;
  // ------------------------------------------------------------- craft shop
  // Blank on every restaurant row, and nothing reads them there.
  consignor_id?: string;
  intake_id?: string;
  commission_bp?: number;
  /** A flat per-piece commission. Above zero it wins over the percentage. */
  commission_flat?: number;
  barcode?: string;
  on_hand?: number;
  is_one_off?: boolean;
  maker_note?: string;
}

export interface FeatureFlag extends Doc {
  key: string;
  venue_id?: string;
  enabled: boolean;
  config?: string;
}

export interface StaffProfile extends Doc {
  user_id?: string;
  display_name: string;
  role: 'cook' | 'waiter' | 'cashier' | 'manager' | 'admin';
  active: boolean;
  phone?: string;
  can_open_shift: boolean;
  can_close_shift: boolean;
  can_void: boolean;
  can_discount_up_to_bp: number;
  /** May change what a LINE costs at the till. Never the menu price itself. */
  can_change_line_price?: boolean;
  /** May permanently delete catalogue rows. Admins always may. */
  can_delete_items?: boolean;
  /** May see the spending categories marked admin only. Admins always may. */
  can_see_private_expenses?: boolean;
  /**
   * May put money into a petty cash box, take it out, or set one up.
   *
   * Separate from HOLDING one, which is the only real control the imprest
   * system has. See canFundBoxes.
   */
  can_fund_petty_cash?: boolean;
  can_mark_paid?: boolean;
  can_apply_discount_codes?: boolean;
  pin_hash?: string;
  pin_set_at?: string;
  can_record_waste?: boolean;
  hourly_rate?: number;
  email?: string;
  venue_ids?: string[];
  /**
   * The old single answer, kept as a fallback for rows written before the
   * list below existed. It cannot express a combination; `works_in_modules`
   * is what the app writes now.
   */
  works_in?: 'both' | Module;
  /**
   * Which sides of the business they work on. Empty or absent means all of
   * them, which is what an unanswered question has always meant here.
   */
  works_in_modules?: Module[];
  login_link_requested_at?: string;
  login_link_sent_at?: string;
}
