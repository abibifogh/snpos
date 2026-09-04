/**
 * Shifts that were closed and never settled.
 *
 * Closing a shift says what was counted. Settling it says somebody has looked
 * at that and agreed to it, and it is the point at which a night stops being
 * editable. A shift that is closed and never settled is a night nobody has
 * checked, and nothing on the list said so — every closed row looked exactly
 * like every other closed row, so the only way to find one was to remember.
 *
 * THE RULE THAT WAS SUGGESTED, AND WHY IT IS NOT THE ONE USED.
 *
 * The suggestion was: if the shift before AND after are settled, flag the one
 * in the middle. That catches a real and nasty case — a night jumped over
 * while the ones on either side were dealt with — and it is a case worth
 * naming on its own.
 *
 * But it is silent on the commonest backlog there is. When somebody stops
 * settling for a fortnight, nothing AFTER those shifts is settled either, so
 * the rule finds nothing at all — on exactly the fortnight it was wanted for.
 * It is a rule that works until it matters.
 *
 * So the rule is the simpler one: a closed shift that is not settled is
 * OUTSTANDING, always, and age decides how loudly to say it. The jumped-over
 * case is then a stronger reading of the same fact and keeps its own name,
 * because "you skipped this one" and "you are a fortnight behind" are two
 * different conversations with two different fixes.
 *
 * Pure. Imports nothing at runtime.
 */

/** A shift, as far as this question is concerned. */
export interface BacklogShift {
  $id: string;
  code?: string;
  status?: string;
  closed_at?: string;
  opened_at?: string;
  $createdAt?: string;
  /** Set when somebody settled it. See shift-lock. */
  locked_at?: string | null;
  /** Which side of the business. Absent is the kitchen. */
  module?: string;
}

export type BacklogState =
  /** Still trading. Nothing to settle yet. */
  | 'open'
  /** Closed and settled. Done. */
  | 'settled'
  /** Closed, not settled, and closed recently enough to be somebody's evening. */
  | 'waiting'
  /** Closed, not settled, and old enough that it has been forgotten. */
  | 'overdue'
  /** Closed, not settled, and later shifts on the same side HAVE been settled. */
  | 'skipped';

/**
 * How long a closed shift may sit before it is called overdue.
 *
 * Thirty-six hours. A shift closed at midnight is not a problem at nine the
 * next morning, and flagging it red would put a warning on the screen every
 * single day — which is how a warning stops being read by the time it means
 * something. By the end of the following day, nobody is coming back to it on
 * their own.
 */
export const SETTLE_GRACE_MS = 36 * 60 * 60 * 1000;

/** When a shift stopped trading, whatever it recorded that as. */
export const closedAt = (s: BacklogShift): string =>
  s.closed_at || s.opened_at || s.$createdAt || '';

export const isSettledShift = (s: BacklogShift): boolean => !!s.locked_at;

/** A shift that has finished trading and can therefore be settled. */
export const isClosedShift = (s: BacklogShift): boolean =>
  (s.status === 'closed' || s.status === 'reopened') && !!closedAt(s);

/**
 * What this shift is, given everything else on its side of the business.
 *
 * The side matters. A bar and a kitchen are settled by different people on
 * different days, and a kitchen night is not "skipped" because somebody
 * settled the bar after it.
 */
export function backlogState(
  shift: BacklogShift,
  all: BacklogShift[],
  now = Date.now(),
  graceMs = SETTLE_GRACE_MS,
): BacklogState {
  if (!isClosedShift(shift)) return 'open';
  if (isSettledShift(shift)) return 'settled';

  const side = shift.module ?? 'kitchen';
  const mine = closedAt(shift);

  /*
    Jumped over: something on this side closed LATER and has been settled.
    That is not a backlog — somebody was working through the list and this one
    was passed. It is the case the suggestion was about, and it stays.
  */
  const laterSettled = all.some(
    (s) => (s.module ?? 'kitchen') === side
      && s.$id !== shift.$id
      && isSettledShift(s)
      && closedAt(s) > mine,
  );
  if (laterSettled) return 'skipped';

  const age = now - Date.parse(mine);
  return Number.isFinite(age) && age > graceMs ? 'overdue' : 'waiting';
}

/** Is this one of the states that should be shown at the top, in red? */
export const needsSettling = (state: BacklogState): boolean =>
  state === 'overdue' || state === 'skipped';

export interface BacklogRow<T extends BacklogShift> {
  shift: T;
  state: BacklogState;
  /** How long it has been sitting closed. Negative is never shown. */
  ageMs: number;
}

/**
 * Everything closed and unsettled, worst first.
 *
 * Skipped before overdue before waiting, and oldest first inside each. A list
 * ordered by date alone buries the one shift somebody jumped over behind a
 * fortnight of ordinary backlog, which is the row that most needs a person to
 * look at it.
 */
export function settlementBacklog<T extends BacklogShift>(
  shifts: T[],
  now = Date.now(),
  graceMs = SETTLE_GRACE_MS,
): BacklogRow<T>[] {
  const rank: Record<string, number> = { skipped: 0, overdue: 1, waiting: 2 };
  return shifts
    .map((shift) => ({
      shift,
      state: backlogState(shift, shifts, now, graceMs),
      ageMs: Math.max(0, now - Date.parse(closedAt(shift))),
    }))
    .filter((r) => r.state === 'skipped' || r.state === 'overdue' || r.state === 'waiting')
    .sort((a, b) => (rank[a.state] - rank[b.state])
      || closedAt(a.shift).localeCompare(closedAt(b.shift)));
}

/** How long it has been, in the words somebody would use. */
export function agedWords(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** What to say on one row, which is not the same sentence for each state. */
export function stateWords(row: BacklogRow<BacklogShift>): string {
  switch (row.state) {
    case 'skipped':
      return `Closed ${agedWords(row.ageMs)} ago and never settled, and shifts that closed AFTER it have `
        + 'been. This one was passed over rather than simply not reached yet.';
    case 'overdue':
      return `Closed ${agedWords(row.ageMs)} ago and still not settled. Nobody has agreed what this night `
        + 'took.';
    default:
      return `Closed ${agedWords(row.ageMs)} ago. Not settled yet, which is normal this soon.`;
  }
}

/** The one line at the top, so it is seen without reading the table. */
export function backlogSummary(rows: BacklogRow<BacklogShift>[]): string | null {
  const skipped = rows.filter((r) => r.state === 'skipped').length;
  const overdue = rows.filter((r) => r.state === 'overdue').length;
  if (skipped + overdue === 0) return null;

  const oldest = rows.find((r) => r.state === 'skipped' || r.state === 'overdue');
  const parts: string[] = [];
  if (skipped > 0) {
    parts.push(`${skipped} ${skipped === 1 ? 'was' : 'were'} passed over while later shifts were settled`);
  }
  if (overdue > 0) {
    parts.push(`${overdue} ${overdue === 1 ? 'has' : 'have'} been sitting closed too long`);
  }

  const total = skipped + overdue;
  return `${total} ${total === 1 ? 'shift is' : 'shifts are'} closed and not settled: ${parts.join(', and ')}. `
    + `The oldest has been waiting ${agedWords(oldest?.ageMs ?? 0)}. Until a shift is settled nobody has `
    + 'agreed what it took, and it can still be changed.';
}

/** And the reassuring version, which is worth saying so the absence means something. */
export function allSettledWords(rows: BacklogRow<BacklogShift>[], closedCount: number): string | null {
  if (closedCount === 0) return null;
  return rows.every((r) => r.state === 'waiting') && rows.length === 0
    ? 'Every closed shift in this range has been settled.'
    : null;
}
