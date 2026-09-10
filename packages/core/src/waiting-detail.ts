import { listAll, listByIds, Query, db, DB_ID } from './client';
import { pendingBarChecks } from './stock';
import { countLines } from './consignment';
import { barReviewLines, shopReviewLines, spendReviewLines, linesAgainst } from './waiting-lines';
import type { ReviewLine } from './waiting-lines';
import type { WaitingRef } from './waiting';

/**
 * Reading the lines behind one thing that is waiting.
 *
 * Read when a row is opened, never with the list. A page that loaded the
 * lines of thirty-six waiting things to show none of them would be slow every
 * time to be useful once.
 *
 * The shaping is in waiting-lines.ts and is pure; this is the part that goes
 * to the database.
 */

export interface Review {
  /** Column headings differ: a count has expected and found, a spend has how many. */
  shape: 'count' | 'spend';
  lines: ReviewLine[];
  /** What the person who sent it wrote, where they wrote anything. */
  note?: string;
  /** For a spend: what the lines add up to against what it claims. */
  claimed?: number;
  total?: number;
  off?: number;
  /** Said when there is nothing to list, rather than showing an empty table. */
  empty?: string;
}

interface Named { $id: string; name?: string }

/** Every line behind one waiting row, ready to show. */
export async function loadReview(ref: WaitingRef): Promise<Review> {
  if (ref.kind === 'bar_count') {
    const all = await pendingBarChecks();
    const mine = all.filter((c) => c.shift_id === ref.shiftId && (c.phase ?? 'close') === ref.phase);
    const names = await listByIds<Named>('ingredients', '$id', mine.map((c) => c.ingredient_id))
      .catch(() => [] as Named[]);
    const book = new Map(names.map((n) => [n.$id, n.name ?? '']));
    return {
      shape: 'count',
      lines: barReviewLines(mine, (id) => book.get(id) ?? ''),
      empty: 'Every line on this count has already been dealt with.',
    };
  }

  if (ref.kind === 'shop_count' || ref.kind === 'shelf') {
    const rows = await countLines(ref.countId).catch(() => []);
    return {
      shape: 'count',
      // Lines that match are left out. A stocktake of four hundred pieces
      // where six differ is a list of six things to think about, and putting
      // the other three hundred and ninety-four in front of somebody is how
      // the six get skimmed past.
      lines: shopReviewLines(rows.filter((r) => r.delta !== 0)),
      empty: 'Nothing on this count differs from what the shelf expected.',
    };
  }

  if (ref.kind === 'spend') {
    const [items, expense] = await Promise.all([
      listAll<{ name_snapshot: string; qty?: number; unit_cost?: number; line_total?: number }>(
        'expense_items', [Query.equal('expense_id', ref.expenseId)],
      ).catch(() => []),
      db.getDocument(DB_ID, 'shift_expenses', ref.expenseId).catch(() => null) as Promise<
        { amount?: number; note?: string; payee?: string } | null
      >,
    ]);
    const lines = spendReviewLines(items);
    const claimed = expense?.amount ?? 0;
    const { total, off } = linesAgainst(lines, claimed);
    return {
      shape: 'spend',
      lines,
      note: expense?.note || undefined,
      claimed,
      total,
      off,
      // Most spends are one amount and a note, with nothing itemised. That is
      // ordinary, not a fault, and saying so is better than an empty table.
      empty: 'Nothing was itemised on this spend, so there is only the amount and the note.',
    };
  }

  return { shape: 'count', lines: [], empty: 'There is nothing to list for this one.' };
}
