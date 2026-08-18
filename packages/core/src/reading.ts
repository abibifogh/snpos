/**
 * Reading less.
 *
 * Several screens were loading an entire table and then narrowing it in the
 * browser: every order ever taken, every line on every one of them, every
 * payment, then a date filter applied afterwards. On the day it was written
 * that was a few hundred rows and nobody noticed. It grows by every sale for
 * ever, and it is read again each time somebody opens the page.
 *
 * It is also what took the system down: the database's read allowance ran out
 * mid-morning and the tills stopped, because a month of reports had been
 * paying for a year of history each time.
 *
 * The fix is not faster paging, it is fetching fewer rows. These are the two
 * shapes that need: a window of time, and the children of rows already found.
 *
 * The chunking is pure and tested here; the fetching lives in client.ts, which
 * needs a database.
 */

/**
 * Split a list of ids into batches a query can actually carry.
 *
 * Appwrite caps how many values one `equal` may hold, and a query built from
 * four hundred order ids is rejected outright rather than truncated — so a
 * report of a busy month would fail entirely while a quiet one worked, which
 * is the kind of fault that gets reported as "it's broken sometimes".
 */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The most values one `equal` query may carry. Appwrite's own ceiling. */
export const QUERY_VALUES_MAX = 100;

/**
 * A day as the database stores it: the whole of it, both ends included.
 *
 * Local midnight, not UTC. A report that runs to midnight in another country
 * silently drops the last few hours of trading, and in Accra that is the
 * busiest part of the evening.
 */
export const dayStartIso = (day: string): string => new Date(`${day}T00:00:00`).toISOString();
export const dayEndIso = (day: string): string => new Date(`${day}T23:59:59.999`).toISOString();

/**
 * Is this window worth asking the database for?
 *
 * A blank or reversed range would otherwise be sent as a query matching
 * nothing, and the screen would show an empty report rather than saying the
 * dates are the wrong way round.
 */
export function windowProblem(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both dates.';
  if (from > to) return 'The first date is after the second one.';
  return null;
}
