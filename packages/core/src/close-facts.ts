import { db, DB_ID, Query, listAll } from './client';
import type { Doc } from './types';
import { pendingBarChecks } from './stock';
import { pendingCounts, pendingShelfLines } from './consignment';
import { hanging, trialBalance } from './ledger';
import { ACCOUNTS } from './accounts';
import type { CloseFacts, CloseShift } from './period-close';

/**
 * Everything the period-close checklist needs, read once.
 *
 * The rules are next door in period-close.ts and import nothing; this is the
 * part that goes and gets the facts. Each read fails soft to "nothing waiting"
 * except the ones that would make a lock unsafe, which fail loud: a checklist
 * that cannot see the shifts must not say the shifts are fine.
 */
export async function closeFacts(venueId: string, through: string): Promise<CloseFacts> {
  const from = `${through.slice(0, 7)}-01`;

  const shifts = await listAll<CloseShift & Doc>('shifts', [Query.equal('venue_id', venueId)]);

  const [barLines, shopCounts, shelfLines, owed, trial, spends] = await Promise.all([
    pendingBarChecks(),
    pendingCounts().catch(() => []),
    pendingShelfLines().catch(() => []),
    hanging(venueId),
    trialBalance(venueId),
    listAll<{ amount: number }>('shift_expenses', [
      Query.equal('venue_id', venueId), Query.equal('approval_status', 'pending'),
    ]).catch(() => [] as { amount: number }[]),
  ]);

  /*
    When each side was last counted, inside the period. Bar and kitchen counts
    are rows on the shift's stock checks and carry no side of their own, so
    they are read back through the shift they belong to; the shop counts in
    its own table.
  */
  const lastCounted: Record<string, string | undefined> = {};
  const since = new Date(`${from}T00:00:00`).toISOString();
  const checks = await listAll<{ shift_id?: string; $createdAt: string }>('shift_stock_checks', [
    Query.greaterThanEqual('$createdAt', since),
  ]).catch(() => [] as { shift_id?: string; $createdAt: string }[]);
  const sideOf = new Map(shifts.map((s) => [s.$id, s.module ?? 'kitchen']));
  for (const c of checks) {
    const side = c.shift_id ? sideOf.get(c.shift_id) : undefined;
    if (!side) continue;
    const d = c.$createdAt.slice(0, 10);
    if (!lastCounted[side] || lastCounted[side]! < d) lastCounted[side] = d;
  }
  const shop = await db.listDocuments(DB_ID, 'stock_counts', [
    Query.equal('status', 'approved'), Query.orderDesc('counted_at'), Query.limit(1),
  ]).catch(() => ({ documents: [] as { counted_at?: string }[] }));
  const lastShop = (shop.documents[0] as { counted_at?: string } | undefined)?.counted_at;
  if (lastShop) lastCounted.craft = lastShop.slice(0, 10);

  const makers = trial.rows.find((r) => r.account_code === ACCOUNTS.owedToMakers)?.balance ?? 0;

  return {
    through,
    from,
    shifts,
    pendingBarLines: barLines.length,
    pendingShopCounts: shopCounts.length,
    pendingSpends: spends.length,
    pendingSpendValue: spends.reduce((s, e) => s + (e.amount || 0), 0),
    pendingShelfChanges: shelfLines.length,
    hanging: owed,
    // A liability is held as a credit; a positive figure here is money owed.
    owedToMakers: Math.max(0, -makers),
    lastCounted,
    trialBalanced: trial.balanced,
  };
}
