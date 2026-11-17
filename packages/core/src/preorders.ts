/**
 * Pre-orders, as the till and the kitchen see them before and after release.
 *
 * A pre-order is booked FOR a time and goes to the kitchen at its start time
 * (fire_at): its cooking time plus a few minutes before. Until then it is
 * SCHEDULED and no kitchen ticket exists. The server releases it each minute
 * (functions/preorder-fire). If that has not happened two minutes after the
 * start time, whichever till or kitchen screen is open releases it instead,
 * and says so on the order. See releaseOverdue in preorders-store.ts.
 *
 * Pure. Imports nothing at runtime.
 */

/** How long after its start time a screen waits for the server before releasing a pre-order itself. */
export const RELEASE_GRACE_MS = 2 * 60_000;
/** How long before its start time a booked order turns amber. */
export const STARTS_SOON_MS = 30 * 60_000;

export interface Booked {
  $id: string;
  status: string;
  is_preorder?: boolean | null;
  scheduled_for?: string | null;
  fire_at?: string | null;
  fired_at?: string | null;
  released_by?: string | null;
  module?: string | null;
}

/** Still waiting, and past its start time by more than the grace: a screen should release it. */
export function releaseDue(o: Booked, now: number = Date.now(), graceMs: number = RELEASE_GRACE_MS): boolean {
  if (o.status !== 'SCHEDULED' || !o.fire_at) return false;
  const at = Date.parse(o.fire_at);
  return Number.isFinite(at) && now >= at + graceMs;
}

export type BookedStage = 'booked' | 'soon' | 'due' | 'late' | 'sent';

/**
 * Where a pre-order stands. "due" is the two minutes the server has; "late"
 * is past that, still waiting, which a screen will release on its next look.
 */
export function bookedStage(o: Booked, now: number = Date.now()): BookedStage {
  if (o.status !== 'SCHEDULED') return 'sent';
  const at = o.fire_at ? Date.parse(o.fire_at) : NaN;
  if (!Number.isFinite(at)) return 'booked';
  if (now < at - STARTS_SOON_MS) return 'booked';
  if (now < at) return 'soon';
  return now < at + RELEASE_GRACE_MS ? 'due' : 'late';
}

const localDay = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Which day a booked order is for, as the till lists them: today, tomorrow, or neither. */
export function bookedDay(o: Booked, now: Date = new Date()): 'today' | 'tomorrow' | null {
  const when = o.scheduled_for ? new Date(o.scheduled_for) : null;
  if (!when || !Number.isFinite(when.getTime())) return null;
  if (localDay(when) === localDay(now)) return 'today';
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return localDay(when) === localDay(tomorrow) ? 'tomorrow' : null;
}

/**
 * The till's Booked list: pre-orders for today and tomorrow, still waiting or
 * released in the last three hours, soonest first.
 */
export function bookedList<T extends Booked>(orders: T[], now: Date = new Date()): { today: T[]; tomorrow: T[] } {
  const recent = now.getTime() - 3 * 3_600_000;
  const keep = orders.filter((o) => {
    if (!o.is_preorder && o.status !== 'SCHEDULED') return false;
    if (['CANCELLED', 'REJECTED'].includes(o.status)) return false;
    if (o.status !== 'SCHEDULED') {
      const sent = Date.parse(o.fired_at || o.fire_at || '');
      if (!Number.isFinite(sent) || sent < recent) return false;
    }
    return bookedDay(o, now) !== null;
  });
  const by = (a: T, b: T) => String(a.scheduled_for ?? '').localeCompare(String(b.scheduled_for ?? ''));
  return {
    today: keep.filter((o) => bookedDay(o, now) === 'today').sort(by),
    tomorrow: keep.filter((o) => bookedDay(o, now) === 'tomorrow' && o.status === 'SCHEDULED').sort(by),
  };
}

/** The next booked order still waiting, for the till's top bar. */
export function nextBooked<T extends Booked>(orders: T[], now: Date = new Date()): T | null {
  return bookedList(orders, now).today.find((o) => o.status === 'SCHEDULED')
    ?? bookedList(orders, now).tomorrow[0] ?? null;
}

/** "1 h 10 min", "25 min", "now". */
export function inWords(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m <= 0) return 'now';
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}
