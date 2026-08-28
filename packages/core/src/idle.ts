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

/**
 * How long a till may sit asleep before it stops being anybody's.
 *
 * Ten minutes. Short enough that a till left at the end of a shift belongs to
 * nobody by the time the next person reaches it, long enough that stepping
 * away to carry plates and coming back is not a PIN every time.
 *
 * The gap this closes is the one a shared counter actually has. The till asked
 * who was there at boot and whenever somebody pressed Lock — and a tablet that
 * lives on a counter is rebooted about never and locked by hand rarely. So it
 * went to sleep at the end of the evening still signed in as whoever had used
 * it, woke on the first touch the next morning, and handed the whole till to
 * whoever that was: their name off the orders, their permissions ignored, and
 * the till still on the side the last person left it on.
 *
 * That is how a bar-only cashier ended up looking at the craft shop's count
 * sheet with a shift that was not his.
 */
export const LOCK_AFTER_ASLEEP_MS = 10 * 60_000;

export interface SleepingState {
  /** When the screen went to sleep, or 0 if it is awake. */
  asleepSince: number;
  /**
   * Whether anybody could actually get back in.
   *
   * A till where nobody holds a PIN must never lock itself. Asking a question
   * nothing on the device can answer is not a secure till, it is a dead one —
   * the same rule the lock at boot follows.
   */
  anyoneCanUnlock: boolean;
}

/**
 * Should a sleeping till lock itself?
 *
 * Separate from sleeping on purpose. Sleeping is about the screen; locking is
 * about who the till belongs to, and they want different answers. A minute of
 * quiet should dim a screen and must not demand a PIN; an hour of quiet means
 * the person who was standing here has gone.
 */
export function shouldLock(
  state: SleepingState,
  now: number,
  after: number = LOCK_AFTER_ASLEEP_MS,
): boolean {
  if (!state.anyoneCanUnlock) return false;
  if (!state.asleepSince) return false;
  return now - state.asleepSince >= after;
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


/* ------------------------------------------- a screen between two customers */

/**
 * How long a counter screen waits before it clears itself, in milliseconds.
 *
 * Generous on purpose. This is not a screensaver — it throws away a basket
 * somebody was filling — and the cost of being too quick is a customer looking
 * up from reading an allergen label to find their order gone. Two minutes of
 * no touching at all is longer than any pause in choosing and shorter than the
 * gap between two customers.
 */
export const SCREEN_RESET_MS = 120_000;

/**
 * Should a shared screen throw away what is on it and start again?
 *
 * A counter screen serves one stranger after another, and everything left on
 * it belongs to the last one: a half-filled basket, a menu scrolled to the
 * puddings, an order that has been paid for. The next person should walk up to
 * an invitation, never to somebody else's session.
 *
 * Only when nothing is happening, and never while an order is being sent —
 * clearing a basket mid-send would take the order with it while the kitchen
 * has already been told about it.
 */
export function screenShouldReset(
  state: { lastTouchedAt: number; sending?: boolean },
  now: number,
  after: number = SCREEN_RESET_MS,
): boolean {
  if (state.sending) return false;
  return now - state.lastTouchedAt >= after;
}

/**
 * What a device is when the address is asked, and what it may write down.
 *
 * A counter screen is set up by opening the screen link and adding it to the
 * home screen, and the address in the bar at that moment is the last time the
 * token is ever seen: every browser starts an installed app at the manifest's
 * `start_url` and throws the query string away. So the icon on the counter
 * opened the ordinary walk-in menu — no invitation between customers, no
 * staying awake, and a "Your orders" list collecting one stranger's order
 * after another. On an iPad it could not even be worked around by remembering
 * the token, because a home-screen web app there gets its own storage and
 * cannot see what the browser learnt.
 *
 * Three ways in, and they are not equal:
 *
 *   A MATCHED TOKEN says which counter this is. It is the only one that may
 *   write down a venue.
 *   A DECLARATION (`screen=1`, which is what the home-screen icon opens) says
 *   only THAT this is a screen. It grants nothing — screen mode takes things
 *   away, the order history and the receipts, and holds the display awake — so
 *   there is nothing here to protect, and it must never overwrite the answer a
 *   token gave.
 *   NEITHER leaves the device as whatever it already was. Most addresses have
 *   nothing to say on the subject, and an address with nothing to say must not
 *   turn a counter screen back into a phone menu.
 */
export interface ScreenClaim {
  /** A screen token that matched this venue. */
  tokenMatched: boolean;
  /** An address declaring this device a screen, with nothing to prove it. */
  declared: boolean;
  /** An address explicitly turning screen mode off again. */
  turnedOff: boolean;
}

export interface ScreenVerdict {
  /** What this device is now, or null to leave it as it was. */
  screen: boolean | null;
  /** Whether the venue may be written down. Only a token knows it. */
  rememberVenue: boolean;
}

export function screenClaim(claim: ScreenClaim): ScreenVerdict {
  /*
    Off wins. It is the only way back for a device that has been told it is a
    screen, and a way out that can be outvoted is not a way out.
  */
  if (claim.turnedOff) return { screen: false, rememberVenue: false };
  if (claim.tokenMatched) return { screen: true, rememberVenue: true };
  if (claim.declared) return { screen: true, rememberVenue: false };
  return { screen: null, rememberVenue: false };
}
