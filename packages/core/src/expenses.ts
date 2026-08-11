import { Query, listAll } from './client';
import type { Doc, StaffProfile } from './types';

/**
 * Where the money went.
 *
 * Lived in the admin expense form only, which is how the kitchen ended up
 * writing every expense as "other" with a free-text name, two forms asking the
 * same question in two different shapes. It is defined once here now, and both
 * forms read it.
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

export interface Supplier extends Doc {
  name: string;
  active?: boolean;
}

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

export interface ExpenseCategoryDoc extends Doc {
  key: string;
  name: string;
  account_code?: string;
  active?: boolean;
  sort?: number;
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
  if (kind === 'staff') return parts.staffName?.trim() ?? '';
  if (kind === 'open_market') return parts.payee?.trim() || 'Open market';
  return parts.payee?.trim() ?? '';
}

/** Everything the "paid to" question needs to offer its choices. */
export async function loadPaidToOptions(): Promise<{
  suppliers: Supplier[];
  staff: StaffProfile[];
  categories: ExpenseCategoryDoc[];
}> {
  const [suppliers, staff, categories] = await Promise.all([
    listAll<Supplier>('suppliers').catch(() => [] as Supplier[]),
    listAll<StaffProfile>('staff_profiles', [Query.equal('active', true)]).catch(() => [] as StaffProfile[]),
    listAll<ExpenseCategoryDoc>('expense_categories').catch(() => [] as ExpenseCategoryDoc[]),
  ]);
  return {
    suppliers: suppliers.filter((s) => s.active !== false),
    staff,
    categories: categories.filter((c) => c.active !== false).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
  };
}
