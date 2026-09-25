/**
 * Finding one order by its number.
 *
 * The question this answers is always the same and always urgent: somebody is
 * holding a receipt, or reading a number down a telephone, and needs THAT
 * order. Up to now the only way was to guess its date, load that range, and
 * scroll — and guessing the date is precisely what somebody holding a receipt
 * from an unknown week cannot do.
 *
 * TWO HALVES, AND THE SECOND IS THE POINT.
 *
 * The Orders page loads a date range and everything below the dates is a view
 * over what came back. A search that only filtered that view would work
 * perfectly for orders from this week and fail silently for every other one —
 * "no orders match" for a bill that exists, which is worse than no search,
 * because it answers the question wrongly instead of not answering it.
 *
 * So the filter narrows what is loaded, and when that finds nothing the caller
 * goes and asks the database by number, across every date. This file decides
 * what matches and what to look up; the reading lives in the page.
 *
 * WRITTEN FOR HOW PEOPLE READ A NUMBER OFF PAPER. Nobody types "ORD0866".
 * They type 866, or 0866, or ord866, or paste the whole thing with a space in
 * it. All of those are the same question and all of them are answered.
 *
 * Pure. Imports nothing at runtime.
 */

/** An order, as far as this question is concerned. */
export interface SearchableOrder {
  order_no?: string;
}

/** Punctuation and case thrown away, because a receipt has neither reliably. */
export const tidyQuery = (raw: string): string =>
  String(raw ?? '').trim().toUpperCase().replace(/[\s\-_/#]+/g, '');

/** Just the digits, with leading noughts dropped so 0866 and 866 are one number. */
export const digitsOf = (raw: string): string =>
  (String(raw ?? '').match(/\d+/g) ?? []).join('').replace(/^0+(?=\d)/, '');

/** Just the letters: the prefix that says which run of numbers this is. */
export const lettersOf = (raw: string): string =>
  String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');

/**
 * Does this order number answer that query?
 *
 * Taken apart into the two things an order number is — the prefix that says
 * which run it belongs to, and the number within that run — and each half
 * only constrains the answer when it was actually typed.
 *
 *   866        the number alone, which is how it is read off a receipt
 *   0866       the same number, padded as it is printed
 *   ord866     the prefix without the padding, as somebody types it
 *   ORD0866    the whole thing, pasted
 *   86         a run of it, while they are still typing
 *
 * THE PREFIX IS NOT IGNORED ONCE IT IS TYPED. Order numbers are unique per
 * venue but the runs are per side, so the shop's S0866 and the bistro's
 * ORD0866 are two different bills of the same number. Somebody who typed ORD
 * has said which one they want, and offering the other is answering a
 * question they did not ask.
 *
 * The numeric comparison drops leading noughts on BOTH sides, so a padding
 * change in the settings never makes an old order unfindable by the number
 * printed on its own receipt.
 */
export function orderNoMatches(orderNo: string | undefined, query: string): boolean {
  const q = tidyQuery(query);
  if (!q) return true;
  const no = tidyQuery(orderNo ?? '');
  if (!no) return false;

  // Typed straight through, padding and all. The commonest paste.
  if (no.includes(q)) return true;

  const qLetters = lettersOf(q);
  // A prefix that was typed has to be the right one. Matched from the left so
  // "B" narrows to the bar while somebody is still typing "BAR".
  if (qLetters && !lettersOf(no).startsWith(qLetters)) return false;

  const qd = digitsOf(q);
  // Letters alone, and they matched above. "ORD" is a legitimate way to ask
  // for everything in that run.
  if (!qd) return true;

  const nd = digitsOf(no);
  // Exact on the number is what somebody means; contains is what makes it
  // useful while they are still typing.
  return nd === qd || nd.includes(qd);
}

/** The orders on screen that answer the query, in the order they arrived. */
export const searchOrders = <T extends SearchableOrder>(orders: T[], query: string): T[] =>
  (tidyQuery(query) ? orders.filter((o) => orderNoMatches(o.order_no, query)) : orders);

/**
 * The exact order numbers worth asking the database for.
 *
 * A key index answers `equal`, not "contains", so a lookup beyond the loaded
 * dates has to name the number exactly. Somebody typing 866 means one of a
 * handful of things — ORD0866, S0866, BAR0866 — and asking for all of them in
 * one query is cheaper than asking them to work out which prefix they want.
 *
 * The raw query is included as typed, so pasting a whole order number works
 * whatever the prefixes happen to be, including a run from before they were
 * changed. Padded and unpadded both go in for the same reason.
 */
export function orderNoCandidates(
  query: string,
  prefixes: (string | undefined)[],
  padding = 4,
): string[] {
  const q = tidyQuery(query);
  if (!q) return [];

  const out = new Set<string>([q]);
  const d = digitsOf(q);

  if (d) {
    const pad = Math.max(1, padding);
    // Every prefix this business uses, including the blank one a side with no
    // prefix of its own writes.
    for (const raw of [...prefixes, '']) {
      const p = tidyQuery(raw ?? '');
      out.add(`${p}${d.padStart(pad, '0')}`);
      out.add(`${p}${d}`);
    }
  }

  // Appwrite caps how many values one `equal` may carry, and a hundred
  // near-identical guesses is a slow query answering nothing extra.
  return [...out].filter(Boolean).slice(0, 25);
}

/**
 * Whether it is worth going to the database at all.
 *
 * One character is not a search, it is somebody who has started typing, and a
 * query per keystroke against every order ever taken is a page that gets
 * slower the harder you try to use it.
 */
export const worthLookingUp = (query: string): boolean => tidyQuery(query).length >= 2;

/** What to say when the loaded range holds nothing and the wider look is running. */
export const lookingWords = (query: string): string =>
  `Nothing in these dates matches “${query.trim()}”. Looking through every date…`;

/**
 * What to say once the wider look is done.
 *
 * The found case says plainly that these are from OUTSIDE the chosen dates.
 * A row appearing in a list that the dates above say cannot contain it is the
 * kind of thing that makes somebody distrust both.
 */
export function foundWords(query: string, found: number): string {
  if (found === 0) {
    return `No order anywhere is numbered “${query.trim()}”. Check the number — and if it was rung up on a `
      + 'till that was offline, it may not have reached this list yet.';
  }
  return `${found} ${found === 1 ? 'order' : 'orders'} found outside the dates chosen above. `
    + 'Widen the dates to see them in the list with everything else.';
}
