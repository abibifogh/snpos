/**
 * Which tab of Group bookings a booking belongs on.
 *
 * The page opens on what needs somebody: a decision, then a guest's request,
 * then what is coming up. A booking can be in two of those at once — waiting
 * for a decision AND asking for a change — and appears in both, because both
 * are things to do.
 *
 * Pure. Imports nothing at runtime.
 */

export type BookingTab = 'decide' | 'changes' | 'upcoming' | 'past' | 'all';

export const BOOKING_TAB_WORDS: Record<BookingTab, string> = {
  decide: 'Needs a decision',
  changes: 'Guest asked for a change',
  upcoming: 'Upcoming',
  past: 'Past',
  all: 'All',
};

interface Tabbable {
  $id: string;
  status?: string;
  first_at?: string;
  last_at?: string;
}

const lastOf = (b: Tabbable): string => b.last_at || b.first_at || '';

/** Whether this booking is on this tab. `asking` is the bookings with an open change request. */
export function onTab(b: Tabbable, tab: BookingTab, now: Date, asking: Set<string>): boolean {
  const over = lastOf(b) !== '' && new Date(lastOf(b)).getTime() < now.getTime();
  const off = b.status === 'cancelled' || b.status === 'refused';
  if (tab === 'all') return true;
  if (tab === 'decide') return (b.status ?? 'pending') === 'pending' && !over;
  if (tab === 'changes') return asking.has(b.$id);
  if (tab === 'upcoming') return !over && !off;
  return over;
}

/** The bookings on a tab, in the order they are dealt with: soonest first, or latest first for the past. */
export function bookingsOnTab<T extends Tabbable>(rows: T[], tab: BookingTab, now: Date, asking: Set<string>): T[] {
  const mine = rows.filter((b) => onTab(b, tab, now, asking));
  const at = (b: T) => b.first_at ?? '';
  return tab === 'past' || tab === 'all'
    ? mine.sort((a, b) => at(b).localeCompare(at(a)))
    : mine.sort((a, b) => at(a).localeCompare(at(b)));
}

/** How many on each tab, for the counts on the tab buttons. */
export function tabCounts(rows: Tabbable[], now: Date, asking: Set<string>): Record<BookingTab, number> {
  const out = { decide: 0, changes: 0, upcoming: 0, past: 0, all: 0 };
  for (const t of Object.keys(out) as BookingTab[]) out[t] = rows.filter((b) => onTab(b, t, now, asking)).length;
  return out;
}

/** "in 9 days", "tomorrow", "today", "3 days ago": when a booking is, from now. */
export function whenFromNow(at: string | undefined, now: Date): string {
  if (!at) return '';
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day(new Date(at)) - day(now)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
