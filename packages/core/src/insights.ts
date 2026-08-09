/**
 * Turning a pile of orders into something a restaurant owner can act on.
 *
 * The reports page already answered "how much did we take between these two
 * dates". That is a fact, not an insight — it tells you the number and leaves
 * you to know whether it is good. Everything here exists to supply the second
 * half: compared with what?
 *
 * Three questions, because they are asked by different people at different
 * moments and answered by different arithmetic:
 *
 *   Day     — what happened yesterday, and was it a normal day?
 *   Week    — is this week beating last week, and on which days?
 *   Month   — is the business growing, once a bad Tuesday is averaged out?
 *
 * All pure functions over rows already loaded. Nothing here reads the database,
 * so the page, the printed report and the nightly email can all use the same
 * arithmetic and cannot disagree about last Tuesday.
 */

export type Grain = 'day' | 'week' | 'month';

export interface MoneyRow {
  /** ISO timestamp the thing happened. */
  at: string;
  amount: number;
}

export interface Bucket {
  /** Sort key and identity: 2026-08-06, 2026-W32, 2026-08. */
  key: string;
  /** What a person reads on an axis: "Thu 6", "w/c 3 Aug", "Aug". */
  label: string;
  /** The full version, for a tooltip: "Thursday 6 August". */
  full: string;
  start: Date;
  end: Date;
  revenue: number;
  cost: number;
  orders: number;
  covers: number;
}

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** Local midnight. Buckets must line up with the day a restaurant worked. */
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * Monday, because a restaurant's week is not the calendar's.
 *
 * A week starting Sunday splits the weekend across two rows, which is the one
 * comparison a hospitality business most wants whole.
 */
export function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  const back = (s.getDay() + 6) % 7;
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() - back);
}

export const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

const KEY: Record<Grain, (d: Date) => string> = {
  day: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  week: (d) => {
    const s = startOfWeek(d);
    return `${s.getFullYear()}-W${pad(Math.floor((s.getTime() - startOfYear(s)) / (7 * DAY)) + 1)}`;
  },
  month: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
};

const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1).getTime();

const BUCKET_START: Record<Grain, (d: Date) => Date> = {
  day: startOfDay,
  week: startOfWeek,
  month: startOfMonth,
};

function bucketEnd(grain: Grain, start: Date): Date {
  if (grain === 'day') return new Date(start.getTime() + DAY - 1);
  if (grain === 'week') return new Date(start.getTime() + 7 * DAY - 1);
  return new Date(start.getFullYear(), start.getMonth() + 1, 1, 0, 0, 0, -1);
}

function labelFor(grain: Grain, start: Date): { label: string; full: string } {
  if (grain === 'day') {
    return {
      label: start.toLocaleDateString([], { weekday: 'short', day: 'numeric' }),
      full: start.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }),
    };
  }
  if (grain === 'week') {
    const end = new Date(start.getTime() + 6 * DAY);
    return {
      label: `${start.getDate()} ${start.toLocaleDateString([], { month: 'short' })}`,
      full: `${start.toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString([], { day: 'numeric', month: 'short' })}`,
    };
  }
  return {
    label: start.toLocaleDateString([], { month: 'short' }),
    full: start.toLocaleDateString([], { month: 'long', year: 'numeric' }),
  };
}

export interface SeriesInput {
  /** Paid orders: what came in. */
  revenue: { at: string; amount: number; covers?: number }[];
  /** Expenses recorded: what went out. */
  cost: MoneyRow[];
  grain: Grain;
  from: Date;
  to: Date;
}

/**
 * Every bucket in the range, including the empty ones.
 *
 * A closed Monday must appear as a zero, not be missing. A line that skips the
 * days with no takings draws a business that trades every day, which is the
 * opposite of what the chart is for.
 */
