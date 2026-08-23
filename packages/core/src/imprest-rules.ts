/**
 * A petty cash box run on the imprest system.
 *
 * The idea is older than any of this and is worth stating plainly, because the
 * whole file follows from it: a box is set at a FIXED amount, money is spent
 * out of it against receipts, and it is topped back up by exactly what was
 * spent. At any moment the cash in the box plus the receipts held should come
 * to the fixed amount. That one identity is what makes a petty cash box
 * checkable at all — an ordinary float has no such property, so a shortage in
 * it can only be noticed by somebody who happens to remember what was there.
 *
 * Two decisions here shape everything else.
 *
 * THE BALANCE IS THE SUM OF THE MOVEMENTS, never a stored figure that gets
 * adjusted. A running total kept as a field drifts the first time a write half
 * fails, and once it has drifted nothing in the system can tell you so. Summed
 * from the movements it cannot be wrong; it can only be incomplete, and an
 * incomplete list is visible.
 *
 * THE EXPECTED CASH IS NOT ASSUMED TO BE THE FIXED AMOUNT. In the textbook the
 * box is always restored to its level, so expected cash is "fixed minus
 * receipts". In a real kitchen somebody tops up half of it on a Friday because
 * that is what was in the safe. Deriving expected from what actually went in
 * and out describes both cases; assuming the textbook describes only one, and
 * reports a shortage every time reality differs from it.
 *
 * Pure. Nothing here reads or writes.
 */

/** What a movement in or out of the box was for. */
export type ImprestKind = 'top_up' | 'spend' | 'adjust' | 'return';

export const IMPREST_KIND_LABELS: Record<ImprestKind, string> = {
  top_up: 'Topped up',
  spend: 'Spent',
  adjust: 'Counted',
  return: 'Returned',
};

export interface ImprestMovement {
  /** Signed minor units. Positive into the box, negative out of it. */
  amount: number;
  kind: ImprestKind;
  occurred_at?: string;
}

export interface ImprestFloat {
  $id: string;
  name: string;
  /** What the box is meant to hold when it is full, in minor units. */
  fixed_amount: number;
  account_code?: string;
  custodian_id?: string;
  active?: boolean;
}

/**
 * What should be in the box, from what actually went in and out of it.
 *
 * Deliberately not `fixed_amount - spending`. See the note at the top: a box
 * topped up by half on a Friday is normal, and the textbook figure would call
 * it short by the other half every day until somebody found the money to
 * finish the job.
 */
export const boxBalance = (movements: ImprestMovement[]): number =>
  movements.reduce((sum, m) => sum + m.amount, 0);

/** What has been spent out of the box since a given moment. Always positive. */
export function spentSince(movements: ImprestMovement[], sinceIso?: string): number {
  return movements
    .filter((m) => m.kind === 'spend')
    .filter((m) => !sinceIso || (m.occurred_at ?? '') >= sinceIso)
    .reduce((sum, m) => sum + Math.abs(m.amount), 0);
}

/**
 * The gap between the box and its level, which is what a top-up is for.
 *
 * Never negative. A box holding more than its fixed amount does not need
 * topping up by a negative number; it needs money taking out of it, which is a
 * different act with a different name — see `overBy`.
 */
export const topUpNeeded = (fixedAmount: number, balance: number): number =>
  Math.max(0, fixedAmount - balance);

/** And the other direction: money sitting in a box that should not hold it. */
export const overBy = (fixedAmount: number, balance: number): number =>
  Math.max(0, balance - fixedAmount);

/**
 * How low a box may run before it is worth saying so, in basis points.
 *
 * A quarter left. Low enough not to nag at a box that is simply being used,
 * high enough that somebody hears about it before the morning a cook is sent
 * to the market and there is nothing to send them with.
 */
export const IMPREST_LOW_BP = 2_500;

export type ImprestHealth = 'ok' | 'low' | 'empty' | 'over';

export function healthOf(fixedAmount: number, balance: number): ImprestHealth {
  if (balance <= 0) return 'empty';
  if (balance > fixedAmount) return 'over';
  if (fixedAmount > 0 && balance * 10_000 <= fixedAmount * IMPREST_LOW_BP) return 'low';
  return 'ok';
}

export interface CountResult {
  /** What the movements say should be there. */
  expected: number;
  counted: number;
  /** Counted minus expected. Negative is short, which is the usual direction. */
  variance: number;
  /** What it would take to restore the box to its level, after the count. */
  toRestore: number;
}

