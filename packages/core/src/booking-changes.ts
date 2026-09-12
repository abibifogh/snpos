/**
 * A group asking for something to be changed.
 *
 * A booking made three weeks out will change. Numbers move, somebody turns
 * vegetarian, a coach arrives an hour late. Until now the only route was to
 * ring the restaurant, which means it lands on whoever picks up and is written
 * on whatever is nearest — and a party of forty whose count changed by six is
 * six meals cooked or six meals short.
 *
 * A request, NOT a change. Nothing here edits an order. The kitchen's tickets
 * are what the kitchen is cooking, and a guest who could quietly rewrite them
 * a day before service could empty a pass without anyone agreeing to it. This
 * is a message, addressed to the people who can decide, with the booking
 * attached to it.
 *
 * Pure. Imports nothing at runtime.
 */

/** How close to the first sitting a change can still be asked for. */
export const CHANGE_CUTOFF_DAYS = 5;

const DAY_MS = 86_400_000;

/** Whole days between now and the first sitting. Negative once it has passed. */
export function daysUntil(firstAt: string | Date, now: Date = new Date()): number {
  const at = firstAt instanceof Date ? firstAt : new Date(firstAt);
  if (!Number.isFinite(at.getTime())) return Number.NaN;
  return Math.floor((at.getTime() - now.getTime()) / DAY_MS);
}

/**
 * Whether this booking can still be changed, and what to say if not.
 *
 * The cutoff is counted from the FIRST sitting, not from each one. A stay is
 * shopped for, prepped and staffed as a whole: by the time the first meal is
 * five days out the order has been placed with suppliers, and moving the
 * fourth night is moving the same shopping.
 *
 * Said as a date rather than as a rule. "Changes had to be in by 9 November"
 * is something somebody can check against their own calendar; "the cutoff is
 * five days" makes them do the arithmetic that this has already done.
 */
export function changeProblem(
  firstAt: string | Date,
  now: Date = new Date(),
  cutoffDays: number = CHANGE_CUTOFF_DAYS,
): string | null {
  const left = daysUntil(firstAt, now);
  if (!Number.isFinite(left)) return 'This booking has no date on it, so it cannot be changed here.';
  if (left < 0) return 'This booking has already started. Please speak to the restaurant.';
  if (left < cutoffDays) {
    return `Changes close ${cutoffDays} days before the first meal, and that has passed. `
      + 'The food is already being shopped for. Please ring the restaurant and ask.';
  }
  return null;
}

/** "You have until 9 November to change this booking." Said while they still can. */
export function changeWindowWords(
  firstAt: string | Date,
  dateWords: (d: Date) => string,
  cutoffDays: number = CHANGE_CUTOFF_DAYS,
): string {
  const at = firstAt instanceof Date ? firstAt : new Date(firstAt);
  if (!Number.isFinite(at.getTime())) return '';
  const closes = new Date(at.getTime() - cutoffDays * DAY_MS);
  return `Changes can be asked for until ${dateWords(closes)}, ${cutoffDays} days before the first meal.`;
}

export type ChangeKind = 'numbers' | 'timing' | 'food' | 'dietary' | 'cancel' | 'other';

export const CHANGE_KIND_WORDS: Record<ChangeKind, string> = {
  numbers: 'How many people',
  timing: 'A day or a time',
  food: 'What was ordered',
  dietary: 'Something somebody cannot eat',
  cancel: 'Cancel all or part of it',
  other: 'Something else',
};

/**
 * What is stopping this request being sent.
 *
 * The note is required and the kind is not enough on its own: "A day or a
 * time" tells the kitchen that something moved and nothing about what it
 * moved to, and a request somebody has to ring back about has cost two
 * telephone calls instead of one.
 */
export function requestProblem(kind: string, note: string): string | null {
  if (!kind) return 'Say what kind of change this is.';
  const said = (note ?? '').trim();
  if (said.length < 10) {
    return 'Please say what you would like changed, in your own words. '
      + 'The kitchen needs the detail, not just the heading.';
  }
  if (said.length > 2000) return 'That is longer than this box holds. Please shorten it, or ring instead.';
  return null;
}
