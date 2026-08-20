/**
 * Sealing a shift, so nothing in it can be changed again.
 *
 * Closing a shift ends it. It does not settle it: the close time can be
 * corrected, an order can be moved onto or off it, a payment can be voided, an
 * expense reclassified. All of those are deliberate and all of them are needed
 * — a night filed under the wrong day, a bill rung up twice, a taxi filed as
 * supplies. What was missing was any way to say "this one is finished now".
 *
 * That matters once a night has been REPORTED ON. A figure somebody has read,
 * acted on, or handed to an accountant should not quietly become a different
 * figure a week later, and until now nothing in the system could tell the
 * difference between a shift closed an hour ago and one closed last March.
 *
 * This is not the same as closing an accounting PERIOD, which draws a line
 * under every entry up to a date and is about the books. This is about one
 * night's trading and the rows that hang off it. A business can want either
 * without the other: a month can be open while last Tuesday is settled.
 *
 * WHAT THIS IS AND IS NOT. It is a rule the screens keep, not a lock the
 * database enforces — Appwrite has no row-level guard, so anything holding a
 * key could still write. It stops the ordinary accidents, which is what
 * accidents are; it is not a defence against somebody determined.
 *
 * Pure. Nothing here reads or writes.
 */

export interface LockableShift {
  code?: string;
  status?: string;
  locked_at?: string;
  locked_by?: string;
  lock_reason?: string;
}

/**
 * Named for the shift rather than "isLocked", which the accounting period lock
 * owns already. Two exports with one name in a package everything imports from
 * is a collision waiting for whichever file compiles second — and these two
 * mean genuinely different things, so the day they were confused would be a
 * month's books unlocked to correct one night.
 */
export const isSealed = (shift: LockableShift | null | undefined): boolean => !!shift?.locked_at;

/**
 * Why this shift cannot be sealed yet, or nothing.
 *
 * One refusal, and it is not a house rule: a shift still open has not finished
 * happening. Sealing it would stop the till taking money against a night it
 * has not stopped trading, and the first person to notice would be a cashier
 * at eleven at night with a customer waiting.
 */
export function sealProblem(shift: LockableShift): string | null {
  if (isSealed(shift)) return `${shift.code ?? 'That shift'} is already settled.`;
  if (shift.status !== 'closed') {
    return `${shift.code ?? 'That shift'} is still open. Close it from the till first — a shift that has not `
      + 'finished trading cannot be settled.';
  }
  return null;
}

/**
 * The message shown when somebody tries to change something inside a sealed
 * shift, or nothing when they may.
 *
 * One sentence, written once, so every screen refuses in the same words. Six
 * screens each phrasing it themselves is six chances to imply the change went
 * through when it did not.
 */
export function lockedProblem(
  shift: LockableShift | null | undefined,
  what = 'that',
): string | null {
  if (!isSealed(shift)) return null;
  const when = shift?.locked_at ? new Date(shift.locked_at).toLocaleDateString() : '';
  return `${shift?.code ?? 'That shift'} was settled${when ? ` on ${when}` : ''}, so ${what} cannot be changed. `
    + 'An admin can reopen it from Shifts if it genuinely needs correcting.';
}

/**
 * Whether an order may be touched, given the shift it sits on.
 *
 * The same question as above, asked from the side of the thing being changed
 * rather than the shift. An order carries the shift's id and nothing else, so
 * the caller has to have looked the shift up — which is the point of taking it
 * as an argument rather than guessing from the order.
 */
export const orderIsSettled = (shift: LockableShift | null | undefined): boolean => isSealed(shift);

/** How a sealed shift reads on screen. */
export function lockWords(shift: LockableShift): { label: string; tone: 'ok' | 'default'; detail?: string } {
  if (!isSealed(shift)) return { label: 'Open to corrections', tone: 'default' };
  return {
    label: 'Settled',
    tone: 'ok',
    detail: shift.lock_reason || undefined,
  };
}

/** The change in one sentence, for the confirmation and the audit log alike. */
export function describeSeal(shift: LockableShift, sealing: boolean): string {
  const name = shift.code ?? 'the shift';
  return sealing
    ? `${name} is settled. Nothing in it can be changed until it is reopened.`
    : `${name} is open to corrections again.`;
}
