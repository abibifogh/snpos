/**
 * What today looks like, as figures a dashboard can show.
 *
 * The old dashboard counted menu items and venues, which is a fact about
 * the setup and says nothing about the day. This answers the questions an
 * owner asks at eight in the evening: what has each side taken, against
 * the same night last week; who is on; what is waiting for me; what needs a
 * look before tomorrow; how did the evening run hour by hour; what sold.
 *
 * Pure. Imports nothing at runtime. The reads are in today-facts.ts.
 */

export type TradeSide = 'kitchen' | 'bar' | 'craft';
const SIDES: TradeSide[] = ['kitchen', 'bar', 'craft'];

export interface TodayOrder {
  $id: string;
  module?: string;
  payment_status?: string;
  status?: string;
  guest_count?: number;
}

export interface TodayPayment {
  order_id: string;
  method_id: string;
  amount: number;
  status?: string;
  $createdAt: string;
}

export interface TodayLine {
  order_id: string;
  name_snapshot: string;
  variant_label?: string;
  qty: number;
  status?: string;
}

export interface Takings {
  /** Money taken, tips excluded, per side. */
  bySide: Record<TradeSide, number>;
  /** Everything, however it was paid. */
  total: number;
  byKind: { cash: number; card: number; mobile_money: number; other: number };
  /** Guests on paid bistro orders. */
  covers: number;
  /** Paid orders per side. */
  orders: Record<TradeSide, number>;
}

const sideOf = (o: { module?: string } | undefined): TradeSide =>
  o?.module === 'bar' ? 'bar' : o?.module === 'craft' ? 'craft' : 'kitchen';

/**
 * What was taken, from the payments, attributed through their orders.
 *
 * Payments carry no side of their own; the order knows. Voided and refunded
 * payments were never money. A payment whose order is not in the window
 * (paid today for a bill from yesterday) still counts today, on the side of
 * whatever order it names, or the bistro when the order is not known.
 */
export function takingsOf(
  orders: TodayOrder[],
  payments: TodayPayment[],
  methods: { $id: string; kind?: string }[],
): Takings {
  const byId = new Map(orders.map((o) => [o.$id, o]));
  const bySide: Record<TradeSide, number> = { kitchen: 0, bar: 0, craft: 0 };
  const byKind = { cash: 0, card: 0, mobile_money: 0, other: 0 };
  let total = 0;
  for (const p of payments) {
    if (p.status === 'voided' || p.status === 'refunded') continue;
    const amount = p.amount || 0;
    bySide[sideOf(byId.get(p.order_id))] += amount;
    const kind = methods.find((m) => m.$id === p.method_id)?.kind ?? 'other';
    byKind[(kind in byKind ? kind : 'other') as keyof typeof byKind] += amount;
    total += amount;
  }
  const paid = orders.filter((o) => o.payment_status === 'paid');
  const count: Record<TradeSide, number> = { kitchen: 0, bar: 0, craft: 0 };
  for (const o of paid) count[sideOf(o)] += 1;
  const covers = paid.filter((o) => sideOf(o) === 'kitchen').reduce((s, o) => s + (o.guest_count || 1), 0);
  return { bySide, total, byKind, covers, orders: count };
}

/** Up or down against the same night last week, as a proportion; null when there is nothing to compare. */
export function against(now: number, before: number): number | null {
  return before === 0 ? null : (now - before) / before;
}

/** "+12%" or "−9%", or nothing. */
export function percentWords(ratio: number | null): string {
  if (ratio === null) return '';
  const pct = Math.round(ratio * 100);
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}%`;
}

/**
 * Money taken, hour by hour, in the reader's own clock.
 *
 * The admin is opened where the business is, so the browser's hour is the
 * business's hour. Twenty-four slots so a bar that trades past midnight is
 * not cut off at eleven.
 */
export function byHour(payments: TodayPayment[]): number[] {
  const out = new Array<number>(24).fill(0);
  for (const p of payments) {
    if (p.status === 'voided' || p.status === 'refunded') continue;
    const h = new Date(p.$createdAt).getHours();
    if (Number.isFinite(h)) out[h] += p.amount || 0;
  }
  return out;
}

/**
 * The hours worth drawing: from the first hour with money on either day to
 * the last, never fewer than four, so a quiet morning does not shrink the
 * chart to one bar.
 */
export function tradingHours(today: number[], before: number[]): number[] {
  const busy = today.map((v, h) => (v > 0 || before[h] > 0 ? h : -1)).filter((h) => h >= 0);
  if (busy.length === 0) return [11, 12, 13, 14];
  const first = Math.max(0, Math.min(busy[0], 23 - 3));
  const last = Math.max(busy[busy.length - 1], first + 3);
  const hours: number[] = [];
  for (let h = first; h <= last; h += 1) hours.push(h);
  return hours;
}

/** What sold most today, by the number of them, void lines left out. */
export function topSellers(lines: TodayLine[], n = 5): { name: string; qty: number }[] {
  const by = new Map<string, number>();
  for (const l of lines) {
    if (l.status === 'void') continue;
    const name = l.variant_label ? `${l.name_snapshot} · ${l.variant_label}` : l.name_snapshot;
    by.set(name, (by.get(name) ?? 0) + (l.qty || 0));
  }
  return [...by.entries()]
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name))
    .slice(0, n);
}

/** "3h 12m" since a shift opened. */
export function openForWords(openedAt: string, now: string): string {
  const ms = Date.parse(now) - Date.parse(openedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** The day, as the business would write it, from a clock reading. */
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Today, yesterday, and the same weekday last week, as local day keys. */
export function compareDays(now: Date): { today: string; yesterday: string; lastWeek: string } {
  const d = (back: number) => {
    const x = new Date(now);
    x.setDate(x.getDate() - back);
    return dayKey(x);
  };
  return { today: d(0), yesterday: d(1), lastWeek: d(7) };
}

/** The sides that trade, in the order the cards show them. */
export const sidesOn = (mods: Record<TradeSide, boolean>): TradeSide[] => SIDES.filter((s) => mods[s]);
