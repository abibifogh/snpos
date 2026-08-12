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
      : `${open} Orders can still be taken and cooked, but nothing that came in after the day was up can ` +
        'be paid on it. Close the shift and open a fresh one, and those orders move across to be settled ' +
        'there.';
  }
  if (age.warning) {
    return module === 'craft'
      ? `${open} It stops accepting new sales at ${maxHours} hours, so close it before then.`
      : `${open} At ${maxHours} hours it stops taking payment for anything new, so close it before then.`;
  }
  return '';
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
 */
export function isPastLimit(
  order: { $createdAt?: string },
  shift: { opened_at: string } | null | undefined,
  maxHours: number = SHIFT_MAX_HOURS,
): boolean {
  if (!shift?.opened_at || !order.$createdAt) return false;
  const cutoff = overdueFrom(shift.opened_at, maxHours);
  return cutoff !== '' && order.$createdAt >= cutoff;
}
