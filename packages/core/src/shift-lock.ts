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
 * What stands between a shift and being settled, as a fact rather than a
 * sentence.
 *
 * The sentence is below and is what a person reads. This is what code asks,
 * because once several shifts are being settled at once something has to
 * summarise the refusals — and the only alternative was to group them by
 * comparing their wording, which breaks the first time somebody improves a
 * word. One classifier, two readers.
 */
export type SealBlock = 'already-settled' | 'still-open';

export function sealBlock(shift: LockableShift): SealBlock | null {
  if (isSealed(shift)) return 'already-settled';
  /*
   * Not a house rule: a shift still open has not finished happening. Sealing
   * it would stop the till taking money against a night that has not stopped
   * trading, and the first person to notice would be a cashier at eleven at
   * night with a customer waiting.
   */
  if (shift.status !== 'closed') return 'still-open';
  return null;
}

/** Why this shift cannot be sealed yet, in the words somebody reads. */
export function sealProblem(shift: LockableShift): string | null {
  switch (sealBlock(shift)) {
    case 'already-settled':
      return `${shift.code ?? 'That shift'} is already settled.`;
    case 'still-open':
      return `${shift.code ?? 'That shift'} is still open. Close it from the till first — a shift that has not `
        + 'finished trading cannot be settled.';
    default:
      return null;
  }
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

/* ------------------------------------------------------------ several at once */

/**
 * SETTLING A BACKLOG, which is the state this actually gets used in.
 *
 * One at a time is the right shape for a night somebody has just checked. It
 * is the wrong shape for a fortnight of them: four nights closed, balanced,
 * and none of them settled means four modals, four reasons typed, four waits —
 * so in practice nobody does it, the backlog grows, and the one thing settling
 * was for (a figure that cannot quietly change after somebody has read it)
 * stops being true of the whole month.
 *
 * Nothing about the rule changes in bulk. Each shift is still asked the same
 * question it would be asked alone, and the answers are kept per shift rather
 * than collapsed into one — because the half that could not be settled is the
 * half somebody has to do something about.
 */

/** A shift as bulk settling needs it: its identity, and when it stopped. */
export interface SealCandidate extends LockableShift {
  $id: string;
  closed_at?: string;
  opened_at?: string;
}

export interface SealRefusal<T extends SealCandidate> {
  shift: T;
  block: SealBlock;
  why: string;
}

export interface BulkSealPlan<T extends SealCandidate> {
  /** In the order they will be settled. */
  ready: T[];
  refused: SealRefusal<T>[];
}

/**
 * Oldest first, and not for tidiness.
 *
 * If a run stops half way — a connection drops, a write is refused — settling
 * newest first leaves the OLD nights unsettled underneath settled newer ones,
 * which is precisely the "skipped" state the backlog screen shouts about (see
 * shift-backlog). Oldest first means a half-finished run leaves an ordinary
 * shrinking backlog instead of a hole somebody has to go and explain.
 */
export const sealOrder = <T extends SealCandidate>(shifts: T[]): T[] =>
  [...shifts].sort((a, b) =>
    (a.closed_at || a.opened_at || '').localeCompare(b.closed_at || b.opened_at || ''));

/** Split what was ticked into what can be settled and what cannot, with why. */
export function bulkSealPlan<T extends SealCandidate>(shifts: T[]): BulkSealPlan<T> {
  const ready: T[] = [];
  const refused: SealRefusal<T>[] = [];

  for (const shift of shifts) {
    const block = sealBlock(shift);
    // Never inferred twice: the sentence comes from the same place the single
    // settle gets it, so the two screens cannot start refusing in different
    // words.
    if (block) refused.push({ shift, block, why: sealProblem(shift) as string });
    else ready.push(shift);
  }

  return { ready: sealOrder(ready), refused };
}

/**
 * Why this run cannot go ahead at all, or nothing.
 *
 * Only when there is NOTHING to settle. A run with some refusals in it still
 * goes ahead — refusing the whole thing because one of eight shifts is still
 * trading would send somebody back to tick seven boxes again.
 */
export function bulkSealProblem<T extends SealCandidate>(plan: BulkSealPlan<T>): string | null {
  if (plan.ready.length > 0) return null;
  if (plan.refused.length === 0) return 'Tick the shifts you want to settle first.';
  if (plan.refused.length === 1) return plan.refused[0]?.why ?? null;

  const settled = plan.refused.filter((r) => r.block === 'already-settled').length;
  const open = plan.refused.filter((r) => r.block === 'still-open').length;
  const parts: string[] = [];
  if (settled > 0) parts.push(`${settled} ${settled === 1 ? 'is' : 'are'} settled already`);
  if (open > 0) parts.push(`${open} ${open === 1 ? 'is' : 'are'} still trading`);
  return `None of those can be settled: ${parts.join(', and ')}.`;
}

/** What the confirmation says before anything is written. */
export function bulkSealWords<T extends SealCandidate>(plan: BulkSealPlan<T>): string {
  const n = plan.ready.length;
  const head = `${n} ${n === 1 ? 'shift' : 'shifts'} will be settled. Their close times, orders, payments and `
    + 'spending can no longer be changed.';
  if (plan.refused.length === 0) return head;
  const r = plan.refused.length;
  return `${head} The other ${r} ${r === 1 ? 'is' : 'are'} left alone.`;
}

/** One shift's turn, once it has been tried. */
export interface SealResult {
  code: string;
  ok: boolean;
  why?: string;
}

/**
 * What to say afterwards — and this is the part worth getting right.
 *
 * A run of eight that settled six is NOT "settled". Reporting a bulk action as
 * done when part of it failed is how somebody closes the screen believing a
 * month is finished, and finds out in November. So the two that failed are
 * NAMED, not counted: a count sends somebody hunting through a list, whereas
 * the code is the thing they need in order to go and look.
 */
export function bulkSealOutcome(results: SealResult[]): { message: string; tone: 'ok' | 'err' } {
  const done = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    const n = done.length;
    return { message: `${n} ${n === 1 ? 'shift is' : 'shifts are'} settled.`, tone: 'ok' };
  }

  const names = failed.map((r) => r.code).join(', ');
  // One reason where they all failed the same way, so the commonest case reads
  // as a sentence rather than as the same clause repeated five times.
  const reasons = [...new Set(failed.map((r) => r.why).filter(Boolean))];
  const because = reasons.length === 1 ? ` ${reasons[0]}` : '';

  if (done.length === 0) {
    return {
      message: `Nothing was settled. ${names} could not be.${because}`,
      tone: 'err',
    };
  }
  return {
    message: `${done.length} of ${results.length} settled. ${names} ${failed.length === 1 ? 'was' : 'were'} `
      + `not.${because} Those are still open to corrections.`,
    tone: 'err',
  };
}