/**
 * A count of the box, worked out.
 *
 * The variance is measured against the movements rather than against the fixed
 * amount, and the restore figure against the fixed amount rather than the
 * movements. Those are two different questions — "is any money missing" and
 * "how much do I put back in" — and answering both with one number is what
 * makes petty cash arguments unresolvable.
 */
export function countBox(opts: {
  fixedAmount: number;
  balance: number;
  counted: number;
}): CountResult {
  const variance = opts.counted - opts.balance;
  return {
    expected: opts.balance,
    counted: opts.counted,
    variance,
    // From what is actually there once the count is believed, not from what
    // the book said a moment ago.
    toRestore: Math.max(0, opts.fixedAmount - opts.counted),
  };
}

/**
 * Why this count cannot be saved, or nothing.
 *
 * A blank is not a nought, the same rule the shelf counts follow. Saving one
 * would write the box down to empty and post the whole float to cash short,
 * which is a serious accusation to make out of an unanswered box.
 */
export function countProblem(countedText: string): string | null {
  const raw = (countedText ?? '').trim();
  if (raw === '') return 'Count the box and enter what is in it. A blank is not the same as nothing.';
  /*
    The minus is read before the digits are cleaned, not after.

    Stripping everything that is not a digit turns "-5" into "5" — it does not
    reject the entry, it silently records the opposite of what somebody typed.
    A box cannot hold less than nothing, so a minus here is always a slip, and
    a slip that saves quietly is worse than one that is refused.
  */
  if (raw.startsWith('-')) return 'A box cannot hold less than nothing.';
  const n = Number(raw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return 'That is not an amount.';
  if (n < 0) return 'A box cannot hold less than nothing.';
  return null;
}

/**
 * Whether a difference is big enough to need saying out loud.
 *
 * Petty cash is petty: a box is out by small change all the time, somebody
 * rounds a taxi fare, a coin goes down the back of a drawer. A threshold that
 * fires on any difference fires every week and teaches people to type anything
 * in the box to make it stop.
 */
export const IMPREST_TOLERANCE = 1_000;

export function needsExplaining(variance: number, tolerance = IMPREST_TOLERANCE): boolean {
  return Math.abs(variance) > tolerance;
}

/**
 * A box spending more than it holds.
 *
 * Warned about, not refused, and that is a change of mind worth recording.
 * The refusal that used to live here was the right instinct and the wrong
 * behaviour: a box CAN legitimately go under, because somebody makes up the
 * difference out of their own pocket and is owed it back, and a system that
 * cannot record what really happened gets worked around rather than corrected.
 *
 * An overdrawn box is visible on its own screen and fails its next count, so
 * nothing is hidden by allowing it. Blocking it hid the truth instead.
 *
 * Named for the box: `overdrawn` belongs to stock locations already, and two
 * exports with one name in a package everything imports from is a collision
 * waiting for whichever file compiles second.
 */
export const boxOverdrawn = (amount: number, balance: number): boolean => amount > balance;

/* ------------------------------------------- what belongs to which count */

export interface CountedPeriod {
  /** The moment the previous count closed. Absent means from the beginning. */
  covers_from?: string;
  counted_at?: string;
  $createdAt?: string;
}

const whenOf = (m: { occurred_at?: string; $createdAt?: string }): string =>
  m.occurred_at ?? m.$createdAt ?? '';

/**
 * The movements one count was settling.
 *
 * A count is not just a number; it is a line drawn under everything that had
 * happened up to then. Once it is made, those movements have been accounted
 * for and reading them alongside this week's is what makes the list useless —
 * a box counted every Friday shows a year of history on one screen, and the
 * six things that have happened since Friday are lost in it.
 *
 * The window is the PREVIOUS count's moment to this one's. Held as a pair of
 * timestamps rather than stamped onto each movement: a movement is a statement
 * that money moved and nothing about it changes when somebody counts, so
 * writing to forty rows to record a fact about one is forty chances to half
 * finish the job.
 */
export function movementsFor<T extends { occurred_at?: string; $createdAt?: string }>(
  movements: T[],
  count: CountedPeriod,
): T[] {
  const to = count.counted_at ?? count.$createdAt ?? '';
  const from = count.covers_from ?? '';
  return movements.filter((m) => {
    const at = whenOf(m);
    if (!at || (to && at > to)) return false;
    return !from || at > from;
  });
}

/**
 * What has happened since the box was last counted.
 *
 * The only list that is actually live. Everything older belongs to a count and
 * is read there.
 */
export function movementsSince<T extends { occurred_at?: string; $createdAt?: string }>(
  movements: T[],
  counts: CountedPeriod[],
): T[] {
  const last = latestCount(counts);
  const after = last?.counted_at ?? last?.$createdAt ?? '';
  return after ? movements.filter((m) => whenOf(m) > after) : movements;
}

/** The most recent count, by when it was made rather than when it was written. */
export function latestCount<T extends CountedPeriod>(counts: T[]): T | null {
  let best: T | null = null;
  for (const c of counts) {
    const at = c.counted_at ?? c.$createdAt ?? '';
    const bestAt = best?.counted_at ?? best?.$createdAt ?? '';
    if (!best || at > bestAt) best = c;
  }
  return best;
}

/**
 * Where a new count's window starts.
 *
 * The last count's moment, or nothing at all for the first one — which
 * deliberately sweeps up everything that has ever happened to the box,
 * including the top-up that opened it. A first count whose window began
 * "now" would show as covering no movements at all, which is the opposite
 * of true.
 */
export const coversFrom = (counts: CountedPeriod[]): string =>
  latestCount(counts)?.counted_at ?? latestCount(counts)?.$createdAt ?? '';

/* --------------------------------------------- who may do what with a box */

export interface BoxHolder {
  $id?: string;
  role?: string;
  can_fund_petty_cash?: boolean;
}

export interface HeldBox {
  custodian_id?: string;
}

/**
 * Whether this person holds this box.
 *
 * Matched on the staff profile's own id, which is what the custodian picker
 * writes. Not on a name: two people share one often enough, and a box is a
 * responsibility with somebody's name on it — attaching it to the wrong person
 * attaches a shortage to them too.
 */
export const holdsBox = (who: BoxHolder | null, box: HeldBox): boolean =>
  !!who?.$id && !!box.custodian_id && box.custodian_id === who.$id;

/**
 * Who may put money into a box, take it out, or set one up.
 *
 * Deliberately NOT the person who holds it, and this is the one real control
 * in the whole feature. Recording a top-up credits the till's cash and debits
 * the box, so a custodian who could invent one could top their own box back up
 * on paper and a shortage would never appear at the count. Separating "holds
 * the money" from "decides how much money it holds" is the entire reason an
 * imprest system is trusted at all.
 *
 * An owner can hand it to somebody by name — see `can_fund_petty_cash` — which
 * is how a manager who genuinely does the handing over gets to record it.
 * Nobody has it by role except an admin.
 */
export const canFundBoxes = (who: BoxHolder | null): boolean =>
  who?.role === 'admin' || who?.can_fund_petty_cash === true;

/**
 * Whether somebody may spend from a box and count it.
 *
 * The custodian's job, and the job the page exists for. Anybody who may fund
 * boxes may also use them: an owner is not locked out of their own tin.
 */
export const canUseBox = (who: BoxHolder | null, box: HeldBox): boolean =>
  canFundBoxes(who) || holdsBox(who, box);

/**
 * The boxes to put in front of somebody.
 *
 * A custodian sees the box they hold and no others. It is not a secret that
 * the office keeps a tin, but a list of every box in the building with its
 * balance is somebody else's business — and a screen offering four boxes to a
 * person responsible for one is a screen where the wrong one gets counted.
 *
 * Anybody who may fund boxes sees all of them, because setting one up and
 * moving money between them cannot be done from a list that hides most.
 */
export function boxesFor<T extends HeldBox>(who: BoxHolder | null, boxes: T[]): T[] {
  if (canFundBoxes(who)) return boxes;
  return boxes.filter((b) => holdsBox(who, b));
}

/**
 * Whether the person holding a box may count it themselves.
 *
 * No, unless an admin says otherwise, and for the same reason funding is not
 * theirs: a count is the check ON the custodian, and somebody checking their
 * own work can make a shortage disappear by typing the expected figure into
 * the box. The count is the only moment the imprest system actually catches
 * anything, and it catches nothing when the person answerable for the money is
 * the person who answers it.
 *
 * There are real places where the custodian is the only person who ever sees
 * the tin — a one-manager business, a site nobody visits daily — and refusing
 * outright would mean the box never gets counted at all, which is worse than
 * counting it imperfectly. So an admin can turn it on, and it is off until
 * they do.
 *
 * Anybody who may FUND boxes may always count them: they are not the custodian
 * in the sense this is guarding against.
 */
export const canCountBox = (
  who: BoxHolder | null,
  box: HeldBox,
  settings?: { imprest_custodian_counts?: boolean } | null,
): boolean => {
  if (canFundBoxes(who)) return true;
  if (!holdsBox(who, box)) return false;
  return settings?.imprest_custodian_counts === true;
};

/** Said where the button would have been, so a missing one is not a mystery. */
export const WHY_NO_COUNT =
  'Counting this box is somebody else\'s job — a count is the check on whoever holds it, and it catches nothing '
  + 'when the same person makes it. An admin can allow it under Settings if there is nobody else to count.';

/** What to tell somebody the page has nothing for. */
export const NO_BOX_HELD =
  'No petty cash box is assigned to you. An admin assigns one under Money, Petty cash, by setting you as who '
  + 'holds it.';

/**
 * Spends out of the box with nothing to show for them.
 *
 * The question somebody asks when reconciling, and the reason a box is run on
 * receipts at all: the count says the money is gone, and only the paper says
 * what for. A box that balances perfectly with no receipts behind it has
 * proved nothing except that somebody can subtract.
 *
 * Only spends. A top-up is a transfer between two places the business already
 * owns — there is no third party to have issued a receipt for it, and counting
 * those as missing would report every funded box as half undocumented.
 */
export function withoutReceipt<T extends { kind: ImprestKind; ref_type?: string; ref_id?: string }>(
  movements: T[],
  receiptFor: Record<string, string>,
): T[] {
  return movements.filter(
    (m) => m.kind === 'spend' && (!m.ref_id || m.ref_type !== 'expense' || !receiptFor[m.ref_id]),
  );
}

/** The movement in one sentence, for a list and for the audit log alike. */
export function describeMovement(m: ImprestMovement & { note?: string }): string {
  const label = IMPREST_KIND_LABELS[m.kind] ?? 'Moved';
  const sign = m.amount >= 0 ? 'in' : 'out';
  return `${label}, ${sign}${m.note ? `: ${m.note}` : ''}`;
}

/* ----------------------- keeping a box in step with the expense that moved it */

/**
 * What has to be written so a box's record matches what an expense now says.
 *
 * An expense can be corrected long after it was recorded, and every part of it
 * that a box cares about can change: the amount, which box paid, or whether it
 * came out of a box at all rather than the drawer. The box does not follow on
 * its own — a movement is a statement that money moved, and the ones already
 * written stay written.
 *
 * So the difference is worked out and written as its own movement, the way a
 * correction is made to anything else here. Three cases fall out of one
 * subtraction:
 *
 *   - nothing recorded yet, and a box now: the spend itself.
 *   - the amount or the box changed: an adjustment for the difference, and on
 *     the old box an adjustment that puts back everything it was charged.
 *   - no longer a box spend at all: the whole amount goes back.
 *
 * Idempotent, which is the property that matters. Saving the same expense
 * twice, or a page retried on a bad connection, produces no corrections the
 * second time — because the second time there is no difference to correct.
 *
 * Amounts are signed as movements are: negative out of the box.
 */
export function spendCorrections(
  movements: { float_id: string; amount: number }[],
  want: { boxId: string | null; amount: number },
): { floatId: string; amount: number; kind: 'spend' | 'adjust' }[] {
  const already: Record<string, number> = {};
  for (const m of movements) already[m.float_id] = (already[m.float_id] ?? 0) + m.amount;

  const wanted: Record<string, number> = {};
  // Out of the box, so negative — and never the other sign, whatever an
  // amount typed with a minus in front of it says.
  if (want.boxId) wanted[want.boxId] = -Math.abs(want.amount);

  const out: { floatId: string; amount: number; kind: 'spend' | 'adjust' }[] = [];
  for (const floatId of new Set([...Object.keys(already), ...Object.keys(wanted)])) {
    const delta = (wanted[floatId] ?? 0) - (already[floatId] ?? 0);
    if (delta === 0) continue;
    out.push({
      floatId,
      amount: delta,
      // The first movement against a box is the spend. Anything after it is a
      // correction to a spend already recorded, and reads as one.
      kind: already[floatId] === undefined ? 'spend' : 'adjust',
    });
  }
  return out;
}
