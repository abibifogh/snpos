import { Query, listAll } from './client';
import { pendingBarChecks } from './stock';
import { hanging } from './ledger';
import { loadFloats, loadCounts } from './imprest';
import { latestCount } from './imprest-rules';
import { loadCashMoves } from './cash-away-store';
import { awaitingBank, safeBalance } from './cash-away';
import type { CloseDayFacts, CloseDayShift } from './close-day';

/**
 * The facts behind Close the day, for one calendar day. Each read fails soft
 * to "nothing there", except the shifts: a list that could not see them must
 * not say the day is finished.
 */
export async function closeDayFacts(venueId: string, day: Date): Promise<CloseDayFacts> {
  const from = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const to = new Date(from.getTime() + 86_400_000);
  const shifts = await listAll<CloseDayShift & { opened_at?: string }>('shifts', [
    // In the order of the index (venue, status, opened_at), so it is used.
    Query.equal('venue_id', venueId),
    Query.equal('status', ['open', 'closed']),
    Query.greaterThanEqual('opened_at', from.toISOString()),
    Query.lessThan('opened_at', to.toISOString()),
  ]);
  const ids = new Set(shifts.map((s) => s.$id));

  const [checks, spends, moves, owed, boxes] = await Promise.all([
    pendingBarChecks().catch(() => []),
    listAll<{ shift_id?: string; amount: number; approval_status?: string }>('shift_expenses', [
      Query.equal('approval_status', 'pending'),
    ]).catch(() => []),
    loadCashMoves(venueId).catch(() => []),
    hanging(venueId).catch(() => ({ momo: 0, card: 0 })),
    loadFloats(venueId).catch(() => []),
  ]);
  const mineSpends = spends.filter((s) => ids.has(s.shift_id ?? ''));
  const boxFacts = await Promise.all(boxes.filter((b) => b.active !== false).map(async (b) => {
    const counts = await loadCounts(b.$id).catch(() => []);
    const last = latestCount(counts);
    return { name: b.name, lastCounted: last ? (last.counted_at ?? last.$createdAt) : undefined };
  }));

  return {
    shifts,
    pendingCountLines: checks.filter((c) => ids.has(c.shift_id ?? '')).length,
    pendingSpends: mineSpends.length,
    pendingSpendTotal: mineSpends.reduce((n, s) => n + (s.amount || 0), 0),
    cashAwaitingBank: awaitingBank(moves).filter((m) => ids.has(m.shift_id ?? '')).reduce((n, m) => n + m.amount, 0),
    inSafe: safeBalance(moves),
    momoHanging: owed.momo,
    cardHanging: owed.card,
    boxes: boxFacts,
    now: Date.now(),
  };
}
