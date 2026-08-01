/**
 * Availability windows for categories, items and venues.
 *
 * Stored as JSON so a window can be edited without a schema change:
 *   { "mon": [["11:00","15:00"],["18:00","22:00"]], "sat": [["11:00","23:00"]] }
 *
 * A missing day means closed that day. An absent or empty rule means always
 * available — the common case should need no configuration.
 */
export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type Windows = Partial<Record<DayKey, [string, string][]>>;

const DAYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function parseWindows(raw?: string): Windows | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Windows;
    return parsed && Object.keys(parsed).length ? parsed : null;
  } catch {
    return null;
  }
}

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Is `at` inside the rule? No rule means yes. */
export function isAvailable(windows: Windows | null, at: Date = new Date()): boolean {
  if (!windows) return true;
  const day = DAYS[at.getDay()];
  const ranges = windows[day];
  if (!ranges || ranges.length === 0) return false;

  const now = at.getHours() * 60 + at.getMinutes();
  return ranges.some(([from, to]) => {
    const start = minutes(from);
    const end = minutes(to);
    // A window ending before it starts crosses midnight (22:00–02:00).
    return end <= start ? now >= start || now < end : now >= start && now < end;
  });
}

/** The next moment this becomes available, searching up to `days` ahead. */
export function nextAvailable(windows: Windows | null, from: Date = new Date(), days = 7): Date | null {
  if (!windows) return from;
  const cursor = new Date(from);
  for (let d = 0; d <= days; d++) {
    const ranges = windows[DAYS[cursor.getDay()]] ?? [];
    for (const [start] of [...ranges].sort()) {
      const candidate = new Date(cursor);
      const [h, m] = start.split(':').map(Number);
      candidate.setHours(h, m || 0, 0, 0);
      if (candidate > from) return candidate;
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return null;
}

export const describeWindows = (w: Windows | null): string =>
  !w ? 'Always available' : DAYS.filter((d) => w[d]?.length).map((d) => d[0].toUpperCase() + d.slice(1)).join(', ') || 'Never';
