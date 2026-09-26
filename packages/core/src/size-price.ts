/**
 * Putting a size's price back on a bill that has not been paid yet.
 *
 * Until the fix in order-guard's reprice.js, the server re-priced every new
 * order from the drink alone and never read the size, so a large Club rung up
 * at GH₵30 was rewritten to GH₵25 a second after it was sent. The bills that
 * are still unpaid can be put right before anybody pays them; the only way
 * before this was to cancel each one and ring it up again.
 *
 * Only a line sold as a size is touched, and only to the size's own price plus
 * the choices on the line as they were charged. A line whose price somebody
 * changed by hand at the till is left alone: that was a decision. A size that
 * could not be read is left alone too — a guess is not a correction.
 *
 * Pure. The caller reads the lines and the sizes and writes the result.
 */

/** A line as stored, as far as this decision reads it. */
export interface PricedLine {
  $id: string;
  name_snapshot: string;
  qty: number;
  unit_price: number;
  line_total: number;
  status?: string;
  variant_id?: string | null;
  list_price?: number | null;
  /** JSON, exactly as stored: the choices on the line, with what each added. */
  addons?: string | null;
}

/** One line that comes out differently at its size's price. */
export interface SizePriceFix {
  lineId: string;
  name: string;
  qty: number;
  fromTotal: number;
  toUnit: number;
  toTotal: number;
}

/**
 * What the choices on a line added per unit, as they were charged.
 *
 * From the line's own record rather than today's menu, so an add-on repriced
 * since is not slipped in. Null when the record cannot be read, which stops
 * the line being touched rather than pricing it without its choices.
 */
export function addonsCharged(addons: string | null | undefined): number | null {
  if (!addons) return 0;
  let parsed: unknown;
  try { parsed = JSON.parse(addons); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  let sum = 0;
  for (const a of parsed) {
    const delta = Number((a as { price_delta?: unknown })?.price_delta ?? 0);
    const qty = Number((a as { qty?: unknown })?.qty ?? 1);
    if (!Number.isFinite(delta) || !Number.isFinite(qty)) return null;
    sum += delta * qty;
  }
  return sum;
}

/**
 * The lines the server rewrote to a different price, by name, from its own log
 * ("Club · Large: sent 3000, actual 2500" on an `order_price_corrected` entry).
 *
 * The log is the evidence. A size charged below its price NOW is no proof of
 * this fault — the price may simply have gone up since — and offering to
 * "correct" that would be repricing a bill against a menu that changed after
 * it was rung up.
 */
export function rewrittenLines(audits: { after?: string | null }[]): string[] {
  const names = new Set<string>();
  for (const a of audits) {
    let corrections: unknown = [];
    try { corrections = (JSON.parse(a.after || '{}') as { corrections?: unknown }).corrections ?? []; } catch { continue; }
    if (!Array.isArray(corrections)) continue;
    for (const c of corrections) {
      const m = /^(.*): sent (-?\d+), actual (-?\d+)$/.exec(String(c));
      if (m && Number(m[2]) !== Number(m[3])) names.add(m[1] ?? '');
    }
  }
  return [...names];
}

/**
 * Every line on this bill the server rewrote that now comes out differently at
 * its size's price. Sizes are given as id → price, read now; one missing is
 * left alone. `rewritten` is the names from the log; see rewrittenLines.
 */
export function sizePriceFixes(
  lines: PricedLine[],
  sizePrices: Record<string, number>,
  rewritten: string[],
): SizePriceFix[] {
  const named = new Set(rewritten);
  const out: SizePriceFix[] = [];
  for (const l of lines) {
    if (l.status === 'void' || !l.variant_id || typeof l.list_price === 'number') continue;
    if (!named.has(l.name_snapshot)) continue;
    const price = sizePrices[l.variant_id];
    if (typeof price !== 'number' || !Number.isFinite(price)) continue;
    const extra = addonsCharged(l.addons);
    if (extra === null) continue;
    const toUnit = price + extra;
    const toTotal = toUnit * l.qty;
    if (toTotal === l.line_total) continue;
    out.push({ lineId: l.$id, name: l.name_snapshot, qty: l.qty, fromTotal: l.line_total, toUnit, toTotal });
  }
  return out;
}

/**
 * Why this bill may not be repriced, or null if it may.
 *
 * Only a bill nobody has paid anything against. Money already taken at the
 * lower price is money the customer was told was the bill; asking them for
 * more afterwards is a conversation, not a button.
 */
export function sizePriceProblem(
  order: { status?: string; payment_status?: string },
  taken: number,
): string | null {
  if (order.status === 'CANCELLED' || order.status === 'REJECTED') {
    return 'This bill was cancelled, so there is nothing on it to reprice.';
  }
  if (taken > 0 || order.payment_status === 'paid' || order.payment_status === 'partial') {
    return 'Money has already been taken on this bill at the lower price, so it stays as it was charged.';
  }
  return null;
}

/** One line, said: "1× Club · Large: GH₵25.00 → GH₵30.00". */
export const sizePriceWords = (fix: SizePriceFix, money: (n: number) => string): string =>
  `${fix.qty}× ${fix.name}: ${money(fix.fromTotal)} → ${money(fix.toTotal)}`;

/** What the lines add up to differently. */
export const sizePriceDelta = (fixes: SizePriceFix[]): number =>
  fixes.reduce((sum, f) => sum + (f.toTotal - f.fromTotal), 0);
