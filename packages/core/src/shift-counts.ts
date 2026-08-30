/**
 * A shift's two counts, side by side.
 *
 * The bar and the shop are counted twice: once when somebody comes on and
 * accepts what is there, and once when they hand it over. Both are already
 * recorded, and both were only ever readable one at a time — the count sheet
 * shows whichever end is being counted NOW, and once the shift is closed
 * neither is reachable at all.
 *
 * That is the wrong shape for the question people actually ask afterwards,
 * which is never "what was the closing figure". It is "what did they take on,
 * what did they hand over, and does the difference match what was sold" — one
 * question about a pair, and reading two separate lists and subtracting in
 * your head is how a handover argument starts rather than ends.
 *
 * So the two ends are paired per thing, on one row, with the arithmetic
 * already done.
 *
 * Pure. Imports nothing at runtime.
 */

/** One count of one thing, at one end of a shift. */
export interface CountEntry {
  itemId: string;
  name: string;
  phase: 'open' | 'close';
  /** What was actually on the shelf. Null where the line was left blank. */
  counted: number | null;
  /** What the books said should be there at that moment. */
  expected: number;
  /** Counted minus expected, as it was recorded. */
  varianceQty: number;
  varianceValue: number;
  /** Set where an admin took the count back. It happened; it is not deleted. */
  undone?: boolean;
}

/** Both ends of the shift for one thing. */
export interface CountPair {
  itemId: string;
  name: string;
  /** What was on the shelf when the shift opened. Null if never counted in. */
  opened: number | null;
  /** What was on it at the close. Null if never counted out. */
  closed: number | null;
  /**
   * What came off the shelf between the two, by counting alone.
   *
   * Opening minus closing, and deliberately NOT called "sold". It is
   * everything that left for any reason — sold, spilt, broken, taken — which
   * is exactly why it is worth putting beside what the tills say was sold.
   */
  went: number | null;
  /** The variance the close recorded, which is the figure that was argued. */
  varianceQty: number;
  varianceValue: number;
  undone: boolean;
}

/**
 * The pairs, worst variance first.
 *
 * Ordered by what is wrong rather than alphabetically: a page of forty bottles
 * sorted by name buries the one line somebody needs to see behind thirty-nine
 * that balanced.
 */
export function pairCounts(entries: CountEntry[]): CountPair[] {
  const byItem = new Map<string, CountPair>();

  for (const entry of entries) {
    const at = byItem.get(entry.itemId) ?? {
      itemId: entry.itemId,
      name: entry.name,
      opened: null,
      closed: null,
      went: null,
      varianceQty: 0,
      varianceValue: 0,
      undone: false,
    };
    // A later row wins on the name, because a thing renamed since is still the
    // same thing and the newer name is the one somebody will recognise.
    at.name = entry.name || at.name;

    if (entry.phase === 'open') {
      at.opened = entry.counted;
    } else {
      at.closed = entry.counted;
      // Only the close carries a variance worth showing. An opening count sets
      // the shelf rather than disagreeing with it.
      at.varianceQty = entry.varianceQty;
      at.varianceValue = entry.varianceValue;
      at.undone = entry.undone ?? false;
    }

    byItem.set(entry.itemId, at);
  }

  const pairs = [...byItem.values()];
  for (const pair of pairs) {
    pair.went = pair.opened !== null && pair.closed !== null ? pair.opened - pair.closed : null;
  }

  return pairs.sort(
    (a, b) => Math.abs(b.varianceValue) - Math.abs(a.varianceValue)
      || Math.abs(b.varianceQty) - Math.abs(a.varianceQty)
      || a.name.localeCompare(b.name),
  );
}

export interface CountsSummary {
  /** How many things were counted at either end. */
  items: number;
  /** How many have both ends, so their movement can be read. */
  paired: number;
  /** Lines that came up short at the close. */
  short: number;
  /** What that shortage was worth. Positive, because it is a loss. */
  shortValue: number;
  /** Lines that came up over, which is its own kind of wrong. */
  over: number;
  countedIn: boolean;
  countedOut: boolean;
}

export function countsSummary(pairs: CountPair[]): CountsSummary {
  const summary: CountsSummary = {
    items: pairs.length,
    paired: 0,
    short: 0,
    shortValue: 0,
    over: 0,
    countedIn: false,
    countedOut: false,
  };

  for (const pair of pairs) {
    if (pair.opened !== null) summary.countedIn = true;
    if (pair.closed !== null) summary.countedOut = true;
    if (pair.opened !== null && pair.closed !== null) summary.paired += 1;
    // An undone count is not evidence of anything. Somebody stood at the shelf
    // and wrote a number that was then taken back, and adding it to a shortage
    // would be counting a figure that has already been withdrawn.
    if (pair.undone) continue;
    if (pair.varianceQty < 0) {
      summary.short += 1;
      summary.shortValue += Math.abs(pair.varianceValue);
    } else if (pair.varianceQty > 0) {
      summary.over += 1;
    }
  }

  return summary;
}

/**
 * What is missing from the pair, said plainly.
 *
 * A shift with only one end counted still shows what it has — half a record is
 * a great deal better than none — but must never be read as though the other
 * half were zero.
 */
export function countsGapWords(summary: CountsSummary): string | null {
  if (summary.items === 0) return null;
  if (!summary.countedIn && !summary.countedOut) return null;
  if (!summary.countedIn) {
    return 'This shift was never counted in, so there is nothing to measure the closing figures against — '
      + 'they are set against whatever the shift before it left behind.';
  }
  if (!summary.countedOut) {
    return 'This shift was counted in but never counted out, so what was handed over was never written down.';
  }
  return null;
}
