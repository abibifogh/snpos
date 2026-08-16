/**
 * Counting the shop's shelves, and what a difference means.
 *
 * The kitchen counts ingredients: how much rice is left. A craft shop counts
 * pieces, and the question is not "how much" but "is that bowl still here".
 * Which sounds like the easier question and is not, because a difference has
 * several possible causes and they are not interchangeable — a piece that
 * broke, a piece that walked, a piece that went back to its maker and a piece
 * that was miscounted last time all leave the same gap on a shelf and mean
 * four different things to the person who made it.
 *
 * So a count here is not one number. Each line says what is actually there and
 * why it differs, and the movement written down carries that reason. A stock
 * history that records every loss as "adjustment" is a history that cannot
 * answer the only question worth asking of it: is this breakage, or is
 * somebody taking things.
 *
 * Pure. The arithmetic behind "the shelf says eleven and there are nine" can
 * be checked without a database.
 */

/** Why a line differs from what the shelf said. */
export type CountReason = 'counted' | 'damaged' | 'lost' | 'returned';

export const COUNT_REASONS: { value: CountReason; label: string; help: string }[] = [
  {
    value: 'counted',
    label: 'Just a miscount',
    help: 'The number was wrong. Nothing happened to the pieces.',
  },
  {
    value: 'damaged',
    label: 'Broken or damaged',
    help: 'It was here and it cannot be sold. Recorded against the maker so the loss is visible on their statement.',
  },
  {
    value: 'lost',
    label: 'Missing',
    help: 'Nobody knows where it went. Worth watching if it keeps happening to the same maker or the same shelf.',
  },
  {
    value: 'returned',
    label: 'Went back to the maker',
    help: 'Unsold and collected. Nothing is owed either way — a consignor is only paid when a piece sells.',
  },
];

/**
 * The movement type each reason writes.
 *
 * `counted` becomes an adjustment, which is the honest word for it: the shelf
 * was wrong and is now right, and nothing physically happened. The other three
 * name themselves, and that naming is the whole point of asking.
 */
export const MOVE_FOR_REASON: Record<CountReason, 'adjustment' | 'damaged' | 'lost' | 'return_to_consignor'> = {
  counted: 'adjustment',
  damaged: 'damaged',
  lost: 'lost',
  returned: 'return_to_consignor',
};

/** One shelf line, as the person counting sees it. */
export interface CountLine {
  /** Product, and variant where the piece has sizes. */
  menuItemId: string;
  variantId?: string;
  name: string;
  variantLabel?: string;
  consignorId?: string;
  consignorName?: string;
  /** Which shelf it sits on, for grouping the walk. */
  categoryId?: string;
  categoryName?: string;
  /** What the system believes is there. */
  onHand: number;
  /** What was typed. Undefined means this line has not been counted. */
  countedText?: string;
  reason?: CountReason;
  /** Retail value of one piece, for saying what a loss was worth. */
  unitPrice: number;
}

export interface CountDifference {
  line: CountLine;
  counted: number;
  /** Negative when pieces are missing, positive when there are more than expected. */
  delta: number;
  reason: CountReason;
  /** What the difference is worth at retail. Always positive. */
  value: number;
}

/**
 * Was a number actually entered?
 *
 * Blank is not zero, and conflating them is the way a stocktake wipes a shelf.
 * Somebody counting forty pieces gets through eleven of them, walks away, and
 * every line they never reached says "0 counted" — which would write off the
 * whole shop. So a line with nothing typed is a line that was not counted, and
 * nothing is written for it.
 */
export function wasCounted(line: CountLine): boolean {
  const text = (line.countedText ?? '').trim();
  if (text === '') return false;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0;
}

/**
 * The differences a count has found, and only the differences.
 *
 * A line counted at exactly what the shelf said produces nothing: writing a
 * zero movement for every piece in the shop would bury the four that matter
 * under four hundred that do not.
 */
