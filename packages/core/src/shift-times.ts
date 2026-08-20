/**
 * Correcting when a shift ended.
 *
 * The commonest wrong figure in the whole system, and the least sinister. A
 * bar closes at one in the morning and nobody touches the till until eleven;
 * a cook goes home without closing and the manager does it over breakfast. The
 * money was right, the count was right, and the only thing wrong is a
 * timestamp that says the shift ran for fourteen hours and ended on a day it
 * had nothing to do with.
 *
 * That timestamp is not decorative. It decides which day the shift is reported
 * under, and it is one half of the window that says what the shift did — see
 * ordersForShift, which takes an order created inside it OR stamped with the
 * shift, so narrowing the window can drop an unpaid order off the list.
 *
 * What it does NOT decide is money. The takings come from payments stamped
 * with the shift and the count came from a person; neither moves when the
 * clock is corrected, which is what makes this a far safer correction than it
 * first looks. That is worth knowing before anybody is warned about it.
 *
 * Pure. Nothing here reads or writes.
 */

export interface TimedShift {
  code: string;
  status: string;
  opened_at: string;
  closed_at?: string;
}

const ms = (iso?: string): number => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : NaN;
};

/** Whole hours, rounded, for a sentence somebody reads rather than a figure. */
export function hoursBetween(fromIso: string, toIso: string): number {
  const span = ms(toIso) - ms(fromIso);
  if (!Number.isFinite(span)) return 0;
  return Math.round((span / 3_600_000) * 10) / 10;
}

/** Whether two moments fall on the same calendar day, where the business is. */
export function sameDay(a: string, b: string): boolean {
  const x = new Date(ms(a));
  const y = new Date(ms(b));
  if (Number.isNaN(x.getTime()) || Number.isNaN(y.getTime())) return false;
  return x.toDateString() === y.toDateString();
}

/**
 * Why this close time cannot be saved, or nothing.
 *
 * Three refusals, and each one is a statement that could not be true rather
 * than a house rule:
 *
 *   - An open shift has no closing time to correct. Setting one would leave a
 *     shift that claims to have ended while it is still taking money.
 *   - A shift cannot end before it began. Every length, every report window
 *     and every "how long was this" is derived from the pair, and a negative
 *     one produces figures that are not merely wrong but nonsensical.
 *   - A shift cannot have ended in the future, for the same reason nothing
 *     else in the books can.
 *
 * Everything else — an unusually long shift, a close on a different day — is
 * allowed and warned about, because those are exactly the things somebody is
 * here to correct.
 */
export function closeTimeProblem(
  shift: TimedShift,
  closedAt: string,
  now: Date = new Date(),
): string | null {
  const when = ms(closedAt);
  if (!Number.isFinite(when)) return 'That is not a date and time.';
  if (shift.status !== 'closed') {
    return `${shift.code} is still open, so it has no closing time yet. Close it from the till first.`;
  }
  const opened = ms(shift.opened_at);
  if (Number.isFinite(opened) && when < opened) {
    return `${shift.code} opened at ${new Date(opened).toLocaleString()}. A shift cannot end before it began.`;
  }
  if (when > now.getTime()) return 'A shift cannot have closed in the future.';
  return null;
}

export interface CloseTimeEffects {
  /** How long the shift becomes, in hours. */
  hours: number;
  /** True when the correction moves it onto a different calendar day. */
  movesDay: boolean;
  /** True when the window shrinks, which can drop orders off its list. */
  narrows: boolean;
  warnings: string[];
}

/**
 * What changing this will do, said before it is done.
 *
 * Deliberately short on alarm. The money does not move, and telling somebody
 * it might would either stop a correction that should be made or teach them to
 * ignore the warning that matters. Only three things are worth raising, and
 * each is raised only when it is actually true.
 */
export function closeTimeEffects(opts: {
  shift: TimedShift;
  closedAt: string;
  /** The longest a shift is meant to run. See SHIFT_MAX_HOURS. */
  maxHours?: number;
}): CloseTimeEffects {
  const { shift, closedAt, maxHours = 24 } = opts;
  const hours = hoursBetween(shift.opened_at, closedAt);
  const was = shift.closed_at;
  const movesDay = !!was && !sameDay(was, closedAt);
  const narrows = !!was && ms(closedAt) < ms(was);
  const warnings: string[] = [];

  if (movesDay) {
    warnings.push(
      `This moves ${shift.code} onto ${new Date(ms(closedAt)).toLocaleDateString()}, so it is reported under `
      + 'that day instead. Any daily summary already sent for either day was right when it went out and is '
      + 'not sent again.',
    );
  }

  if (narrows) {
    warnings.push(
      'Bringing the close time earlier narrows the window this shift covers. An order that was paid for on '
      + 'this shift stays on it whatever the clock says; one that was never paid for and only fell inside '
      + 'the old window will drop off its list.',
    );
  }

  if (hours > maxHours) {
    warnings.push(
      `That makes ${shift.code} ${hours} hours long, which is over the ${maxHours} a shift is meant to run. `
      + 'Allowed, because a shift somebody forgot to close really did sit open that long — but if you are '
      + 'correcting one of those, the time you want is when the till actually stopped.',
    );
  }

  return { hours, movesDay, narrows, warnings };
}

/** The change in one sentence, for the confirmation and the audit log alike. */
export function describeCloseChange(shift: TimedShift, closedAt: string): string {
  const to = new Date(ms(closedAt)).toLocaleString();
  return shift.closed_at
    ? `${shift.code} closed at ${new Date(ms(shift.closed_at)).toLocaleString()}, corrected to ${to}.`
    : `${shift.code} recorded as closed at ${to}.`;
}
