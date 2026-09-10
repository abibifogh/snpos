import { listAll, Query } from './client';
import { pendingBarChecks, loadLocations } from './stock';
import { filedCounts } from './bar-count';
import { pendingCounts, pendingShelfLines } from './consignment';
import { loadOpenShifts } from './shifts';
import { tabExposure } from './tab-store';
import { waitingList } from './waiting';
import type { WaitingItem, WaitingSpend, WaitingTabShift } from './waiting';
import type { Shift } from './shifts';
import type { StaffProfile } from './types';
import { nameBook } from './staff-words';

/**
 * Everything waiting for somebody senior, read once.
 *
 * The rules that shape the rows are in waiting.ts and import nothing; this
 * goes and gets the rows. Shared by the Waiting for you page and the Today
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

  const names = nameBook(staff);

  // A bar count is named by the shift it was taken on, which the rows do not carry.
  const barCounts = filedCounts(checks);
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
    shiftCodes: Object.fromEntries(shifts.map((s) => [s.$id, s.code])),
    storeNames: Object.fromEntries(places.map((p) => [p.$id, p.name])),
    categoryNames: Object.fromEntries(categories.map((c) => [c.key, c.name])),
    money,
  });

  return {
    items,
    names,
    spends: new Map(pendingSpends.map((s) => [s.$id, s])),
    tabShifts: new Map(tabShifts.map((s) => [s.$id, s])),
  };
}