export function differencesIn(lines: CountLine[]): CountDifference[] {
  const found: CountDifference[] = [];
  for (const line of lines) {
    if (!wasCounted(line)) continue;
    const counted = Number((line.countedText ?? '').trim());
    const delta = counted - line.onHand;
    if (delta === 0) continue;
    /*
      More than expected is always a miscount, whatever the dropdown says.

      "Two extra pieces, because they were damaged" is not a sentence, and a
      damaged movement with a positive quantity would add stock to the shelf
      and put a loss on the maker's statement in the same breath. The only
      thing a surplus can honestly be is that the number was wrong.
    */
    const reason: CountReason = delta > 0 ? 'counted' : line.reason ?? 'counted';
    found.push({ line, counted, delta, reason, value: Math.abs(delta) * line.unitPrice });
  }
  return found;
}

export interface CountSummary {
  /** Lines somebody actually put a number against. */
  countedLines: number;
  /** Lines left blank, which are untouched rather than zeroed. */
  uncountedLines: number;
  differences: CountDifference[];
  /** Pieces missing, and what they were worth at retail. */
  missingPieces: number;
  missingValue: number;
  /** Pieces found that the shelf did not know about. */
  surplusPieces: number;
  /** Missing pieces by reason, so the summary can say what kind of loss it is. */
  byReason: { reason: CountReason; pieces: number; value: number }[];
}

export function summariseCount(lines: CountLine[]): CountSummary {
  const differences = differencesIn(lines);
  const counted = lines.filter(wasCounted);

  const byReason = new Map<CountReason, { pieces: number; value: number }>();
  let missingPieces = 0;
  let missingValue = 0;
  let surplusPieces = 0;

  for (const d of differences) {
    if (d.delta > 0) {
      surplusPieces += d.delta;
      continue;
    }
    const pieces = -d.delta;
    missingPieces += pieces;
    missingValue += d.value;
    const at = byReason.get(d.reason) ?? { pieces: 0, value: 0 };
    byReason.set(d.reason, { pieces: at.pieces + pieces, value: at.value + d.value });
  }

  return {
    countedLines: counted.length,
    uncountedLines: lines.length - counted.length,
    differences,
    missingPieces,
    missingValue,
    surplusPieces,
    byReason: [...byReason.entries()]
      .map(([reason, v]) => ({ reason, ...v }))
      .sort((a, b) => b.value - a.value),
  };
}

/**
 * Anything about this count that somebody should read before saving it.
 *
 * Warnings, never refusals. A shop that has genuinely lost a third of a shelf
 * needs to record that, and a system that argues with the person holding the
 * clipboard is one they stop using. What it can do is make sure nobody saves
 * a catastrophe by accident.
 */
export function countWarnings(lines: CountLine[]): string[] {
  const summary = summariseCount(lines);
  const warnings: string[] = [];

  if (summary.uncountedLines > 0 && summary.countedLines > 0) {
    warnings.push(
      `${summary.uncountedLines} line${summary.uncountedLines === 1 ? '' : 's'} left blank. `
      + 'Those are left exactly as they are — blank is not nought.',
    );
  }

  // A line counted to nothing when the shelf expected several is the single
  // most likely typo on this screen, and the most expensive.
  const emptied = summary.differences.filter((d) => d.counted === 0 && d.line.onHand >= 3);
  if (emptied.length > 0) {
    warnings.push(
      `${emptied.length} line${emptied.length === 1 ? '' : 's'} counted to nothing: `
      + `${emptied.slice(0, 3).map((d) => d.line.name).join(', ')}`
      + `${emptied.length > 3 ? `, and ${emptied.length - 3} more` : ''}. Worth a second look.`,
    );
  }

  const unexplained = summary.differences.filter((d) => d.delta < 0 && d.reason === 'counted');
  if (unexplained.length > 0) {
    warnings.push(
      `${unexplained.length} shortage${unexplained.length === 1 ? '' : 's'} recorded as a miscount. `
      + 'If a piece broke or went back to its maker, saying so is what makes the history worth keeping.',
    );
  }

  return warnings;
}

