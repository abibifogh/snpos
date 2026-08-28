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

/* ------------------------------------------------- whose categories are whose */

/**
 * The spending categories one side of the business should be offered.
 *
 * A bar recording a crate of tonic should not scroll past "Kitchen gas" and
 * "Craft packaging" to find it. A list three trades long is one people file
 * under whatever is nearest, and a month later nobody can say what the bar
 * actually spent.
 *
 * "general" belongs to everybody — transport, repairs, petty cash are not any
 * one trade's — and an ABSENT value reads as general on purpose: every
 * category that existed before this was used by all three, and narrowing them
 * to the kitchen would empty the other two lists overnight.
 */
export function categoriesForSide<T extends { module?: string; active?: boolean }>(
  rows: T[],
  module: string,
  opts: { includeArchived?: boolean; canSeePrivate?: boolean } = {},
): T[] {
  return rows.filter((r) => {
    if (!opts.includeArchived && r.active === false) return false;
    const owner = r.module || 'general';
    // Rent, drawings, a legal bill: recorded like any other spending, and not
    // on a dropdown the floor reads. Sides aside, so it shows up wherever an
    // admin happens to be working rather than only on one trade's screen.
    if (owner === ADMIN_ONLY_SIDE) return !!opts.canSeePrivate;
    return owner === 'general' || owner === module;
  });
}

/** The "Shown on" value that means: admins, and whoever an admin has let in. */
export const ADMIN_ONLY_SIDE = 'admin_only';

/**
 * The sides a category can belong to, for the picker that sets it.
 *
 * "Admin only" sits in the same list because it is the same question asked
 * once — where does this show up — and answering it twice on one form is how
 * you get a category that is bar-only AND admin-only and nobody can say which
 * rule won. The cost is that the two cannot be combined; if that is ever
 * wanted it needs a separate toggle, not a fifth entry here.
 */
export const CATEGORY_SIDES: { value: string; label: string; help: string }[] = [
  { value: 'general', label: 'Everywhere', help: 'Transport, repairs, petty cash — spending that is not any one trade\'s.' },
  { value: 'kitchen', label: 'Bistro only', help: 'Shown when recording spending against the kitchen.' },
  { value: 'bar', label: 'Bar only', help: 'Shown when recording spending against the bar.' },
  { value: 'craft', label: 'Craft shop only', help: 'Shown when recording spending against the shop.' },
  { value: ADMIN_ONLY_SIDE, label: 'Admin only', help: 'Rent, drawings, legal fees. Hidden from the tills. Admins see it, and anybody an admin has granted it under Staff.' },
];

/**
 * May this person see the admin-only categories?
 *
 * Admins always. Everybody else only if an admin has said so on their staff
 * record — which is the whole point of the grant: a manager who does the
 * books should not have to be made an admin to file the rent.
 */
export function canSeePrivateExpenses(
  profile?: { role?: string; can_see_private_expenses?: boolean } | null,
): boolean {
  if (!profile) return false;
  return profile.role === 'admin' || profile.can_see_private_expenses === true;
}

/* ------------------------------------------ recording one from the office */

/**
 * Where an expense is being written down.
 *
 * The two are not the same form asked in two places, and treating them as one
 * is what put a cash-only dropdown and a shift's drawer in front of an owner
 * paying a supplier by bank transfer three days later.
 *
 * AT THE TILL, money physically leaves a drawer somebody is going to count in
 * a few hours. That is why it is cash only and why it comes off the shift: a
 * wrong entry meets a physical count the same night, which is the whole
 * safeguard.
 *
 * IN THE OFFICE, none of that is true. The spend already happened, it may
 * never have touched a drawer at all, and there is no count tonight that would
 * catch a mistake. Offering the drawer as the default there quietly makes some
 * shift short by an amount its cashier never handled.
 */
export type ExpenseDesk = 'till' | 'office';

/**
 * Which payment methods this desk may record an expense against.
 *
 * The cash-only rule is the TILL's, and it is a good one — see expenseMethods.
 * It was being applied in the office too, where the honest answer is often
 * "the bank", and where forcing that to be filed as cash puts money against a
 * drawer that never held it.
 */
export function expenseMethodsFor<T extends { $id: string; kind?: string }>(
  methods: T[],
  settings: { expense_paid_from?: 'cash_only' | 'any' } | undefined,
  desk: ExpenseDesk,
): T[] {
  return desk === 'office' ? methods : expenseMethods(methods, settings);
}

/**
 * May this desk say the money came off a shift's takings?
 *
 * The till, always: that is exactly what is happening. The office, only when
 * CORRECTING a row that already says so — which is the reason the question is
 * on that screen at all, since a cook can get it wrong in either direction and
 * somebody has to be able to put it right.
 *
 * What the office must not do is offer it on something new. An expense typed
 * up on Thursday for a Tuesday market run is not coming out of any drawer
 * being counted, and filing it against one makes that shift short by money its
 * cashier never handled.
 */
export function mayComeFromShift(desk: ExpenseDesk, existing: boolean): boolean {
  return desk === 'till' || existing;
}

/**
 * Which sides an expense may be filed under.
 *
 * Every trade the business runs, from one list, in a fixed order. This was
 * written as two hard-coded options back when there were two sides, so a bar
 * expense could not be filed as the bar's at all — it went down as the
 * kitchen's, which is where it stayed in the books.
 */
export function expenseSides<T extends string>(
  running: Record<T, boolean>,
  order: T[],
): T[] {
  return order.filter((m) => running[m]);
}

/**
 * Which side a new expense should start on.
 *
 * Whatever the list behind the form is filtered to. Somebody who has narrowed
 * the page to the bar and pressed Record expense has already said which side
 * they mean, and asking again is asking a question they have answered — which
 * is how a bar expense gets saved as the kitchen's by nobody's decision.
 *
 * "All" is not an answer, so it falls through to the only side that runs, or
 * to the first of several. A business with one trade never sees the question.
 */
export function defaultExpenseSide<T extends string>(
  filter: T | 'all' | undefined,
  sides: T[],
): T | undefined {
  if (filter && filter !== 'all' && sides.includes(filter as T)) return filter as T;
  return sides[0];
}

/**
 * Does this expense still need asking where the money came from?
 *
 * No, once the method already answers it. "Paid from: Bank transfer" says
 * where the money came from — the bank — and then asking again, with a drawer
 * and a petty cash tin as the only options, is a form asking a question it has
 * just been told the answer to. Whichever answer gets left in place is wrong:
 * a bank transfer never came off a shift's drawer, and it did not come out of
 * a tin either, so the screen went on to warn that no tin was set up for a
 * spend no tin should ever be lighter for.
 *
 * The distinction is not "bank" specifically. It is whether the method is one
 * money goes OUT of and never into — an account rather than a drawer. Those
 * are never counted at a close and never charged to a box; the payment method
 * is the whole answer.
 *
 * A cash or mobile-money expense still has to be asked, because those genuinely
 * could have come out of either the shift's takings or a petty cash tin, and
 * which one decides whether a drawer is counted short tonight.
 */
export function asksMoneySource(method?: { payouts_only?: boolean } | null): boolean {
  return method?.payouts_only !== true;
}
