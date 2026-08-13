/**
 * The rules about money going out, with nothing behind them.
 *
 * Split from `expenses.ts` for the same reason `shift-rules.ts` was split from
 * `shifts.ts`: that file opens a database connection on import, and these are
 * the decisions that determine whether a drawer is counted short. They are
 * worth being able to check without a database.
 *
 * Pure. Imports nothing at runtime.
 */

export const PAID_TO_KINDS = [
  { v: 'supplier', l: 'A supplier' },
  { v: 'open_market', l: 'Open market, no fixed supplier' },
  { v: 'staff', l: 'A member of staff' },
  { v: 'other', l: 'Someone else' },
] as const;

export type PaidToKind = (typeof PAID_TO_KINDS)[number]['v'];

/** The seven values the original fixed column accepts; rows must still validate. */
export const LEGACY_EXPENSE_CATEGORIES = [
  'supplies', 'transport', 'utilities', 'repairs', 'staff_advance', 'petty_cash', 'other',
];

export const legacyExpenseCategory = (key: string) =>
  LEGACY_EXPENSE_CATEGORIES.includes(key) ? key : 'other';

/**
 * Which payment methods an expense may be paid out of.
 *
 * Cash only by default, and the reason is not tidiness. A cash expense reduces
 * what the drawer should hold, so it meets a physical count at the end of the
 * shift and a wrong one shows up within hours. An expense filed against mobile
 * money reduces nothing anybody counts, which makes it the easiest entry in
 * the system to write and never have questioned.
 *
 * Restaurants that genuinely pay suppliers by transfer can turn the restriction
 * off; the setting exists because that is a real way to run a kitchen, not
 * because the default is arbitrary.
 *
 * If the restriction is on but no cash method has been set up, every method is
 * allowed rather than none. A form with an empty dropdown teaches staff the
 * screen is broken, and the honest failure here is to let the expense be
 * recorded and be visible in the report.
 */
export function expenseMethods<T extends { $id: string; kind?: string }>(
  methods: T[],
  settings?: { expense_paid_from?: 'cash_only' | 'any' },
): T[] {
  if ((settings?.expense_paid_from ?? 'cash_only') === 'any') return methods;
  const cash = methods.filter((m) => m.kind === 'cash');
  return cash.length ? cash : methods;
}

/**
 * A readable "paid to", whichever way the money went out.
 *
 * Reports and the ledger read `payee`, so it is filled in even when the real
 * answer is an id, nobody wants a supplier row id in a shift summary.
 */
export function payeeLabel(
  kind: PaidToKind,
  parts: { supplierName?: string; staffName?: string; payee?: string },
): string {
  if (kind === 'supplier') return parts.supplierName?.trim() ?? '';
  // The chosen member of staff, or a typed name when the person is not on the
  // list. Without the fallback the Name box beside the staff dropdown would
  // take an answer and throw it away, which is worse than not asking.
  if (kind === 'staff') return parts.staffName?.trim() || parts.payee?.trim() || '';
  // No name is asked for at the open market, because there is rarely one to
  // give. Anything already recorded on an older row still reads.
  if (kind === 'open_market') return parts.payee?.trim() || 'Open market';
  return parts.payee?.trim() ?? '';
}

/**
 * Did this come out of the drawer, or out of somebody's own pocket?
 *
 * Written down once, read everywhere, because "was it recorded but not
 * deducted" is a question three screens ask and none of them should answer
 * separately. Absent means yes: every row from before the question existed was
 * money out of the drawer and has been counted that way all along.
 */
export const fromTakings = (e: { from_takings?: boolean }): boolean => e.from_takings !== false;