export function series(input: SeriesInput): Bucket[] {
  const { grain, from, to } = input;
  const buckets = new Map<string, Bucket>();

  let cursor = BUCKET_START[grain](from);
  const limit = to.getTime();
  // A guard rather than `while (true)`: a bad date from a URL should draw an
  // empty chart, not spin the browser to a halt.
  for (let i = 0; i < 800 && cursor.getTime() <= limit; i++) {
    const key = KEY[grain](cursor);
    const { label, full } = labelFor(grain, cursor);
    buckets.set(key, {
      key, label, full,
      start: new Date(cursor),
      end: bucketEnd(grain, cursor),
      revenue: 0, cost: 0, orders: 0, covers: 0,
    });
    cursor =
      grain === 'day' ? new Date(cursor.getTime() + DAY)
      : grain === 'week' ? new Date(cursor.getTime() + 7 * DAY)
      : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  for (const r of input.revenue) {
    const b = buckets.get(KEY[grain](BUCKET_START[grain](new Date(r.at))));
    if (!b) continue;
    b.revenue += r.amount;
    b.orders += 1;
    b.covers += r.covers ?? 1;
  }
  for (const c of input.cost) {
    const b = buckets.get(KEY[grain](BUCKET_START[grain](new Date(c.at))));
    if (b) b.cost += c.amount;
  }

  return [...buckets.values()];
}

export interface Change {
  now: number;
  before: number;
  /** Difference in minor units. */
  delta: number;
  /** Proportion, or null when there is nothing to compare against. */
  ratio: number | null;
}

/**
 * This period against the one before it.
 *
 * `ratio` is null rather than zero or infinity when the earlier figure is zero.
 * "Up 100%" from nothing is not a fact about the business, it is a division
 * nobody checked, and it is how a first week of trading reads as a triumph.
 */
export function change(now: number, before: number): Change {
  return {
    now,
    before,
    delta: now - before,
    ratio: before === 0 ? null : (now - before) / before,
  };
}

/** The same length of time, immediately before the given range. */
export function previousRange(from: Date, to: Date): { from: Date; to: Date } {
  const span = to.getTime() - from.getTime();
  return {
    from: new Date(from.getTime() - span - 1),
    to: new Date(from.getTime() - 1),
  };
}

export interface DayOfWeekRow {
  /** 0 = Monday, matching startOfWeek. */
  day: number;
  name: string;
  revenue: number;
  /** How many of that weekday the range actually contained. */
  count: number;
  average: number;
}

/**
 * Which days of the week actually earn.
 *
 * Averaged rather than totalled: a range of 30 days holds five Mondays and four
 * Sundays, so totals would say Monday is the better day when it is only the
 * more frequent one. That mistake reads as a fact and gets acted on.
 */
export function byDayOfWeek(days: Bucket[]): DayOfWeekRow[] {
  const acc = Array.from({ length: 7 }, (_, i) => ({ day: i, revenue: 0, count: 0 }));
  for (const b of days) {
    const idx = (b.start.getDay() + 6) % 7;
    acc[idx].revenue += b.revenue;
    acc[idx].count += 1;
  }
  const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return acc.map((r) => ({
    ...r,
    name: names[r.day],
    average: r.count ? Math.round(r.revenue / r.count) : 0,
  }));
}

export interface Standout {
  best: Bucket | null;
  worst: Bucket | null;
  /** Mean across buckets that had any trade at all. */
  typical: number;
}

/**
 * The best and worst, and what normal looks like.
 *
 * Days with no trade are left out of the average. A restaurant that closes on
 * Mondays would otherwise be told its typical day is a fifth worse than every
 * day it actually opens, which makes every real day look like an achievement.
 */
export function standout(buckets: Bucket[]): Standout {
  const traded = buckets.filter((b) => b.revenue > 0);
  if (traded.length === 0) return { best: null, worst: null, typical: 0 };
  const sorted = [...traded].sort((a, b) => b.revenue - a.revenue);
  return {
    best: sorted[0],
    worst: sorted[sorted.length - 1],
    typical: Math.round(traded.reduce((s, b) => s + b.revenue, 0) / traded.length),
  };
}

/** How the delta should read to somebody glancing at it. */
export const changeTone = (c: Change, goodWhenUp = true): 'good' | 'bad' | 'flat' => {
  if (c.ratio === null || Math.abs(c.ratio) < 0.005) return 'flat';
  const up = c.delta > 0;
  return up === goodWhenUp ? 'good' : 'bad';
};

export const asPercent = (ratio: number | null): string =>
  ratio === null ? '—' : `${ratio > 0 ? '+' : ''}${(ratio * 100).toFixed(ratio > -0.1 && ratio < 0.1 ? 1 : 0)}%`;
