/**
 * A shift's two counts, each against what was expected of it.
 *
 * The bar and the shop are counted twice: once when somebody comes on and
 * accepts what is there, and once when they hand it over. Both are already
 * recorded, and both were only ever readable one at a time — the count sheet
 * shows whichever end is being counted NOW, and once the shift is closed
 * neither is reachable at all.
 *
 * The question each count answers is the same one asked twice: DOES WHAT IS ON
 * THE SHELF MATCH WHAT SHOULD BE THERE. At the open, "should be" is what the
 * shift before left; at the close, it is that opening figure less everything
 * the tills sold. Two counts, two expected figures, two variances.
 *
 * The pair is the whole story of a night. A shift that opened short inherited
 * somebody else's problem; one that opened square and closed short made its
 * own. Told apart here, once, rather than argued about at two in the morning.
 *
 * Setting the opening count against the CLOSING count answers a different and
 * less useful question: it says what left the shelf without saying whether
 * that was right. Both counts already carry the expected figure they were
 * actually measured against, and that is what these report.
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

/** One thing, counted at one end of the shift, against what was expected. */
export interface CountRow {
  itemId: string;
  name: string;
  /** What was actually on the shelf. Null where the line was left blank. */
  counted: number | null;
  /** What the books said should be there at that moment. */
  expected: number;
  /** Counted minus expected, as it was recorded. Negative is short. */
  varianceQty: number;
  varianceValue: number;
  /** Set where an admin took the count back. It happened; it is not deleted. */
  undone: boolean;
}

/**
 * The rows for one end of the shift, worst variance first.
 *
 * Ordered by what is wrong rather than alphabetically: a page of forty bottles
 * sorted by name buries the one line somebody needs to see behind thirty-nine
 * that balanced.
 */
export function countsForPhase(entries: CountEntry[], phase: 'open' | 'close'): CountRow[] {
  const byItem = new Map<string, CountRow>();

  for (const entry of entries) {
    if (entry.phase !== phase) continue;
    // A thing counted twice at the same end is somebody correcting themselves,
    // and the later row wins, which is what a correction means.
    byItem.set(entry.itemId, {
      itemId: entry.itemId,
      name: entry.name,
      counted: entry.counted,
      expected: entry.expected,
      varianceQty: entry.varianceQty,
      varianceValue: entry.varianceValue,
      undone: entry.undone ?? false,
    });
  }

  return [...byItem.values()].sort(
    (a, b) => Math.abs(b.varianceValue) - Math.abs(a.varianceValue)
      || Math.abs(b.varianceQty) - Math.abs(a.varianceQty)
      || a.name.localeCompare(b.name),
  );
}

/** Both ends, each already measured against its own expected figure. */
export const countsByPhase = (entries: CountEntry[]): { open: CountRow[]; close: CountRow[] } => ({
  open: countsForPhase(entries, 'open'),
  close: countsForPhase(entries, 'close'),
});

export interface PhaseSummary {
  /** How many things were on the sheet at this end. */
  items: number;
  /** How many actually had a figure written against them. */
  counted: number;
  /** Lines that came up short of what was expected. */
  short: number;
  /** What that shortage was worth. Positive, because it is a loss. */
  shortValue: number;
  /** Lines that came up over, which is its own kind of wrong. */
  over: number;
  overValue: number;
  /** Short less over, so a sheet that balances out reads as balanced. */
  netValue: number;
}

export function phaseSummary(rows: CountRow[]): PhaseSummary {
  const summary: PhaseSummary = {
    items: rows.length, counted: 0, short: 0, shortValue: 0, over: 0, overValue: 0, netValue: 0,
  };

  for (const row of rows) {
    if (row.counted !== null) summary.counted += 1;
    // An undone count is not evidence of anything. Somebody stood at the shelf
    // and wrote a number that was then taken back, and adding it to a shortage
    // would total a figure nobody claims any more.
    if (row.undone) continue;
    if (row.varianceQty < 0) {
      summary.short += 1;
      summary.shortValue += Math.abs(row.varianceValue);
    } else if (row.varianceQty > 0) {
      summary.over += 1;
      summary.overValue += Math.abs(row.varianceValue);
    }
  }

  summary.netValue = summary.shortValue - summary.overValue;
  return summary;
}

/**
 * What the two variances together say, which neither says alone.
 *
 * The reason both ends are worth reporting. Read on its own a closing shortage
 * accuses whoever worked the shift; read against the opening one it may be
 * something they walked into.
 */
export function bothEndsWords(
  open: PhaseSummary,
  close: PhaseSummary,
  format: (amount: number) => string,
): string | null {
  const way = (net: number) => (net > 0 ? 'short' : 'over');
  const openedOff = open.counted > 0 && open.netValue !== 0;
  const closedOff = close.counted > 0 && close.netValue !== 0;

  if (!openedOff && !closedOff) return null;
  if (openedOff && !closedOff) {
    return `This shift opened ${format(Math.abs(open.netValue))} ${way(open.netValue)} of what the shelf should `
      + 'have held, and closed on what was expected. Whatever went wrong happened before this shift started.';
  }
  if (!openedOff && closedOff) {
    return `This shift opened on what was expected and closed ${format(Math.abs(close.netValue))} `
      + `${way(close.netValue)}. Whatever went wrong happened on this shift.`;
  }
  return `This shift opened ${format(Math.abs(open.netValue))} ${way(open.netValue)} and closed `
    + `${format(Math.abs(close.netValue))} ${way(close.netValue)}. Some of it was already wrong before the `
    + 'shift started, so read the closing figure against the opening one rather than on its own.';
}

/**
 * What is missing from the record, said plainly.
 *
 * A shift with only one end counted still shows what it has — half a record is
 * a great deal better than none — but must never be read as though the other
 * half were zero.
 */
export function countsGapWords(open: CountRow[], close: CountRow[]): string | null {
  if (open.length === 0 && close.length === 0) return null;
  if (open.length === 0) {
    return 'This shift was never counted in, so its closing figures are measured against whatever the shift '
      + 'before it left behind rather than against anything this shift accepted.';
  }
  if (close.length === 0) {
    return 'This shift was counted in but never counted out, so what was handed over was never written down.';
  }
  return null;
}
