/**
 * The rules a shift lives by, with nothing to load.
 *
 * Imports nothing on purpose, so the two questions that decide whether a day's
 * cash is traceable, what this shift is called and whether it has been left
 * open too long, can be tested without a database in front of them.
 */

import type { Module } from './access';

/**
 * The letters a shift code starts with.
 *
 * Every shift used to begin with a plain "S", which meant a manager looking at
 * two rows in the shifts list could not tell the restaurant's night from the
 * shop's without opening both. The code is the thing people read out to each
 * other and write on an envelope of cash, so it should say which counter it
 * came from before anything else does.
 */
export const SHIFT_PREFIX: Record<Module, string> = {
  kitchen: 'BIST',
  craft: 'CRAF',
};

export const shiftPrefix = (module?: Module): string => SHIFT_PREFIX[module ?? 'kitchen'] ?? 'BIST';

/**
 * A shift's code: which side, which day, and enough of a tail to be unique.
 *
 * The date is in it because the first question anybody asks about a shift is
 * which night it was, and a code you have to look up to answer that is a code
 * that gets written down wrongly.
 */
export function shiftCode(module?: Module, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${shiftPrefix(module)}${day}-${now.getTime().toString(36).slice(-4)}`;
}

/** Longest a shift may stay open before it has to be closed. */
export const SHIFT_MAX_HOURS = 24;

/** How long before the limit the warning starts. */
export const SHIFT_WARN_HOURS = 20;

export interface ShiftAge {
  /** Hours open, to one decimal place. */
  hours: number;
  /** Past the limit. Nothing more may be sold or taken against it. */
  over: boolean;
  /** Close to the limit. Still working, but say so now. */
  warning: boolean;
  /** Hours left before it stops, floored at zero. */
  hoursLeft: number;
}

/**
 * How long this shift has been open, and what that means.
 *
 * A shift left open overnight quietly ruins every figure that depends on it:
 * yesterday's takings and today's arrive in one drawer, the opening float is a
 * day old, and the variance at the end measures two days of drift as one. The
 * limit is a day, because a day is the longest anybody genuinely works a till,
 * and anything past that is a shift somebody forgot rather than a long night.
 */
export function shiftAge(
  openedAt: string | Date,
  now: Date = new Date(),
  maxHours: number = SHIFT_MAX_HOURS,
): ShiftAge {
  const opened = typeof openedAt === 'string' ? new Date(openedAt) : openedAt;
  const ms = now.getTime() - opened.getTime();
  // An unreadable or future date is not a reason to stop a till. Treat it as
  // just opened; a clock that is wrong is the machine's fault, not the
  // cashier's, and blocking sales over it would be the worse failure.
  const hours = Number.isFinite(ms) && ms > 0 ? Math.round((ms / 3_600_000) * 10) / 10 : 0;
  return {
    hours,
    over: hours >= maxHours,
    warning: hours >= Math.min(SHIFT_WARN_HOURS, maxHours) && hours < maxHours,
    hoursLeft: Math.max(0, Math.round((maxHours - hours) * 10) / 10),
  };
}

/**
 * The sentence to show somebody standing at the till.
 *
 * The two sides stop differently, so they are told differently.
 *
 * A kitchen keeps cooking. A customer is standing there and food is food, so
 * orders are still taken and still made; it is the MONEY that waits, because
 * taking it would file tonight's cash under a night that ended yesterday.
 * Closing the shift releases those orders onto the next one, where they are
 * paid a minute later.
 *
 * A shop counter has nothing to keep doing. A sale is rung up and paid for in
 * one movement, so there is nothing to gain by starting one that cannot be
 * finished, and it stops at the beginning instead.
 */
export function shiftAgeMessage(
  age: ShiftAge,
  maxHours: number = SHIFT_MAX_HOURS,
  module: Module = 'kitchen',
): string {
  const open = `This shift has been open for ${Math.floor(age.hours)} hours.`;

  if (age.over) {
    return module === 'craft'
      ? `${open} Nothing new can be sold on it. Settle whatever is still open, count the drawer, close it, ` +
        'then open a fresh one.'
      : `${open} Orders can still be taken, cooked and paid for. Anything that came in after the day was ` +
        'up belongs to the night before, so close this shift and open a fresh one; anything still unpaid ' +
        'moves across.';
  }
  if (age.warning) {
    return module === 'craft'
      ? `${open} It stops accepting new sales at ${maxHours} hours, so close it before then.`
      : `${open} At ${maxHours} hours anything new starts belonging to the next shift, so close it before ` +
        'then.';
  }
  return '';
}

/**
 * How long a shift has been running, and whether it may still be used.
 *
 * A closed shift is never overdue. It is finished, and how long it stayed open
 * is a question for a report rather than for a banner above a till.
 *
 * This said as much and did the opposite: it measured from `closed_at`,
 * treating the moment a shift ENDED as the moment it started, so a shift closed
 * two days ago reported two days and asked to be closed again. Anywhere a
 * closed shift reached a screen, the warning stayed up after it had been acted
 * on, which is the fastest way to teach somebody to ignore a warning.
 *
 * Here rather than in shifts.ts, which opens a database connection the moment
 * it is imported and so cannot be tested. This needs two dates and no database.
 */
export function shiftAgeOf(
  shift: { opened_at?: string; closed_at?: string } | null | undefined,
  now: Date = new Date(),
  maxHours: number = SHIFT_MAX_HOURS,
): ShiftAge {
  if (!shift?.opened_at || shift.closed_at) return shiftAge(now.toISOString(), now, maxHours);
  return shiftAge(shift.opened_at, now, maxHours);
}

/**
 * Which of the open shifts this side is actually on, and what else is open.
 *
 * A venue is meant to have one open shift per side. It can end up with more:
 * a close that half-finished, two devices opening one within a moment of each
 * other, a night nobody closed followed by a morning somebody opened.
 *
 * Only one was ever returned, and the rest were invisible. Closing the one you
 * could see put the next one on the screen, so the banner came back and the
 * whole thing looked like a close that had not worked, when every close had
 * worked. Nothing anywhere said there were three.
 *
 * Newest first, so the till works with the shift somebody just opened rather
 * than whichever row a database happened to return. Sorted here, in memory:
 * asking the database to sort needs an index it may not have, and a query that
 * throws leaves every screen showing whatever it had before.
 *
 * Filtered by side in memory too, because shifts opened before the two sides
 * existed carry no side at all and a database filter steps straight over them.
 */
export function openShiftsFor<T extends { opened_at?: string; module?: Module }>(
  shifts: T[],
  module: Module = 'kitchen',
): T[] {
  return shifts
    .filter((s) => (s.module ?? 'kitchen') === module)
    .slice()
    .sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? ''));
}

/* ------------------------------------------------- orders past the limit */

/**
 * The moment a shift went past its limit.
 *
 * Everything created after this is work the shift should never have taken. It
 * is real work, though, cooked and handed to somebody, so the question is not
 * whether to keep it but which night it belongs to. The answer is: the next
 * one.
 */
export function overdueFrom(openedAt: string, maxHours: number = SHIFT_MAX_HOURS): string {
  const opened = new Date(openedAt).getTime();
  if (!Number.isFinite(opened)) return '';
  return new Date(opened + maxHours * 3_600_000).toISOString();
}

/**
 * Was this order taken after the shift should have closed?
 *
 * These are the only orders a shift may close over, and they do not close: they
 * are shelved, and the next shift picks them up. That is the whole exception,
 * and it is narrow on purpose.
 *
 * Everything else keeps the ordinary rule. A shift that closes over an unpaid
 * bill loses the money silently, and an exception wide enough to be convenient
 * would be an exception people learn to lean on.
 *
 * ## Both times have to come from the same clock
 *
 * This compared `$createdAt`, which the SERVER writes, against `opened_at`,
 * which the browser writes from the tablet's own clock. Those are two different
 * clocks, and the gap between them is whatever somebody set on the device. A
 * tablet running a day or more behind made every order look late on any shift
 * opened from it, which is exactly what happened: an order moved onto a fresh
 * shift and was still refused, because the fresh shift's "opened_at" was in the
 * tablet's past while the order's "$createdAt" was in the server's present.
 *
 * So the shift's own `$createdAt` is used whenever it is there. Server against
 * server, and a wrong clock on a tablet can no longer decide whether somebody
 * gets to pay for their food. `opened_at` remains the fallback, for the shift
 * rows written before this and for callers that only hold that much.
 */
export function isPastLimit(
  order: { $createdAt?: string },
  shift: { $createdAt?: string; opened_at?: string } | null | undefined,
  maxHours: number = SHIFT_MAX_HOURS,
): boolean {
  const anchor = shift?.$createdAt || shift?.opened_at;
  if (!anchor || !order.$createdAt) return false;
  const cutoff = overdueFrom(anchor, maxHours);
  return cutoff !== '' && order.$createdAt >= cutoff;
}

/**
 * Must this order wait for the next shift before it can be paid?
 *
 * The question the till actually needs answered, and it is not the same as
 * "was this created after the cutoff". That arithmetic describes an order's
 * relationship to ONE shift, and re-running it against whichever shift happens
 * to be loaded gets the wrong answer the moment the order has moved on: an
 * order shelved on Sunday and picked up by Monday's shift is Monday's order,
 * and no sum performed on Monday should be able to decide otherwise.
 *
 * So the record wins over the arithmetic, in this order:
 *
 *   1. It has already been through the shelf. Whatever it once was, it has
 *      been dealt with, and it is an ordinary order from then on.
 *   2. It is stamped with this shift. It belongs here; pay it.
 *   3. Only then, the sum.
 *
 * That ordering is what stops a stale or duplicate open shift, which is a
 * thing that happens, from making an order permanently unpayable. Being wrong
 * towards "pay it" costs a figure landing on the wrong night. Being wrong the
 * other way costs a customer standing at a counter that will not take their
 * money, on any shift, ever.
 */
export function mustWaitForNextShift(
  order: { $createdAt?: string; shift_id?: string; shelved_from_shift?: string },
  shift: { $id?: string; $createdAt?: string; opened_at?: string } | null | undefined,
  maxHours: number = SHIFT_MAX_HOURS,
): boolean {
  if (!shift) return false;
  /**
   * A shift that is not itself overdue never calls anything late.
   *
   * Obvious once written down, and it was missing. A fresh shift had no
   * business judging an order late for a limit it is nowhere near, and this one
   * line would have caught the whole failure on its own.
   */
  if (!shiftAge(shift.opened_at ?? shift.$createdAt ?? '', new Date(), maxHours).over) return false;
  if (order.shelved_from_shift) return false;
  if (shift.$id && order.shift_id && order.shift_id === shift.$id) return false;
  return isPastLimit(order, shift, maxHours);
}

/**
 * Should the till WARN that this order belongs to the night before?
 *
 * The same question as `mustWaitForNextShift`, asked where the answer must not
 * be a locked door.
 *
 * Refusing payment for this was the wrong trade, and it took two customers
 * standing at a counter to see it. What the refusal buys is a figure landing on
 * the right night. What it costs, whenever anything about the judgement is
 * wrong, is somebody who cannot pay for food they have already eaten, with no
 * way round it from any screen. Those are not the same size of problem, and the
 * cheap one has to be the one we accept.
 *
 * So the money is always takeable and the cashier is told. The order still
 * moves to the next shift at the close if nobody settles it, which is where
 * most of the accounting value was in the first place.
 */
export const shouldWarnLateOrder = mustWaitForNextShift;

/**
 * Why one order holds a shift open, if it does.
 *
 * The rule itself, with nothing behind it, so it can be checked without a
 * database. `shiftBlockers` does the reading and asks this the question.
 *
 * A bill that comes to nothing is not an unpaid bill. A staff meal, a comp, a
 * mistake put right with a full discount: nothing is owed and nothing ever
 * will be, so nobody is coming to pay it. Held open over it, the only way to
 * close is to close over the warning — and a warning people are taught to
 * ignore is worse than no warning at all.
 */
export function blockerFor(order: {
  status: string;
  payment_status?: string;
  total?: number;
}): 'unpaid' | 'uncollected' | null {
  const owesNothing = (order.total ?? 0) <= 0;
  if (!owesNothing && order.payment_status !== 'paid') return 'unpaid';
  if (order.status !== 'SERVED') return 'uncollected';
  return null;
}

/* --------------------------------------------------- money already taken in */

/**
 * Does this payment still represent money the business holds?
 *
 * A payment row is never deleted. The shift it was taken in has to keep adding
 * up: a cashier counts the drawer at the end of the night and the system says
 * what it should hold, so removing a row silently changes the answer to a
 * question that was already settled, and the person who counted has no way to
 * see why they are suddenly short. One recorded in error is marked voided and
 * stays where it is.
 *
 * Which means everything that adds money up has to agree to skip it, and that
 * is why this is one predicate rather than the same filter written out at each
 * site. The sites disagreeing is the failure that matters: a voided payment
 * still counted in a drawer's expected takings makes the shift read as OVER by
 * that amount, and somebody gets asked where the extra money went.
 *
 * A row with no status at all is a real payment. The field arrived after the
 * rows did, and reading its absence as "voided" would erase a night's takings.
 */
export const isLivePayment = (p: { status?: string }): boolean =>
  p.status !== 'voided' && p.status !== 'refunded';

/**
 * Why new business cannot be rung up, in words, or null when it can.
 *
 * `shiftAgeMessage` answers a narrower question than it looks like it does: it
 * describes a shift that has been open too long, and returns an empty string
 * for a shift that is fine. Which is correct, and became a bug the moment a
 * caller used it for "can I sell right now" — with NO shift open at all there
 * is no age to describe, so the answer was an empty string, and the till put
 * an empty red box in the corner of the screen. A warning with no words in it
 * is worse than no warning: something visibly went wrong and the person is
 * given nothing to act on.
 *
 * So the two states are separated here. A shift that is too old has a message
 * about closing it; no shift at all has a message about opening one.
 */
export function sellBlockedReason(
  shift: { opened_at?: string; closed_at?: string } | null | undefined,
  module: Module = 'kitchen',
  now: Date = new Date(),
  maxHours: number = SHIFT_MAX_HOURS,
): string | null {
  if (!shift?.opened_at || shift.closed_at) {
    return module === 'craft'
      ? 'No till session is open, so this sale has nowhere to be recorded. Open one from the shift button, then ring it up.'
      : 'No shift is open, so this order has nowhere to be recorded. Open one from the shift button first.';
  }
  const age = shiftAge(shift.opened_at, now, maxHours);
  if (!age.over) return null;
  return shiftAgeMessage(age, maxHours, module);
}
