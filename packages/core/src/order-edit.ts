/**
 * Correcting what was actually ordered, after the fact.
 *
 * A till mis-rings. Three coffees are typed where two were made, a plate is
 * sent back, a bill is built for a table that turns out to be two tables. The
 * only way to fix any of it was to reject the whole order and ring it again,
 * which loses the order number, the times, and the record of who took it — so
 * in practice nobody did, and the figures carried the error instead.
 *
 * So a quantity can be corrected. What makes this delicate is not the sum; it
 * is everything DOWNSTREAM of the sum, and each piece has a different answer:
 *
 *   THE TOTALS      are simply recomputed. Tax and service charge are worked
 *                   out from the lines every time, so they follow on their own.
 *   THE SHELF       has already moved if this was a shop sale that was paid
 *                   for. A count that silently disagrees with the sale behind
 *                   it is a count nobody trusts a week later, so the difference
 *                   is put back with a correcting movement of its own.
 *   A CONSIGNOR     may already have been credited for the piece, and that is
 *                   somebody's money. It is not rewritten from a screen.
 *   THE PAYMENT     may now be too much or too little. That is not corrected
 *                   here either, but it is SAID, because a bill quietly left
 *                   overpaid is a customer owed a refund nobody knows about.
 *
 * Pure. The caller reads and writes; this decides what is allowed and what the
 * numbers become.
 */

// Nothing is imported at runtime. The sum itself lives in pricing.ts beside
// the rest of the money maths — see retotalOrder — so that a correction and a
// fresh sale can never work a total out two different ways.

/** A line as it stands, and as somebody wants it to stand. */
export interface EditableLine {
  $id: string;
  name_snapshot: string;
  unit_price: number;
  qty: number;
  /** JSON, exactly as stored. Read only to price the add-ons again. */
  addons?: string;
  status: string;
  consignor_id?: string;
}

/** What the order looks like to this decision. */
export interface EditableOrder {
  status: string;
  payment_status: string;
  /** Any discount already applied, in minor units. Carried over untouched. */
  discount_total?: number;
  /** Delivery, carried over untouched. */
  delivery_fee?: number;
}

/**
 * Why this order may not be re-quantified, or null if it may.
 *
 * Said as a reason rather than a disabled button. A screen that refuses
 * without explaining sends somebody to ask a question that the screen already
 * knew the answer to.
 */
export function quantityEditProblem(
  order: EditableOrder,
  opts: { creditedLineIds?: string[] } = {},
): string | null {
  if (order.status === 'CANCELLED' || order.status === 'REJECTED') {
    return 'This order was cancelled, so there is nothing on it to correct. It is already worth nothing.';
  }
  if ((opts.creditedLineIds ?? []).length > 0) {
    return 'A maker has already been credited for something on this bill. Changing what was sold would leave '
      + 'their statement saying one thing and the sale another, and their money is not something to rewrite from '
      + 'this screen. Adjust it on the consignor instead.';
  }
  return null;
}

/**
 * Whether a line may have its quantity changed.
 *
 * A voided line is already at nothing and putting a number back on it would be
 * un-voiding it by the back door, which is a different decision with a
 * different reason attached.
 */
export const lineIsEditable = (line: EditableLine): boolean => line.status !== 'void';

/** Unit price including its add-ons, read back out of what was stored. */
export function storedUnitPrice(line: EditableLine): number {
  let addons = 0;
  try {
    const parsed = JSON.parse(line.addons || '[]') as { price_delta?: number; qty?: number }[];
    addons = parsed.reduce((sum, a) => sum + (a.price_delta ?? 0) * (a.qty ?? 1), 0);
  } catch {
    // A line whose add-ons cannot be read is priced on the item alone rather
    // than refusing the whole correction. It is the same number the line was
    // sold at unless somebody hand-edited the field.
    addons = 0;
  }
  return line.unit_price + addons;
}

export const newLineTotal = (line: EditableLine, qty: number): number => storedUnitPrice(line) * qty;

/** A quantity that has actually moved, and by how much. */
export interface QuantityChange {
  lineId: string;
  name: string;
  from: number;
  to: number;
  /** Negative where the order shrank. What the shelf owes back. */
  delta: number;
}

export function quantityChanges(
  lines: EditableLine[],
  quantities: Record<string, number>,
): QuantityChange[] {
  return lines
    .filter(lineIsEditable)
    .map((l) => ({
      lineId: l.$id,
      name: l.name_snapshot,
      from: l.qty,
      to: quantities[l.$id] ?? l.qty,
      delta: (quantities[l.$id] ?? l.qty) - l.qty,
    }))
    .filter((c) => c.delta !== 0);
}

/**
 * A quantity somebody has typed, or why it cannot be used.
 *
 * Zero is allowed and means the line was not sold at all. It is left on the
 * order at nothing rather than deleted, because a line that disappears takes
 * with it the fact that it was ever rung up, and that fact is the point of
 * asking what happened.
 */
export function quantityProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return 'Put a number here, or 0 if it was not sold at all.';
  if (!/^\d+$/.test(trimmed)) return 'Whole numbers only.';
  if (Number(trimmed) > 999) return 'That is more than anybody ordered. Check the number.';
  return null;
}

/**
 * What the correction does to money that has already changed hands.
 *
 * Not fixed here — a refund is a decision somebody makes, not a side effect of
 * fixing a quantity — but never left unsaid.
 */
export function moneyEffect(
  taken: number,
  newTotal: number,
  format: (amount: number) => string,
): string | null {
  if (taken <= 0) return null;
  if (taken > newTotal) {
    return `This bill has ${format(taken)} against it and now comes to ${format(newTotal)}. `
      + `The customer is owed ${format(taken - newTotal)} back — record the refund separately, it does not `
      + 'happen on its own.';
  }
  if (taken < newTotal) {
    return `This bill has ${format(taken)} against it and now comes to ${format(newTotal)}, so ${format(newTotal - taken)} `
      + 'is still owed. It will show on the pass as a bill still to pay.';
  }
  return null;
}

/**
 * What the payment status should become once the total has moved.
 *
 * Left alone where nothing has been taken: an unpaid order that is corrected
 * is still simply unpaid, and writing the same word back is a change in the
 * audit log that says nothing happened.
 */
export function paymentStatusAfter(taken: number, newTotal: number): 'unpaid' | 'partial' | 'paid' | null {
  if (taken <= 0) return null;
  if (taken >= newTotal) return 'paid';
  return 'partial';
}
