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
  // ------------------------------------------------------------- craft shop
  // Which size was picked, and whose work it is. Carried from the shelf to the
  // sale line so the ledger can credit the right person at the agreed rate,
  // without the till having to look anything up at the moment of payment.
  variant_id?: string;
  variant_label?: string;
  /**
   * What this line would have cost at the menu price, when somebody with
   * permission changed it at the till. See the schema note on `list_price`:
   * it is both the record of a decision and the flag that stops order-guard
   * repricing the line back a second after the sale.
   */
  list_price?: number;
  price_changed_by?: string;
  consignor_id?: string;
  commission_bp?: number;
  commission_flat?: number;
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

/**
 * What an order comes to once its quantities have been corrected.
 *
 * Here rather than beside the correction screen, and deliberately. A total
 * worked out in two places is two places that disagree the first time somebody
 * changes the service charge — so a corrected bill goes through exactly the
 * same arithmetic as a fresh one, in the same order, with the same rounding.
 *
 * Voided lines stay out, exactly as they were when the order was rung up, so a
 * correction cannot quietly bring a voided dish back into the total. A line
 * corrected to nothing drops out for the same reason it would never have been
 * added: nought of something costs nothing.
 */
export function retotalOrder({
  lines, quantities, discount = 0, deliveryFee = 0, settings,
}: {
  lines: {
    $id: string;
    unit_price: number;
    qty: number;
    /** JSON, exactly as stored on the order line. */
    addons?: string;
    status?: string;
  }[];
  /** New quantity per line id. A line not named here keeps the one it has. */
  quantities: Record<string, number>;
  discount?: number;
  deliveryFee?: number;
  settings: Pick<Settings, 'tax_rate_bp' | 'tax_inclusive' | 'service_charge_bp'>;
}): OrderTotals {
  const cart: CartLine[] = lines
    .filter((l) => l.status !== 'void')
    .map((l) => ({
      // The identity fields are never read by computeTotals — it prices lines,
      // it does not care which dish they are — and inventing plausible ones
      // here would be a second, quietly wrong copy of the order.
      key: l.$id,
      menu_item_id: '',
      name: '',
      unit_price: l.unit_price,
      qty: quantities[l.$id] ?? l.qty,
      addons: (() => {
        try {
          return JSON.parse(l.addons || '[]') as CartLine['addons'];
        } catch {
          // A line whose add-ons cannot be read is priced on the item alone
          // rather than refusing the whole correction.
          return [];
        }
      })(),
    }));

  return computeTotals({ lines: cart.filter((l) => l.qty > 0), discount, deliveryFee, settings });
}
