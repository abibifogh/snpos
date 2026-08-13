/** Shapes mirroring the collections created by scripts/schema.mjs. */

export interface Doc {
  $id: string;
  $createdAt: string;
  $updatedAt: string;
}

export interface Settings extends Doc {
  restaurant_name: string;
  timezone: string;
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
  /** Which screens ask for a tip. `tips_enabled: false` overrides all of them. */
  tips_ask_on?: 'both' | 'till' | 'kitchen' | 'none';
  /** How the shift-end check asks: tap a level, or type what is there. */
  stock_check_mode?: 'levels' | 'counts';
  /** Whether a counted amount may be a part, 0.5, 0.25, or whole only. */
  stock_count_decimals?: boolean;
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
  /** Kitchen or craft. Decides which catalogue screen manages it. */
  module?: 'kitchen' | 'craft';
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
  module?: 'kitchen' | 'craft';
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
  can_mark_paid?: boolean;
  can_apply_discount_codes?: boolean;
  pin_hash?: string;
  pin_set_at?: string;
  can_record_waste?: boolean;
  hourly_rate?: number;
  email?: string;
  venue_ids?: string[];
  /** Which side of the business they work on. Absent means both. */
  works_in?: 'both' | 'kitchen' | 'craft';
  login_link_requested_at?: string;
  login_link_sent_at?: string;
}
