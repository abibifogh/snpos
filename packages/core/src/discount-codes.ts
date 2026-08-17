/**
 * Discounts given by code rather than by whoever is at the till.
 *
 * A percentage box lets a cashier decide what a sale is worth. That is fine in
 * a restaurant where the manager is standing there, and it is not fine at a
 * counter: the number is invented at the moment of the sale, it is agreed with
 * nobody, and the only record afterwards is "20% discount" against a name.
 *
 * A code is the opposite. It exists before the sale, somebody decided it, it
 * has its own rules about when and to whom it applies, and every use of it can
 * be counted. What the cashier does is type it in, and the till says yes or
 * says exactly why not.
 *
 * Pure. Whether a code holds today, at this hour, on this basket, can be
 * checked without a database — which is the whole point, because these
 * decisions are otherwise only observable by trying them on a real sale.
 */

export interface DiscountRow {
  $id: string;
  name: string;
  code?: string;
  kind: 'percent' | 'amount' | 'free_item' | 'item_percent' | 'free_delivery';
  /** Basis points for percent, minor units for amount. */
  value: number;
  min_order_total: number;
  max_discount_amount?: number;
  staff_applicable: boolean;
  requires_manager: boolean;
  starts_at?: string;
  ends_at?: string;
  /** Lowercase three-letter days: mon, tue… Empty means every day. */
  days_of_week?: string[];
  /** "HH:MM", both or neither. */
  time_start?: string;
  time_end?: string;
  usage_limit_total?: number;
  used_count: number;
  active: boolean;
}

export interface CodeContext {
  subtotal: number;
  at: Date;
  /** What the cashier may authorise without a manager, in basis points. */
  ceilingBp?: number;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Minutes since midnight, or null when the text is not a time. */
function minutesOf(text?: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((text ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Find a code among the live ones. Case and stray spaces are not the point. */
export function findCode(rows: DiscountRow[], typed: string): DiscountRow | null {
  const want = typed.trim().toLowerCase();
  if (!want) return null;
  return rows.find((d) => (d.code ?? '').trim().toLowerCase() === want) ?? null;
}

/**
 * Why this code cannot be used, in the words the cashier needs.
 *
 * Every branch names the actual reason rather than "invalid code". A customer
 * standing at the counter holding a flyer wants to know whether it is the
 * wrong day or the wrong shop, and "invalid" starts an argument that a
 * sentence would have ended.
 */
export function codeProblem(d: DiscountRow | null, ctx: CodeContext): string | null {
  if (!d) return 'No discount with that code. Check the spelling, or ask an admin to set it up.';
  if (!d.active) return `"${d.name}" has been switched off.`;
  if (!d.staff_applicable) return `"${d.name}" is for customers ordering themselves, not for the till.`;

  if (d.starts_at && ctx.at < new Date(d.starts_at)) {
    return `"${d.name}" does not start until ${new Date(d.starts_at).toLocaleDateString()}.`;
  }
  if (d.ends_at && ctx.at > new Date(d.ends_at)) {
    return `"${d.name}" ended on ${new Date(d.ends_at).toLocaleDateString()}.`;
  }

  const days = (d.days_of_week ?? []).filter(Boolean).map((x) => x.toLowerCase());
  if (days.length > 0 && !days.includes(DAYS[ctx.at.getDay()])) {
    return `"${d.name}" only runs on ${days.join(', ')}.`;
  }

  const from = minutesOf(d.time_start);
  const to = minutesOf(d.time_end);
  if (from !== null && to !== null) {
    const now = ctx.at.getHours() * 60 + ctx.at.getMinutes();
    // A window that wraps midnight is a real thing a late bar sets.
    const inside = from <= to ? now >= from && now <= to : now >= from || now <= to;
    if (!inside) return `"${d.name}" only runs between ${d.time_start} and ${d.time_end}.`;
  }

  if (d.min_order_total > 0 && ctx.subtotal < d.min_order_total) {
    return `"${d.name}" needs a basket of at least ${(d.min_order_total / 100).toFixed(2)}.`;
  }

  if (d.usage_limit_total != null && d.used_count >= d.usage_limit_total) {
    return `"${d.name}" has been used its full ${d.usage_limit_total} times.`;
  }

  if (d.kind !== 'percent' && d.kind !== 'amount') {
    return `"${d.name}" gives a free item, which this till cannot apply yet. Take it off the bill by hand.`;
  }

  return null;
}

/** What the code takes off this basket, never more than the basket itself. */
export function discountAmount(d: DiscountRow, subtotal: number): number {
  if (subtotal <= 0) return 0;
  let off = d.kind === 'percent' ? Math.round((subtotal * d.value) / 10_000) : d.value;
  // A cap on a percentage is the shop saying "20% off, but no more than fifty
  // cedis" — without it a promotion meant for a small basket pays out on a
  // large one.
  if (d.max_discount_amount != null && d.max_discount_amount > 0) {
    off = Math.min(off, d.max_discount_amount);
  }
  return Math.max(0, Math.min(off, subtotal));
}

/**
 * Whether this one needs somebody more senior, and why.
 *
 * Two separate reasons, and both are about authority rather than arithmetic:
 * the discount itself may be marked as needing a manager, or it may simply be
 * bigger than this cashier is trusted with.
 */
export function needsManager(d: DiscountRow, ctx: CodeContext): string | null {
  if (d.requires_manager) return `"${d.name}" needs a manager to approve it.`;
  const ceiling = ctx.ceilingBp ?? 0;
  const off = discountAmount(d, ctx.subtotal);
  const asBp = ctx.subtotal > 0 ? Math.round((off / ctx.subtotal) * 10_000) : 0;
  if (asBp > ceiling) {
    return `That comes to ${(asBp / 100).toFixed(0)}% and you can authorise ${(ceiling / 100).toFixed(0)}%. `
      + 'A manager has to apply it.';
  }
  return null;
}

/** A short line for the bill, so the receipt says which offer it was. */
export const discountLabelFor = (d: DiscountRow): string =>
  d.code ? `${d.name} (${d.code.toUpperCase()})` : d.name;
