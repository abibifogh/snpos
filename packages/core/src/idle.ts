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

/* -------------------------------------------- what is worth waking a screen */

/**
 * The statuses that mean an order is still somebody's problem.
 *
 * CLOSED, CANCELLED and REJECTED are not on it. An order being tidied away is
 * not news, and a clock that lifts for one is a clock that lifts all evening,
 * which is the same as not having one.
 */
const LIVE = ['SCHEDULED', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY'];

/**
 * Should this order lift the clock on this screen?
 *
 * Asked in one place because two screens were answering it differently and one
 * of them was not answering it at all. The kitchen woke for its own tickets;
 * the till never woke for anything, so a QR order placed by a customer landed
 * behind a screensaver on the counter it was meant to be seen at.
 *
 * The side matters. A bar till has no business lighting up for a plate of
 * jollof: it cannot cook it, cannot serve it and cannot do anything about it,
 * and a screen that wakes for other people's work stops meaning anything the
 * third time it happens. Absent is the kitchen, as everywhere else.
 *
 * A status CHANGE counts too, not only a new order. A ticket going READY is
 * news to whoever is plating, and it is exactly the moment nobody is touching
 * the screen.
 */
export function wakesScreen(
  order: { status?: string; module?: string; venue_id?: string },
  screen: { module?: string; venueId?: string },
): boolean {
  if (screen.venueId && order.venue_id && order.venue_id !== screen.venueId) return false;
  if ((order.module ?? 'kitchen') !== (screen.module ?? 'kitchen')) return false;
  return LIVE.includes(order.status ?? '');
}

/**
 * The high-water mark of a list of orders: the latest moment any of them moved.
 *
 * For the screens that find out by asking rather than by being told. The live
 * connection drops without saying so — that is why anything reads on a timer
 * at all — and on the poll there is no event to react to, only a list that is
 * now different from the last one.
 *
 * Comparing this against the last mark answers "did anything happen while we
 * were not being told" in one string comparison, with no diffing and no
 * false positives from a list that came back in another order.
 */
export function latestMovement(orders: { $updatedAt?: string; $createdAt?: string }[]): string {
  let latest = '';
  for (const o of orders) {
    const at = o.$updatedAt ?? o.$createdAt ?? '';
    if (at > latest) latest = at;
  }
  return latest;
}
