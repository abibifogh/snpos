/**
 * A running account, and the gate that stops one being forgotten.
 *
 * A tab is credit. Somebody eats, drinks and buys across the evening and pays
 * at the end, or at the end of the week, or the company does. That is ordinary
 * trade and the system had no way to record it, so it was being done as an
 * unpaid order left open — which the shift close then refused to let anybody
 * close over, correctly, because an unpaid order it does not understand is
 * money walking out of the door.
 *
 * Two things follow, and they are the whole design.
 *
 * FIRST, a tab is not payment. The money has not arrived. An order on a tab
 * stays unpaid and the tab carries the debt, so the shift that sold it does
 * not count takings it never took. Everything in this system is careful about
 * that line and this does not cross it.
 *
 * SECOND, and because of the first: a shift CAN close over a tab order, where
 * it may not close over an ordinary unpaid one — but not quietly. The cashier
 * asks an admin for a code and types it in. That is not ceremony. It is the
 * only moment when somebody who can see the whole business is looking at the
 * words "GH₵450 is going home unpaid tonight" while the person who let it
 * happen is still standing there.
 *
 * A tab spans the whole business on purpose. A guest who has a drink at the
 * bar, lunch from the kitchen and a basket from the shop has one account, not
 * three, and asking them to settle three is how one of them gets forgotten.
 *
 * Pure. Imports nothing at runtime.
 */

/** The account itself. */
export interface TabRow {
  $id: string;
  name: string;
  /** A room number, a company, a table — whatever identifies it out loud. */
  reference?: string;
  status: string;
  /**
   * What this tab may reach before it stops accepting orders, in minor units.
   * Zero or absent is no limit, which is what most of them are.
   */
  limit_amount?: number;
  contact_phone?: string;
}

/** An order as far as a tab is concerned. */
export interface TabOrder {
  $id: string;
  $createdAt: string;
  order_no: string;
  tab_id?: string;
  total: number;
  status: string;
  payment_status: string;
  module?: string;
  shift_id?: string;
}

/** A tab that is still taking orders. */
export const tabIsOpen = (tab: Pick<TabRow, 'status'>): boolean => tab.status === 'open';

/**
 * What is still owed on a tab.
 *
 * Cancelled and rejected orders are left out — nothing was sold — and so is
 * anything already paid, which is what settling a tab does to its orders. A
 * part-paid order counts what is left, since the rest of it is still owed.
 */
export function tabOwing(orders: TabOrder[], paidOn: (orderId: string) => number = () => 0): number {
  let owed = 0;
  for (const o of orders) {
    if (o.status === 'CANCELLED' || o.status === 'REJECTED') continue;
    if (o.payment_status === 'refunded') continue;
    owed += Math.max(0, o.total - paidOn(o.$id));
  }
  return owed;
}

/**
 * Why this order may not go on this tab, or null if it may.
 *
 * A limit that is only drawn and not enforced is not a limit. The check is
 * here rather than at the button so that the till, the kitchen and anything
 * later all refuse for the same reason in the same words.
 */
export function postProblem(
  tab: TabRow | null,
  owing: number,
  adding: number,
  format: (amount: number) => string,
): string | null {
  if (!tab) return 'Choose which tab this is going on.';
  if (!tabIsOpen(tab)) {
    return `${tab.name} has been settled and closed. An admin can open a new tab, or reopen this one.`;
  }
  const limit = tab.limit_amount ?? 0;
  if (limit > 0 && owing + adding > limit) {
    return `${tab.name} is limited to ${format(limit)} and already owes ${format(owing)}. `
      + `Adding ${format(adding)} would take it past that — it needs settling first, or an admin can raise `
      + 'the limit.';
  }
  return null;
}

/** What to put beside a tab in a list, so it reads without being opened. */
export function tabSummaryWords(
  tab: TabRow,
  owing: number,
  orderCount: number,
  format: (amount: number) => string,
): string {
  if (orderCount === 0) return 'Nothing on it yet.';
  const many = orderCount === 1 ? '1 order' : `${orderCount} orders`;
  const limit = tab.limit_amount ?? 0;
  const room = limit > 0 ? `, ${format(Math.max(0, limit - owing))} left of ${format(limit)}` : '';
  return `${many}, ${format(owing)} owing${room}.`;
}

