import { db, DB_ID, ID, Query, listAll } from './client';
import type { Doc } from './types';
import { purchasesFor } from './stock';
import { flagPurchase } from './purchase-flags';
import type { PurchaseFlag, PastPurchase } from './purchase-flags';

/**
 * Raising and reading the "that looks dear" questions.
 *
 * The rule itself is next door in purchase-flags, which imports nothing. This
 * is the part that goes and gets what a thing usually costs, and writes down
 * that somebody was asked.
 */

export * from './purchase-flags';

export interface PurchaseAlert extends Doc {
  venue_id: string;
  ingredient_id?: string;
  ingredient_name: string;
  unit?: string;
  expense_id?: string;
  kind: 'price' | 'qty';
  value: number;
  typical: number;
  rise_bp: number;
  seen: number;
  module?: string;
  created_by: string;
  acknowledged?: boolean;
  acknowledged_by?: string;
  acknowledged_at?: string;
  note?: string;
}

/**
 * What these ingredients usually cost, in one pass.
 *
 * Fetched per ingredient because that is how the movements are indexed, but
 * only for the lines somebody has actually filled in — a shop run is three or
 * four things, not the whole larder. A blank row costs nothing.
 */
export async function historyFor(ingredientIds: string[]): Promise<Record<string, PastPurchase[]>> {
  const ids = [...new Set(ingredientIds.filter(Boolean))];
  const pairs = await Promise.all(
    ids.map(async (id) => [id, await purchasesFor(id, 40).catch(() => [] as PastPurchase[])] as const),
  );
  return Object.fromEntries(pairs);
}

export interface CheckedLine {
  ingredientId: string;
  name: string;
  unit?: string;
  qty: number;
  unitCost: number;
  flags: PurchaseFlag[];
}

/**
 * Look over a shop run and say which lines are worth a second glance.
 *
 * Reads, so it lives here; decides nothing, which is next door. Called while
 * the form is still open — the whole value of this is catching a slipped nought
 * while the person who was at the market is still standing there.
 */
export async function checkPurchase(
  lines: { ingredientId: string; name: string; unit?: string; qty: number; unitCost: number }[],
): Promise<CheckedLine[]> {
  const history = await historyFor(lines.map((l) => l.ingredientId));
  return lines.map((l) => ({
    ...l,
    flags: flagPurchase({
      unitCost: l.unitCost,
      qty: l.qty,
      history: history[l.ingredientId] ?? [],
      name: l.name,
    }),
  }));
}

/**
 * Write down that somebody was asked, whatever they answered.
 *
 * Raised after the expense is saved rather than instead of it. The purchase is
 * the record that matters and must never fail because a note about it could
 * not be written — best effort, deliberately, the same as every other
 * after-the-fact write in this system.
 */
export async function raiseAlerts(opts: {
  venueId: string;
  userId: string;
  expenseId?: string;
  module?: string;
  lines: CheckedLine[];
}): Promise<number> {
  let raised = 0;
  for (const line of opts.lines) {
    for (const flag of line.flags) {
      await db.createDocument(DB_ID, 'purchase_alerts', ID.unique(), {
        venue_id: opts.venueId,
        ingredient_id: line.ingredientId,
        // The name as it was. An alert still has to read after somebody
        // renames or archives the ingredient behind it.
        ingredient_name: line.name.slice(0, 160),
        unit: line.unit ?? '',
        expense_id: opts.expenseId ?? '',
        kind: flag.kind,
        // Both figures stored rather than recomputed. What a thing usually
        // costs moves as more is bought, and an alert that worked it out again
        // would stop describing the moment it was raised.
        value: Math.round(flag.value),
        typical: Math.round(flag.typical),
        rise_bp: flag.riseBp,
        seen: flag.seen,
        module: opts.module ?? 'kitchen',
        created_by: opts.userId,
        acknowledged: false,
      }).catch(() => undefined);
      raised += 1;
    }
  }
  return raised;
}

export const loadAlerts = async (venueId: string): Promise<PurchaseAlert[]> =>
  (await listAll<PurchaseAlert>('purchase_alerts', [Query.equal('venue_id', venueId)]).catch(
    () => [] as PurchaseAlert[],
  )).sort((a, b) => b.$createdAt.localeCompare(a.$createdAt));

/**
 * Tick one off, or put it back.
 *
 * Both directions, because "that was fine" is a judgement somebody can make
 * wrongly at half past eleven and want back. Nothing is deleted either way:
 * the question was asked and that stays true.
 */
export async function acknowledgeAlert(opts: {
  alert: PurchaseAlert;
  userId: string;
  acknowledged: boolean;
  note?: string;
}): Promise<void> {
  await db.updateDocument(DB_ID, 'purchase_alerts', opts.alert.$id, {
    acknowledged: opts.acknowledged,
    acknowledged_by: opts.acknowledged ? opts.userId : '',
    acknowledged_at: opts.acknowledged ? new Date().toISOString() : null,
    note: (opts.note ?? opts.alert.note ?? '').slice(0, 500),
  });
}
