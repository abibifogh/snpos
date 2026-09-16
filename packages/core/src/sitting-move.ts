/**
 * Moving a sitting to a different hour.
 *
 * A group books four sittings, the party's coach is late, and Thursday lunch
 * needs to be Thursday dinner. Until now that could not be done by anybody:
 * the guest cannot edit an order — they never could, and a link that let
 * anybody holding it re-time a pass would be worse than the problem — and
 * Admin had no screen for it either. So the only way to move a sitting was to
 * cancel the booking and have the party order the whole thing again, which
 * loses every choice, every omission and every note they typed, and gives the
 * kitchen a different set of order numbers for the same party.
 *
 * WHAT MAY BE MOVED IS NARROW ON PURPOSE. A sitting the kitchen has not been
 * shown yet is a plan, and a plan can be changed. Once it has been released to
 * the pass somebody is cooking it, and the clock on the ticket is no longer a
 * statement of intent — it is what the food is being timed against. Changing
 * it then does not move the meal, it just makes the screen lie about a pan
 * that is already on.
 *
 * Pure. Parameters are described by the fields they read, so this file imports
 * nothing at runtime and the rules can be checked without a database.
 */

/** The fields of an order this needs to see. */
export interface Sitting {
  $id: string;
  order_no?: string;
  status: string;
  /** When the party eats. */
  scheduled_for?: string;
  /** When the kitchen must start, for it to be ready then. */
  fire_at?: string;
  preorder_seat_id?: string;
}

/**
 * The one status a sitting may be moved in.
 *
 * SCHEDULED means the ticket is waiting and no kitchen screen has shown it.
 * Everything after it — PENDING onwards — means the pass has it.
 */
export const MOVABLE = 'SCHEDULED';

/**
 * How far ahead a sitting may be moved: a typo guard, not a booking policy.
 *
 * Generous on purpose. Anything a restaurant would really book falls well
 * inside it, so this only ever catches a wrong year.
 */
export const MOVE_LIMIT_YEARS = 2;
const MOVE_LIMIT_MS = MOVE_LIMIT_YEARS * 365 * 86_400_000;

/** Already off. Not a refusal to move it, there is nothing there to move. */
const OFF = ['CANCELLED', 'REJECTED'];

/** Whether this sitting is still a plan rather than a pan. */
export const sittingIsMovable = (s: Sitting): boolean => s.status === MOVABLE;

/**
 * How long before service this order's kitchen starts, in milliseconds.
 *
 * Taken from the order rather than worked out again from today's dishes, and
 * that is the whole point. The order already recorded how long its own food
 * needs — the prep times as they were when it was placed — and a dish whose
 * prep time has been edited since must not silently re-time a booking that
 * was quoted under the old one. Moving a sitting moves it: the gap it was
 * given is the gap it keeps.
 */
export function leadMs(s: Sitting): number {
  if (!s.scheduled_for || !s.fire_at) return 0;
  const gap = Date.parse(s.scheduled_for) - Date.parse(s.fire_at);
  return Number.isFinite(gap) && gap > 0 ? gap : 0;
}

/** When the kitchen would have to start, were this sitting moved to `to`. */
export const fireAtFor = (s: Sitting, to: Date): Date => new Date(to.getTime() - leadMs(s));

/**
 * Why this sitting cannot go to that time, in a sentence, or null if it can.
 *
 * Every one of these is a real refusal rather than a warning, and each says
 * what is in the way rather than that something is. "That cannot be done" sends
 * somebody to the phone; "the kitchen would have had to start at half past
 * two" tells them to pick a later hour, which is the thing they were going to
 * ask.
 */
export function sittingMoveProblem(opts: {
  sitting: Sitting;
  to: Date | null;
  now?: Date;
}): string | null {
  const { sitting, to } = opts;
  const now = opts.now ?? new Date();

  if (OFF.includes(sitting.status)) return 'That sitting is already off. There is nothing to move.';
  if (!sittingIsMovable(sitting)) {
    return 'The kitchen already has that sitting, so its time cannot be changed here. '
      + 'Cancel it and take the new time as a fresh order, or speak to the pass.';
  }
  if (!to || Number.isNaN(to.getTime())) return 'Pick a date and a time to move it to.';

  if (to.getTime() <= now.getTime()) return 'That time has already passed. Pick a later one.';

  /*
    The real constraint, and the one nobody thinks of: not when the party eats
    but when somebody has to light the stove. A sitting moved to twenty minutes
    from now, for food that takes forty-five, is a booking the kitchen was
    already too late for at the moment it was made.
  */
  const fire = fireAtFor(sitting, to);
  if (fire.getTime() <= now.getTime()) {
    const when = fire.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `The kitchen would have had to start at ${when} for that. Pick a later time.`;
  }

  /*
    A mistyped year, and nothing else.

    This is NOT the pre-order window. That limit — seven days, or whatever the
    picker is set to — exists to stop a walk-in guest booking a collection
    months out, and applying it here blocked every real move: a group books
    weeks ahead by definition, the sitting is ALREADY in the diary at that
    date, and re-timing something already accepted is not the same act as
    accepting something new. It refused a party of 195 whose October sittings
    were sitting right there on the screen, and the reason it gave was about a
    rule that had nothing to do with them.

    What is worth catching is 2126 typed for 2026 in a date box, which is one
    keystroke and silently puts a booking a century out. So: a bound no real
    booking will ever reach, and it says to check the year rather than quoting
    a policy.
  */
  if (to.getTime() - now.getTime() > MOVE_LIMIT_MS) {
    return `That is more than ${MOVE_LIMIT_YEARS} years away. Check the year.`;
  }

  if (sitting.scheduled_for && Math.abs(Date.parse(sitting.scheduled_for) - to.getTime()) < 60_000) {
    return 'That is the time it is already booked for.';
  }

  return null;
}

/**
 * The first and last sitting of a booking, from the sittings themselves.
 *
 * The booking row carries these two so a list can be sorted and a notice can
 * say when the party arrives, and moving a sitting can change either — move
 * the only Tuesday to Friday and the booking now starts on Wednesday. Working
 * them out from the orders rather than nudging the stored pair means the row
 * cannot drift away from the thing it describes, however many moves it takes.
 *
 * Sittings that are off are left out: a cancelled Tuesday is not when this
 * party arrives.
 */
export function spanOf(sittings: Sitting[]): { firstAt: string; lastAt: string } | null {
  const times = sittings
    .filter((s) => !OFF.includes(s.status))
    .map((s) => s.scheduled_for)
    .filter((t): t is string => !!t)
    .sort();
  if (times.length === 0) return null;
  return { firstAt: times[0] as string, lastAt: times[times.length - 1] as string };
}

/** What a move is called in the audit log and on screen. */
export const moveWords = (from?: string, to?: Date): string => {
  const say = (d: Date) => d.toLocaleString([], {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  if (!from || !to) return 'Moved';
  return `Moved from ${say(new Date(from))} to ${say(to)}`;
};