/* ------------------------------------------- closing a shift over a tab */

/** How many digits the admin reads out. */
export const CLOSE_CODE_LENGTH = 6;

/**
 * How long a code is good for.
 *
 * Long enough to be read down a phone and typed at a busy counter, short
 * enough that one written on a till receipt in June is no use in July. A code
 * that never expires is a code that gets kept.
 */
export const CLOSE_CODE_GOOD_FOR_MS = 30 * 60_000;

/**
 * The orders this shift put on a tab.
 *
 * By the shift rather than by the day, because the question is what THIS
 * person is handing over. A tab order from last week is somebody else's
 * conversation and holding this close over it would teach staff that the gate
 * is noise.
 */
export function tabOrdersOnShift(orders: TabOrder[], shiftId: string, module: string): TabOrder[] {
  return orders.filter(
    (o) => !!o.tab_id
      && o.shift_id === shiftId
      && (o.module ?? 'kitchen') === module
      && o.status !== 'CANCELLED'
      && o.status !== 'REJECTED'
      // Already settled during the shift, so nothing is going home unpaid on
      // its account and there is nothing for an admin to be told about.
      && o.payment_status !== 'paid',
  );
}

/** What the gate is protecting, in one sentence, with the figure in it. */
export function releaseWords(
  orders: TabOrder[],
  format: (amount: number) => string,
): string {
  const value = orders.reduce((sum, o) => sum + o.total, 0);
  const many = orders.length === 1 ? '1 order' : `${orders.length} orders`;
  return `${many} on this shift went onto a tab and ${format(value)} is going home unpaid. `
    + 'An admin has to release the shift before it can close — ask them for the code.';
}

/**
 * Is the typed code the right shape?
 *
 * Checked before it is compared, so a cashier who typed five digits is told
 * that rather than being told the code is wrong — which sends them back to the
 * admin for a code that was correct all along.
 */
export function closeCodeProblem(entered: string): string | null {
  const code = entered.trim();
  if (code === '') return 'Enter the code the admin gave you.';
  if (!/^\d+$/.test(code)) return 'The code is digits only.';
  if (code.length !== CLOSE_CODE_LENGTH) return `The code is ${CLOSE_CODE_LENGTH} digits.`;
  return null;
}

export interface IssuedCode {
  shift_id: string;
  module?: string;
  issued_at: string;
  used_at?: string;
}

/**
 * Why an issued code cannot be used, or null if it can.
 *
 * A code is for one shift and one use. Both matter: one that works twice is a
 * code somebody keeps for next time, and one that works on any shift is a
 * code that stops meaning "an admin looked at THIS".
 */
export function codeUsable(
  code: IssuedCode | null,
  shiftId: string,
  module: string,
  now: number,
  goodFor = CLOSE_CODE_GOOD_FOR_MS,
): string | null {
  if (!code) return 'No code has been issued for this shift yet. Ask an admin for one.';
  if (code.shift_id !== shiftId) return 'That code was issued for a different shift.';
  if ((code.module ?? module) !== module) return 'That code was issued for a different side of the business.';
  if (code.used_at) return 'That code has already been used. Ask the admin for a new one.';
  const age = now - Date.parse(code.issued_at);
  if (!Number.isFinite(age)) return 'That code cannot be read. Ask the admin for a new one.';
  if (age > goodFor) return 'That code has expired. Ask the admin for a new one.';
  // A stamp from the future is a clock that was corrected between the two
  // moments. It says nothing, so it is not treated as fresh.
  if (age < -60_000) return 'That code cannot be read. Ask the admin for a new one.';
  return null;
}

/**
 * A code, from numbers the browser can be trusted with.
 *
 * Not Math.random. This is the one thing standing between a cashier and
 * closing a shift over money going home unpaid, and a predictable six digits
 * is not standing anywhere.
 */
export function makeCloseCode(random: (n: number) => Uint8Array): string {
  const bytes = random(CLOSE_CODE_LENGTH);
  return Array.from(bytes, (b) => String(b % 10)).join('');
}
