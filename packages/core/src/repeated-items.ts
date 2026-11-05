/**
 * The same item picked on two lines of one purchase.
 *
 * Tomatoes listed twice — a hundred at GH₵1.50 and two at GH₵35 — reads on
 * the spend as two different things bought, puts two prices into the item's
 * cost history for one shopping trip, and leaves whoever checks the receipt
 * adding the lines up by hand to see what tomatoes actually cost. One item,
 * one line: what came in, and what was paid for all of it.
 *
 * Pure. Imports nothing at runtime.
 */

/** For each line, the earlier line (0-based) that already has its item, or null. */
export function repeatsOf(ids: string[]): (number | null)[] {
  const first = new Map<string, number>();
  return ids.map((id, i) => {
    const key = (id ?? '').trim();
    if (!key) return null;
    const seen = first.get(key);
    if (seen !== undefined) return seen;
    first.set(key, i);
    return null;
  });
}

/** Why these lines cannot be saved as they are, or null. */
export function repeatedItemsProblem(lines: { id: string; name: string }[]): string | null {
  const repeats = repeatsOf(lines.map((l) => l.id));
  const names = [...new Set(lines.filter((_, i) => repeats[i] !== null).map((l) => l.name || 'An item'))];
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} listed more than once. Put each item on one line, with how many came in altogether and what was paid for all of them.`;
}