/* ------------------------------------------------- a count awaiting approval */

/**
 * How to group the shelf while counting it.
 *
 * Not decoration. A shop counts one maker's shelf at a time, or one category
 * of thing at a time, because that is how the room is laid out — and a flat
 * alphabetical list of four hundred pieces means walking back and forth across
 * the shop for the letter B and again for the letter C. What gets skipped is
 * whatever is furthest away, which is the same reason the kitchen's count
 * sheet is grouped the way the shelves are.
 */
export type CountGrouping = 'none' | 'maker' | 'category';

export interface GroupedLines<T> {
  key: string;
  label: string;
  lines: T[];
  /** How far through this group somebody is, so a long count shows progress. */
  counted: number;
  total: number;
}

/**
 * Split the shelf into the groups somebody will actually walk.
 *
 * Anything without a maker or a category goes last under its own heading
 * rather than silently at the top, where it reads as belonging to whatever is
 * above it.
 */
export function groupLines<T extends { line: CountLine }>(
  rows: T[],
  by: CountGrouping,
): GroupedLines<T>[] {
  if (by === 'none') {
    return [{
      key: 'all',
      label: '',
      lines: rows,
      counted: rows.filter((r) => wasCounted(r.line)).length,
      total: rows.length,
    }];
  }

  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const label = by === 'maker'
      ? row.line.consignorName || 'The shop'
      : row.line.categoryName || 'Uncategorised';
    const at = buckets.get(label);
    if (at) at.push(row);
    else buckets.set(label, [row]);
  }

  const last = by === 'maker' ? 'The shop' : 'Uncategorised';
  return [...buckets.entries()]
    .map(([label, lines]) => ({
      key: label,
      label,
      lines,
      counted: lines.filter((r) => wasCounted(r.line)).length,
      total: lines.length,
    }))
    // The catch-all group last, whatever it is called alphabetically.
    .sort((a, b) => (a.label === last ? 1 : b.label === last ? -1 : a.label.localeCompare(b.label)));
}

/** What a saved count looks like when somebody comes to approve it. */
export interface PendingCount {
  $id: string;
  counted_by: string;
  counted_at: string;
  note?: string;
  status: 'pending' | 'approved' | 'rejected';
  line_count: number;
  missing_pieces: number;
  missing_value: number;
  surplus_pieces: number;
}

export interface PendingCountLine {
  $id: string;
  count_id: string;
  menu_item_id: string;
  variant_id?: string;
  name_snapshot: string;
  variant_label?: string;
  consignor_id?: string;
  consignor_name?: string;
  /** What the shelf said when it was counted. */
  expected: number;
  counted: number;
  delta: number;
  reason: CountReason;
  unit_price: number;
  applied?: boolean;
}

/**
 * Has the ground moved under this count since it was taken?
 *
 * A count measures a discrepancy at a moment. Sales between then and the
 * approval are real movements of their own, so the DELTA is what gets applied
 * and the drift is not an error — eleven on the shelf, nine found, two sold
 * while it waited, and applying minus two leaves seven, which is right.
 *
 * It is still worth showing. A line whose shelf has moved a long way since the
 * count is a line somebody should look at rather than wave through, because at
 * some point the honest answer is "this count is stale, do it again".
 */
export function driftedSince(line: PendingCountLine, onHandNow: number): number {
  return onHandNow - line.expected;
}

/**
 * Whether one person may sign off their own count.
 *
 * Allowed, and recorded. A shop with one admin who counts their own shelves
 * would otherwise have a count nobody can ever approve, which is not a control
 * — it is a locked door with the key inside. The protection worth having is
 * that both names are on it and they can be the same name, visibly.
 */
export const isSelfApproval = (count: { counted_by: string }, reviewerId: string): boolean =>
  !!reviewerId && count.counted_by === reviewerId;
