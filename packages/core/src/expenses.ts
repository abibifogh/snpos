import { Query, listAll } from './client';
import type { Doc, StaffProfile } from './types';
import type { PaidToKind } from './expense-rules';

/**
 * The decisions live next door, in a file that imports nothing.
 *
 * Re-exported so every caller keeps working. The split exists so the rule that
 * decides whether a drawer is counted short can be tested without a database,
 * not to make callers choose a file.
 */
export {
  PAID_TO_KINDS, LEGACY_EXPENSE_CATEGORIES, legacyExpenseCategory,
  expenseMethods, payeeLabel, fromTakings,
} from './expense-rules';
export type { PaidToKind } from './expense-rules';

/**
 * Where the money went.
 *
 * Lived in the admin expense form only, which is how the kitchen ended up
 * writing every expense as "other" with a free-text name, two forms asking the
 * same question in two different shapes. It is defined once here now, and both
 * forms read it.
 */
export interface Supplier extends Doc {
  name: string;
  active?: boolean;
}

export interface ExpenseCategoryDoc extends Doc {
  key: string;
  name: string;
  account_code?: string;
  active?: boolean;
  sort?: number;
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

/* ------------------------------------------------- correcting what was written */

/**
 * A recorded expense, as the screens that let it be corrected see it.
 *
 * Only the fields an edit touches. The row carries more, and an edit must not
 * disturb what it did not ask about.
 */
export interface ShiftExpense extends Doc {
  shift_id?: string;
  module?: string;
  amount: number;
  category_key?: string;
  category?: string;
  payee?: string;
  paid_to_kind?: PaidToKind;
  supplier_id?: string;
  paid_to_staff_id?: string;
  paid_from_method_id: string;
  from_takings?: boolean;
  note?: string;
  receipt_file_id?: string;
  created_by?: string;
  approval_status?: string;
}

