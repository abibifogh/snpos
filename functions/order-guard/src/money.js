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
 * A commission agreed as a flat amount per piece rather than as a share.
 *
 * Zero means there is none and the percentage applies. No shop-wide default:
 * a flat amount that suits a basket is nonsense on a necklace.
 *
 * Mirrors flatFor in packages/core/src/consignment-math.ts.
 */
export function flatFor(line, consignor) {
  const candidates = [line?.commission_flat, consignor?.commission_flat];
  for (const amount of candidates) {
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) return Math.round(amount);
  }
  return 0;
}

/**
 * The shop's share and the maker's, from one line's money.
 *
 * The shop's share is rounded and the maker gets the remainder. Rounding both
 * independently does not have to add back up to what the customer paid, and the
 * pesewa always went the same way.
 *
 * A flat amount, where one is agreed, wins over the percentage and is capped at
 * the sale, so a discounted piece can never leave the maker owing the shop.
 *
 * Mirrors splitSale in packages/core/src/consignment-math.ts.
 */
export function splitSale(gross, commissionBp, flatPerUnit = 0, qty = 1) {
  const bp = Math.max(0, Math.min(10000, Math.round(commissionBp)));
  const commission = flatPerUnit > 0
    ? Math.min(Math.max(0, gross), Math.round(flatPerUnit) * Math.max(1, Math.round(qty)))
    : Math.round((gross * bp) / 10000);
  return {
    gross,
    commission,
    consignor: gross - commission,
    bp: flatPerUnit > 0 ? (gross > 0 ? Math.round((commission / gross) * 10000) : 0) : bp,
    flat: flatPerUnit > 0 ? Math.round(flatPerUnit) : 0,
  };
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
    const work = cookTimeOf(o);
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

/**
 * Is the venue open at this moment? Mirrors isAvailable in core's availability.
 *
 * No rule means always open, which is the right default for a place that has
 * not configured hours.
 */
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const hhmm = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
};

export function parseWindows(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && Object.keys(parsed).length ? parsed : null;
  } catch {
    return null;
  }
}

export function isOpenAt(windows, at) {
  if (!windows) return true;
  const ranges = windows[DAYS[at.getDay()]];
  if (!ranges || ranges.length === 0) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return ranges.some(([from, to]) => {
    const start = hhmm(from);
    const end = hhmm(to);
    return end <= start ? now >= start || now < end : now >= start && now < end;
  });
}

/**
 * Minutes until the kitchen next opens. Mirrors minutesUntilOpen in core.
 *
 * The guard has to know this or it undoes it. It recomputes the quoted wait a
 * moment after an order lands, from the real queue, and a recomputation that
 * knows nothing about opening time would take an eighty minute quote given to
 * somebody ordering before the doors opened and quietly put it back to twenty
 * — leaving the customer's screen, the ticket and the promise all disagreeing.
 */
export function minutesUntilOpen(windows, at = new Date()) {
  if (!windows || isOpenAt(windows, at)) return 0;
  const cursor = new Date(at);
  for (let d = 0; d <= 7; d++) {
    const ranges = [...(windows[DAYS[cursor.getDay()]] ?? [])].sort();
    for (const [start] of ranges) {
      const candidate = new Date(cursor);
      const [h, m] = String(start).split(':').map(Number);
      candidate.setHours(h, m || 0, 0, 0);
      if (candidate > at) return Math.max(0, Math.round((candidate - at) / 60000));
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return 0;
}

/**
 * The whole wait, with the closed stretch on top. Mirrors
 * waitIncludingOpening in core: the kitchen's own part stays capped, the wait
 * for the doors is added whole.
 */
export function waitIncludingOpening(prepTotal, queueAhead, windows, at = new Date()) {
  const doors = minutesUntilOpen(windows, at);
  // Uncapped when the doors are shut: this is the KITCHEN's schedule, and a
  // cook judged against a capped figure they were never going to beat is how
  // a whole pass goes red through nobody's fault. The cap lives in front of
  // the customer instead. Mirrors waitIncludingOpening in core.
  const total = doors > 0
    ? doors + Math.max(1, Math.round(prepTotal + queueAhead))
    : quotedWait(prepTotal, queueAhead);
  return { total, doors };
}

/**
 * The stove time a ticket ahead will take. Mirrors cookTimeOf in core.
 *
 * Never the quoted wait on an order placed before opening: that figure
 * contains the hour spent waiting for the doors, and charging it as stove time
 * would add it to every order behind, and again to every order behind those.
 */
export function cookTimeOf(o) {
  if (o.prep_minutes) return o.prep_minutes;
  if (o.eta_minutes && !o.placed_while_closed) return o.eta_minutes;
  return 15;
}
