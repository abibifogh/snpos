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

/** The sentence to show somebody standing at the till. */
export function shiftAgeMessage(age: ShiftAge, maxHours: number = SHIFT_MAX_HOURS): string {
  if (age.over) {
    return (
      `This shift has been open for ${Math.floor(age.hours)} hours. Nothing new can be started on it. ` +
      `Settle whatever is still open, count the drawer, close it, then open a fresh one.`
    );
  }
  if (age.warning) {
    return (
      `This shift has been open for ${Math.floor(age.hours)} hours. It stops accepting new sales at ` +
      `${maxHours} hours, so close it before then.`
    );
  }
  return '';
}
