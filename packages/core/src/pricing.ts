import type { Settings } from './types';

/**
 * Order maths, in one place.
 *
 * Every app computes totals, and three implementations would drift within a
 * month. Prices are integers in minor units throughout; the only rounding is
 * at the points marked below, and it is always Math.round on a single value
 * rather than accumulated fractions.
 */

export interface CartAddon {
  option_id: string;
  group_id: string;
  name: string;
  price_delta: number;
  qty?: number;
}

export interface CartLine {
  /** Stable within the cart, so quantity edits do not merge distinct lines. */
  key: string;
  menu_item_id: string;
  name: string;
  unit_price: number;
  qty: number;
  addons: CartAddon[];
  notes?: string;
  station?: string;
  station_key?: string;
  prep_minutes?: number;
  seat_no?: number;
  course?: number;
}

/** Unit price plus every add-on, before quantity. */
export const lineUnitPrice = (line: CartLine): number =>
  line.unit_price + line.addons.reduce((sum, a) => sum + a.price_delta * (a.qty ?? 1), 0);

export const lineTotal = (line: CartLine): number => lineUnitPrice(line) * line.qty;

export interface OrderTotals {
  subtotal: number;
  discount_total: number;
  service_total: number;
  tax_total: number;
  delivery_fee: number;
  total: number;
}

export interface TotalsInput {
  lines: CartLine[];
  /** Already-resolved discount amount in minor units. */
  discount?: number;
  deliveryFee?: number;
  settings: Pick<Settings, 'tax_rate_bp' | 'tax_inclusive' | 'service_charge_bp'>;
}

/**
 * Order of operations matters for what the customer is charged and for what
 * the tax authority is owed:
 *
 *   1. line totals            (item + add-ons) x quantity
 *   2. minus discounts        never below zero
 *   3. plus service charge    on the DISCOUNTED subtotal, not the gross
 *   4. plus delivery
 *   5. tax                    extracted from the total when prices are
 *                             tax-inclusive, added on top when they are not
 *
 * Tips are deliberately absent: they are not sales, are never discounted and
 * are not taxed as revenue, so they are recorded on the payment instead.
 */
export function computeTotals({ lines, discount = 0, deliveryFee = 0, settings }: TotalsInput): OrderTotals {
  const subtotal = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  const discount_total = Math.min(Math.max(discount, 0), subtotal);
  const discounted = subtotal - discount_total;

  const service_total = Math.round((discounted * (settings.service_charge_bp || 0)) / 10000);
  const taxableBase = discounted + service_total + deliveryFee;

  const rate = settings.tax_rate_bp || 0;
  const tax_total = settings.tax_inclusive
    ? Math.round(taxableBase - (taxableBase * 10000) / (10000 + rate))
    : Math.round((taxableBase * rate) / 10000);

  return {
    subtotal,
    discount_total,
    service_total,
    tax_total,
    delivery_fee: deliveryFee,
    // Inclusive tax is already inside the prices, so adding it again would
    // charge the customer twice.
    total: settings.tax_inclusive ? taxableBase : taxableBase + tax_total,
  };
}

/** Split a bill evenly, giving any remainder to the earliest shares. */
export function splitEvenly(total: number, ways: number): number[] {
  if (ways < 1) return [total];
  const base = Math.floor(total / ways);
  const remainder = total - base * ways;
  return Array.from({ length: ways }, (_, i) => base + (i < remainder ? 1 : 0));
}
