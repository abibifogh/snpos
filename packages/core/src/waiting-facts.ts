import { listAll, Query } from './client';
import { pendingCleanLogs } from './cleaning-store';
import { reviewWords } from './cleaning';
import { pendingBarChecks, loadLocations, replacedAmong } from './stock';
import { filedCounts, countSide, liveCount } from './bar-count';
import type { FiledCheck } from './bar-count';
import { pendingCounts, pendingShelfLines } from './consignment';
import { loadOpenShifts } from './shifts';
import { tabExposure } from './tab-store';
import { waitingList } from './waiting';
import type { WaitingItem, WaitingSpend, WaitingTabShift } from './waiting';
import type { Shift } from './shifts';
import type { StaffProfile } from './types';
import { nameBook } from './staff-words';
import { loadSellingPrices } from './staff-charges-store';
import { atSellingPrice } from './waiting-lines';
import { ordersWaiting } from './purchase-orders-store';

/**
 * Everything waiting for somebody senior, read once.
 *
 * The rules that shape the rows are in waiting.ts and import nothing; this
 * goes and gets the rows. Shared by the Approvals page and the Today
 * dashboard, so the two cannot count differently. Each queue fails soft to
 * "nothing waiting" except the shifts, which fail loud: a list that cannot
 * see the shifts must not say nothing is waiting on them.
 */
export async function loadWaiting(venueId: string, money: (minor: number) => string): Promise<{
  items: WaitingItem[];
  /** Who, by user id and by profile id. */
  names: Map<string, string>;
  /** The pending spends by id, for the words a refusal needs. */
  spends: Map<string, WaitingSpend & { source?: string }>;
  /** The open shifts with tabs on them, by id, for the release modal. */
  tabShifts: Map<string, WaitingTabShift>;
}> {
  const [checks, shopCounts, shelfLines, pendingSpends, places, staff, kitchen, bar, craft, categories] = await Promise.all([
    pendingBarChecks(),
    pendingCounts().catch(() => []),
    pendingShelfLines().catch(() => []),
    listAll<WaitingSpend & { venue_id: string; source?: string }>('shift_expenses', [Query.equal('approval_status', 'pending')])
      .catch(() => [] as (WaitingSpend & { venue_id: string; source?: string })[]),
    loadLocations(venueId).catch(() => []),
    listAll<StaffProfile>('staff_profiles').catch(() => [] as StaffProfile[]),
    loadOpenShifts(venueId, 'kitchen'),
    loadOpenShifts(venueId, 'bar'),
    loadOpenShifts(venueId, 'craft'),
    listAll<{ key: string; name: string }>('expense_categories').catch(() => []),
  ]);
  const orders = await ordersWaiting().catch(() => []);

  const names = nameBook(staff);

  // A bar count is named by the shift it was taken on, which the rows do not carry.
  // Each count says whose shelf it was, so a kitchen count is not listed as the bar's.
  // Valued at what they sell for, not what they cost. See barReviewLines.
  const selling = await loadSellingPrices(checks.map((c) => c.ingredient_id))
    .catch(() => ({} as Record<string, { price: number }>));
  // Lines a later count of the same bottle covers are set aside, not added in.
  // See replacedLines. Fails soft: approving checks again before it applies.
  const replaced = await replacedAmong(checks).catch(() => new Map<string, FiledCheck>());
  const barCounts = filedCounts(atSellingPrice(checks, selling))
    .map((c) => ({ ...liveCount(c, replaced), side: countSide(c.lines) }));
  const shiftIds = [...new Set(barCounts.map((c) => c.shiftId).filter((id) => id && !id.startsWith('store:')))];
  const shifts = shiftIds.length > 0
    ? await listAll<Shift>('shifts', [Query.equal('$id', shiftIds)]).catch(() => [] as Shift[])
    : [];

  // The shifts that cannot close: an open shift with money on tabs.
  const all = [...kitchen, ...bar, ...craft];
  const open = [...new Set(all.map((s) => s.$id))]
    .map((id) => all.find((s) => s.$id === id) as Shift)
    .filter((s) => s.status === 'open');
  const tabShifts: WaitingTabShift[] = await Promise.all(open.map(async (s) => {
    const t = await tabExposure(s.$id, s.module ?? 'kitchen', s.venue_id ?? venueId).catch(() => ({ orders: [], value: 0 }));
    return { $id: s.$id, code: s.code, module: s.module, venue_id: s.venue_id, opened_at: s.opened_at, tabOrders: t.orders.length, tabValue: t.value };
  }));

  const items = waitingList({
    barCounts,
    shopCounts,
    shelfLines: shelfLines.map((w) => ({
      countId: w.countId,
      name: w.line.variant_label ? `${w.line.name_snapshot} · ${w.line.variant_label}` : w.line.name_snapshot,
      expected: w.line.expected,
      counted: w.line.counted,
    })),
    spends: pendingSpends,
    tabShifts,
    orders,
    shiftCodes: Object.fromEntries(shifts.map((s) => [s.$id, s.code])),
    storeNames: Object.fromEntries(places.map((p) => [p.$id, p.name])),
    categoryNames: Object.fromEntries(categories.map((c) => [c.key, c.name])),
    money,
  });

  /*
    Cleaning lists started without their required checks, or with a reading
    outside the safe range: a manager marks each one seen. See cleaning.ts.
  */
  const cleans = await pendingCleanLogs().catch(() => []);
  const cleanItems: WaitingItem[] = cleans.map((l) => {
    const w = reviewWords({ side: l.side, kind: l.kind, answers: l.answers, skipReason: l.skip_reason, deep: l.deep });
    return {
      id: `clean:${l.$id}`, kind: 'clean', title: w.title, detail: w.detail,
      by: l.by_id || undefined, at: l.finished_at || l.$createdAt || '', value: 0,
      ref: { kind: 'clean', logId: l.$id },
    };
  });

  return {
    items: [...items, ...cleanItems],
    names,
    spends: new Map(pendingSpends.map((s) => [s.$id, s])),
    tabShifts: new Map(tabShifts.map((s) => [s.$id, s])),
  };
}
