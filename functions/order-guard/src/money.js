/**
 * The arithmetic order-guard does to money, on its own, importing nothing.
 *
 * This is deliberately a second implementation of sums that also exist in
 * packages/core. A browser bundle and an Appwrite function cannot share a
 * module, so the choice is between two copies and no server-side check at all,
 * and no server-side check is not a choice: prices arrive from a phone.
 *
 * Two copies of money arithmetic drift. The guard against that is not care, it
 * is a test: packages/core/src/__tests__/parity.test.ts runs both against the
 * same inputs and fails the build when they disagree. That test can only import
 * this file if it has no dependencies, which is why it has none.
 */

/**
 * Service, tax and the total, from a subtotal and a discount.
 *
 * Mirrors computeTotals in packages/core/src/pricing.ts.
 */
export function totalsFor(subtotal, discount, settings) {
  const discounted = subtotal - discount;
  const service = Math.round((discounted * (settings.service_charge_bp || 0)) / 10000);
  const taxable = discounted + service;
  const rate = settings.tax_rate_bp || 0;
  const tax = settings.tax_inclusive
    ? Math.round(taxable - (taxable * 10000) / (10000 + rate))
    : Math.round((taxable * rate) / 10000);
  return { service, tax, total: settings.tax_inclusive ? taxable : taxable + tax };
}

/**
 * Which commission rate applies, most specific first.
 *
 * Mirrors rateFor in packages/core/src/consignment-math.ts.
 */
export function rateFor(line, consignor, settings) {
  const candidates = [line?.commission_bp, consignor?.commission_bp, settings?.default_commission_bp];
  for (const bp of candidates) {
    if (typeof bp === 'number' && Number.isFinite(bp) && bp >= 0) {
      return Math.max(0, Math.min(10000, Math.round(bp)));
    }
  }
  return 3000;
}

/**
 * The shop's share and the maker's, from one line's money.
 *
 * The shop's share is rounded and the maker gets the remainder. Rounding both
 * independently does not have to add back up to what the customer paid, and the
 * pesewa always went the same way.
 *
 * Mirrors splitSale in packages/core/src/consignment-math.ts.
 */
export function splitSale(gross, commissionBp) {
  const bp = Math.max(0, Math.min(10000, Math.round(commissionBp)));
  const commission = Math.round((gross * bp) / 10000);
  return { gross, commission, consignor: gross - commission, bp };
}

/** The cap on a quoted wait. Mirrors MAX_ETA_MINUTES in core. */
export const MAX_ETA_MINUTES = 60;

/**
 * What is left to cook on the tickets already on the pass.
 *
 * Mirrors queueMinutes in packages/core/src/orders-time.ts.
 */
export function queueMinutes(pending, now = Date.now()) {
  const cooking = ['PENDING', 'ACCEPTED', 'PREPARING'];
  let ahead = 0;
  for (const o of pending) {
    if (!cooking.includes(o.status)) continue;
    const work = o.prep_minutes ?? o.eta_minutes ?? 15;
    const started = o.accepted_at ? Date.parse(o.accepted_at) : NaN;
    const elapsed = Number.isFinite(started) ? Math.max(0, (now - started) / 60000) : 0;
    ahead += Math.max(0, work - elapsed);
  }
  return Math.round(ahead);
}

/** Cooking time plus the queue, capped. Mirrors estimateMinutes in core. */
export function quotedWait(prepTotal, queueAhead) {
  return Math.min(MAX_ETA_MINUTES, Math.max(1, Math.round(prepTotal + queueAhead)));
}
