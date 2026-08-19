/**
 * Taking a sale back out.
 *
 * Two different things get asked for with the same words.
 *
 * A TEST. Somebody rang a sale through to see that it worked. Nothing was
 * bought, no money changed hands, and nobody should be able to tell it ever
 * happened — least of all the maker whose statement it landed on.
 *
 * A MISTAKE. A real sale, rung up wrong or handed back the next day. The money
 * goes back, the piece goes back on the shelf, and the maker is no longer owed
 * for something that did not sell.
 *
 * They differ in what is left behind, not in what is undone: an erase removes
 * the order, a refund keeps it marked void so the till's history still shows
 * somebody was served and it came back. Both leave the consignor's statement
 * as though the sale never happened, which is a deliberate choice — see
 * `ledgerFate`.
 *
 * Pure. Imports nothing at runtime.
 */

export type ReversalMode = 'erase' | 'refund';

export interface LedgerEntryLike {
  $id: string;
  amount?: number;
  payout_id?: string;
  kind?: string;
}

export type LedgerAction =
  | { action: 'delete'; entry: LedgerEntryLike }
  | { action: 'offset'; entry: LedgerEntryLike; amount: number; why: string };

/**
 * What happens to a consignment credit when its sale is taken back.
 *
 * Deleted, not reversed. A statement carrying "Sale 49" and "Refund −49" for
 * something that never left the shelf is a statement a maker has to read twice
 * to understand, and the shop has to explain. Two lines that cancel are not
 * evidence of anything except that the till was used; the honest record of a
 * sale that did not happen is no line at all.
 *
 * WITH ONE EXCEPTION, and it is not a matter of taste. Once a maker has been
 * PAID for a line, the payout points at it. Delete the line and the payout
 * covers a sale that does not exist: the statement stops adding up, and the
 * money that actually left the shop no longer has anything to sit against. So
 * a paid line is offset instead, and the reason is said out loud rather than
 * silently doing something different from what was asked.
 */
export function ledgerFate(entries: LedgerEntryLike[]): LedgerAction[] {
  return entries.map((entry) => {
    if (entry.payout_id?.trim()) {
      return {
        action: 'offset',
        entry,
        amount: -(entry.amount ?? 0),
        why: 'already paid out, so the entry stays and is cancelled by an opposite one',
      };
    }
    return { action: 'delete', entry };
  });
}

/** How many entries could not simply be removed, for the report. */
export const offsetCount = (actions: LedgerAction[]) =>
  actions.filter((a) => a.action === 'offset').length;

export interface LineLike {
  $id: string;
  menu_item_id?: string;
  variant_id?: string;
  qty?: number;
  status?: string;
}

export interface StockReturn {
  lineId: string;
  menuItemId?: string;
  variantId?: string;
  /** Positive: this many go back. */
  qty: number;
}

/**
 * What goes back on the shelf.
 *
 * A line already voided took nothing off it, so putting something back would
 * invent stock. The count would then read one high, and the next stocktake
 * would show a loss nobody can explain, which is worse than the sale it was
 * trying to correct.
 */
export function stockToReturn(lines: LineLike[]): StockReturn[] {
  return lines
    .filter((l) => l.status !== 'void')
    .map((l) => ({
      lineId: l.$id,
      menuItemId: l.menu_item_id,
      variantId: l.variant_id || undefined,
      qty: l.qty ?? 1,
    }))
    .filter((r) => r.qty > 0);
}

/**
 * Whether this sale can be taken back at all.
 *
 * A shift that has closed has had its money counted and its books written, and
 * a sale removed from underneath a closed shift makes the drawer that was
 * counted disagree with the orders behind it. That is not something to do
 * quietly on a Tuesday: it wants an accounting correction, which is a
 * different act with a different record.
 */
export function reversalProblem(
  order: { $id?: string; payment_status?: string; status?: string } | null,
  shift: { status?: string } | null,
): string | null {
  if (!order) return 'That sale no longer exists.';
  if (order.status === 'void') return 'That sale has already been taken back.';
  if (shift?.status === 'closed') {
    return 'That shift has been closed and counted. Reversing a sale from a closed shift would leave '
      + 'the counted drawer disagreeing with the orders behind it — put it through as an accounting '
      + 'correction instead.';
  }
  return null;
}

/** What the admin is about to do, in words, before they confirm it. */
export function describeReversal(
  mode: ReversalMode,
  parts: { lines: number; ledger: LedgerAction[]; paid: number },
): string {
  const bits: string[] = [];
  bits.push(mode === 'erase'
    ? 'The order and its lines are deleted outright.'
    : 'The order is kept, marked void, so the till history still shows it.');

  if (parts.paid > 0) {
    bits.push(mode === 'erase'
      ? 'The payment record goes with it.'
      : 'The payment is marked refunded.');
  }
  if (parts.lines > 0) bits.push(`${parts.lines} item(s) go back on the shelf.`);

  const offsets = offsetCount(parts.ledger);
  const deletes = parts.ledger.length - offsets;
  if (deletes > 0) bits.push(`${deletes} consignment entr${deletes === 1 ? 'y is' : 'ies are'} removed from the maker's statement entirely.`);
  if (offsets > 0) {
    bits.push(`${offsets} cannot be removed because the maker has already been paid for ${offsets === 1 ? 'it' : 'them'}; `
      + `${offsets === 1 ? 'it gets' : 'they get'} an opposite entry instead.`);
  }
  return bits.join(' ');
}
