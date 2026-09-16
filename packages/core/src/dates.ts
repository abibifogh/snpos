/**
 * When something happened, in the reader's own words.
 *
 * Sixty places called toLocaleDateString, toLocaleString and
 * toLocaleTimeString by hand, each with its own options, so the same
 * moment read "09/09/2026, 20:17:03" on one screen and "9 Sep, 20:17" on
 * another. Three functions, three shapes, used everywhere.
 *
 * Spelt out by hand rather than asked of the browser's locale: a till set
 * up in American English would otherwise read "Sep 9, 2026" beside an
 * office reading "9 Sep 2026", and the point of one function is one answer.
 * Day first and a 24-hour clock, which is how Ghana writes them.
 *
 * Pure. Imports nothing at runtime.
 */

type At = string | number | Date | undefined | null;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const parse = (at: At): Date | null => {
  if (at === undefined || at === null || at === '') return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isFinite(d.getTime()) ? d : null;
};

const two = (n: number) => String(n).padStart(2, '0');

/** "9 Sep 2026". */
export function dateWords(at: At, fallback = '—'): string {
  const d = parse(at);
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : fallback;
}

/** "20:17". */
export function timeWords(at: At, fallback = '—'): string {
  const d = parse(at);
  return d ? `${two(d.getHours())}:${two(d.getMinutes())}` : fallback;
}

/** "9 Sep 2026, 20:17". */
export function dateTimeWords(at: At, fallback = '—'): string {
  const d = parse(at);
  return d ? `${dateWords(d)}, ${timeWords(d)}` : fallback;
}

/**
 * The same moment as a datetime-local box wants it: local wall clock, no zone.
 *
 * Handing the box an ISO string directly shows UTC, so a bar in Accra
 * correcting a 1am close is offered midnight — an hour it did not ask for, in
 * a box that looks like it is merely repeating what is already stored. Two
 * screens needed this and each would have written its own; this is that line,
 * once.
 *
 * Empty for a time that cannot be read, because a half-built string in a date
 * box is silently ignored by the browser and leaves somebody pressing a button
 * that does nothing.
 */
export function forDateTimeInput(at: At): string {
  const d = parse(at);
  if (!d) return '';
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
    + `T${two(d.getHours())}:${two(d.getMinutes())}`;
}
