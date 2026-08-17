/**
 * The screen a till shows when nobody is using it.
 *
 * A counter left on a bright menu all evening burns the panel and tells the
 * room nothing. Between customers what it should show is the time, big enough
 * to read across a room, and one obvious way back in.
 *
 * The rule that matters is what counts as "nobody is using it". A till is not
 * idle because the cashier has not touched it — it is idle because nothing is
 * happening. An order arriving is something happening, so it wakes the screen
 * even though no one touched the glass. Getting that backwards means a ticket
 * lands behind a clock and sits there.
 *
 * Pure. When it sleeps, when it wakes and what it reads can all be checked
 * without a browser.
 */

/** Off by default: a shop that has not asked for this should not get it. */
export const IDLE_MINUTES_DEFAULT = 0;

/** Below this, a slow customer would put the clock up mid-sale. */
export const IDLE_MINUTES_MIN = 1;

export interface IdleState {
  /** When something last happened: a touch, a keypress, an order. */
  lastActiveAt: number;
  /** Minutes of nothing before the clock comes up. 0 turns it off. */
  afterMinutes: number;
  /**
   * Something is part-way through and must not be covered.
   *
   * A payment sheet open with a customer's cash on the counter is the case
   * this exists for: the person is thinking, not absent, and a clock dropping
   * over a half-taken payment is how a till gets a reputation.
   */
  busy?: boolean;
}

export function shouldSleep(state: IdleState, now: number): boolean {
  if (!(state.afterMinutes >= IDLE_MINUTES_MIN)) return false;
  if (state.busy) return false;
  return now - state.lastActiveAt >= state.afterMinutes * 60_000;
}

/** How long until it sleeps, so a timer can be set once instead of polling. */
export function msUntilSleep(state: IdleState, now: number): number {
  if (!(state.afterMinutes >= IDLE_MINUTES_MIN)) return Number.POSITIVE_INFINITY;
  return Math.max(0, state.lastActiveAt + state.afterMinutes * 60_000 - now);
}

export interface ClockFace {
  /** 04:23:55 PM — seconds included, because a stopped clock has to look stopped. */
  time: string;
  /** Monday */
  day: string;
  /** 17 August 2026 */
  date: string;
}

/**
 * The clock, in the venue's own timezone rather than the device's.
 *
 * A tablet set up in another country, or one whose clock was never set, would
 * otherwise put a confidently wrong time on the wall of the shop. The venue's
 * timezone is the one the business runs on.
 */
export function clockFace(at: Date, timeZone?: string): ClockFace {
  const opts = timeZone ? { timeZone } : {};
  const time = new Intl.DateTimeFormat('en-GB', {
    ...opts, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(at).toUpperCase();

  const day = new Intl.DateTimeFormat('en-GB', { ...opts, weekday: 'long' }).format(at);
  const date = new Intl.DateTimeFormat('en-GB', {
    ...opts, month: 'long', day: 'numeric', year: 'numeric',
  }).format(at);

  return { time, day, date };
}

/**
 * What the button says, given whether a shift is open.
 *
 * Telling somebody to open a register they already have open is how a screen
 * loses their trust, so this knows the difference.
 */
export function wakeLabel(hasOpenShift: boolean, module?: string): string {
  if (!hasOpenShift) return 'Open a shift';
  if (module === 'bar') return 'Back to the bar';
  if (module === 'craft') return 'Back to the counter';
  return 'Back to the till';
}
