/**
 * How long an order should take, and when it is late.
 *
 * Split out of `orders.ts` because that file opens a database connection on
 * import, and these are the figures a customer is quoted and a kitchen is
 * judged by. They are worth being able to check without selling anything.
 *
 * Pure. Parameters are described by the fields they read, so this file imports
 * nothing at runtime.
 */

/** The three statuses where a ticket is somebody's to cook. */
const COOKING = ['PENDING', 'ACCEPTED', 'PREPARING'];

/**
 * The longest wait this system will ever quote, whatever the arithmetic says.
 *
 * Not because the food will always arrive by then, on a bad night it will not,
 * but because a number past this stops being useful. "One hour" is a decision
 * point: somebody reads it and either waits or leaves. "An hour and fifty" is a
 * number nobody believes and nobody plans around, and quoting it does more
 * damage than the honest cap plus a cook who keeps people posted.
 */
export const MAX_ETA_MINUTES = 60;

/**
 * The wait to show, never more than the cap.
 *
 * Applied on the way out as well as on the way in. Capping only where the
 * figure is worked out leaves every row written before the cap existed, and
 * anything a future change forgets to clamp, free to put "about 95 minutes" in
 * front of a customer. Reading is the last chance to be sure, and it costs
 * nothing to take it.
 *
 * Returns null when there is no estimate at all, so a caller can leave the
 * whole line out rather than print a made-up number.
 */
export function shownEta(minutes?: number | null): number | null {
  if (!minutes || minutes <= 0) return null;
  return Math.min(MAX_ETA_MINUTES, Math.round(minutes));
}

/**
 * The cooking time alone: the prep time set on each dish, added up.
 *
 * This is what the kitchen is judged by, and it is deliberately not what the
 * customer is quoted. Their wait includes queueing behind other tickets, which
 * is time before a cook touches this one. Measuring a kitchen by it would hand
 * them extra minutes on exactly the nights being late matters most, and only
 * because other people were also waiting.
 *
 * Added rather than taking the longest, for the same reason as everywhere else
 * here: a cook with a curry and a grill on one ticket does them one after the
 * other. Not multiplied by quantity, three of one thing goes in one pan.
 */
export function cookMinutes(lines: { prep_minutes?: number }[]): number {
  return Math.max(1, Math.round(lines.reduce((sum, l) => sum + (l.prep_minutes ?? 15), 0)));
}

/** The customer's wait: cooking time plus the queue, capped. */
export function estimateMinutes(lines: { prep_minutes?: number }[], queueAhead = 0): number {
  return Math.min(MAX_ETA_MINUTES, Math.max(1, Math.round(cookMinutes(lines) + queueAhead)));
}

/**
 * How long the tickets already on the pass will take before this one is
 * started.
 *
 * The kitchen is treated as working through one ticket at a time, the same
 * assumption that makes the dishes within an order add up rather than overlap,
 * and for the same reason. Two cooks who genuinely work in parallel will beat
 * this estimate, and a customer told twenty-five who eats in eighteen is a
 * customer who comes back.
 *
 * Cooking time, not the wait each ticket's own customer was quoted. Those are
 * different numbers, and using the wrong one compounds: an order's quoted wait
 * already contains the queue that was ahead of IT, so adding up quoted waits
 * counts the same stove time again for every order that has joined since.
 *
 * Nothing comes off a ticket no cook has accepted, however long it has been
 * sitting there. Orders sitting READY are excluded entirely; the cooking is
 * done and they are waiting on a person, not on a stove.
 */
export function queueMinutes(
  pending: {
    status: string;
    prep_minutes?: number;
    eta_minutes?: number;
    accepted_at?: string;
    $createdAt: string;
  }[],
  now: number = Date.now(),
): number {
  let ahead = 0;
  for (const o of pending) {
    if (!COOKING.includes(o.status)) continue;
    const work = o.prep_minutes ?? o.eta_minutes ?? 15;
    const started = o.accepted_at ? Date.parse(o.accepted_at) : NaN;
    const elapsed = Number.isFinite(started) ? Math.max(0, (now - started) / 60_000) : 0;
    ahead += Math.max(0, work - elapsed);
  }
  return Math.round(ahead);
}

/**
 * How long a ticket already on the pass should have taken, in minutes.
 *
 * One definition, read by the screen that shows the Late pill and by whatever
 * decides to make a noise. Two copies of this rule is two answers to "is this
 * late", and the one that goes wrong is always the one nobody is looking at.
 *
 * `prep_minutes` on the order is the answer whenever it is there. The fallbacks
 * are for orders placed before it was stored: each line's due time was stamped
 * as "now plus its prep", so the difference gives that prep back. Twenty
 * minutes if even that is missing, a guess that pings beats a blank that never
 * does.
 */
export function dueMinutes(
  order: { prep_minutes?: number; $createdAt: string },
  lines: { due_at?: string; prep_minutes?: number }[] = [],
): number {
  if (order.prep_minutes) return order.prep_minutes;

  const fromLines = lines.reduce((sum, l) => sum + (l.prep_minutes ?? 0), 0);
  if (fromLines > 0) return fromLines;

  const placed = Date.parse(order.$createdAt);
  const summed = lines.reduce((sum, l) => {
    const due = l.due_at ? Date.parse(l.due_at) : 0;
    return sum + (due > placed ? Math.round((due - placed) / 60_000) : 0);
  }, 0);
  return summed || 20;
}

/**
 * Late is late: past the time allowed, with nothing added on.
 *
 * There used to be a five minute cushion here. A twenty minute dish did not
 * count as late, did not show the pill and did not ring until twenty-five, so
 * every order quietly carried five minutes the customer was never told about
 * and nobody in the kitchen could see. Worse, it was five minutes of the wait
 * spent with no signal at all, which is exactly the stretch where a nudge
 * still recovers the order. By the time it rang, the food was five minutes
 * late and the customer had usually noticed first.
 *
 * So the rule is the promise: the moment an order passes the time allowed for
 * it, it is late, it says so, and it rings. The countdown on the ticket was
 * already showing that instant — "due now", then "1 min over" — so this is
 * also the alarm finally agreeing with the number a cook has been watching.
 *
 * Food already cooked keeps a short wait, and this is not the same thing. A
 * plate going up is not late while somebody walks to the counter to fetch it;
 * that delay is the collection, not the cooking, and pinging the instant a
 * cook presses Ready would ring on every single order.
 *
 * Anything else — waiting to be accepted, cancelled, paid — is not this
 * question. A ticket nobody has acknowledged has its own alarm.
 */
export function isOverdue(
  order: { status: string; $createdAt: string; $updatedAt?: string },
  dueMins: number,
  now: number = Date.now(),
  readyGraceMinutes = 5,
): boolean {
  if (COOKING.includes(order.status) && order.status !== 'PENDING') {
    const placed = Date.parse(order.$createdAt);
    return Number.isFinite(placed) && now > placed + dueMins * 60_000;
  }

  if (order.status === 'READY') {
    const since = Date.parse(order.$updatedAt ?? '');
    return Number.isFinite(since) && now > since + readyGraceMinutes * 60_000;
  }

  return false;
}

/**
 * How far past its time an order is, in whole minutes. Negative while there is
 * still time left, so one number covers "12 min left" and "3 min over" and the
 * two can never drift apart.
 */
export function minutesOver(
  order: { $createdAt: string },
  dueMins: number,
  now: number = Date.now(),
): number {
  const placed = Date.parse(order.$createdAt);
  if (!Number.isFinite(placed)) return 0;
  return Math.round((now - placed) / 60_000 - dueMins);
}

/**
 * Work back from when the customer wants it to when the kitchen must start,
 * using the slowest dish on the order plus a small buffer.
 */
export function fireTimeFor(
  lines: { menu_item_id: string }[],
  scheduledFor: Date,
  prepMinutesById: Record<string, number>,
  buffer = 5,
): Date {
  const longest = Math.max(0, ...lines.map((l) => prepMinutesById[l.menu_item_id] ?? 10));
  return new Date(scheduledFor.getTime() - (longest + buffer) * 60_000);
}

/* ------------------------------------------------------------ cancellation */

/**
 * How long after sending an order a customer may still call it back.
 *
 * Deliberately short. Long enough for "that was the wrong thing, I pressed send
 * too fast", which is the whole of what this is for, and short enough that a
 * kitchen is not throwing away food somebody has already started.
 *
 * The browser uses this to decide what to show; the server checks it again for
 * real, because the clock on a phone is whatever its owner sets it to.
 */
export const CANCEL_WINDOW_MS = 2 * 60 * 1000;

/** Milliseconds left on the cancel window, or 0 once it has closed. */
export function cancelWindowLeft(order: { $createdAt: string }, now: number = Date.now()): number {
  const placed = Date.parse(order.$createdAt);
  if (!Number.isFinite(placed)) return 0;
  return Math.max(0, CANCEL_WINDOW_MS - (now - placed));
}

/* ------------------------------------------------------- a ticket's lines */

/**
 * How long to wait before an empty ticket is treated as a real problem.
 *
 * An order and the lines on it are two writes, not one. The kitchen is told
 * about the order the instant it exists, which is before the lines have
 * finished being written, so a ticket with nothing on it is the normal state
 * for a second or two and a lasting fault after that.
 */
export const LINES_GRACE_MS = 60_000;

/**
 * What a ticket should say about its own lines.
 *
 * Three states, and they were being shown as one message, then as the wrong
 * one. An empty list a moment after the order arrived means the lines are
 * still on their way. The same empty list a minute later means somebody has a
 * ticket they cannot cook from, and telling them that is the whole point.
 *
 * Announcing it immediately is worse than saying nothing: "check with whoever
 * sent it" on every single order teaches a kitchen to ignore the one time it
 * is true.
 */
export function ticketLines(
  order: { $createdAt: string },
  lines: unknown[] | undefined,
  now: number = Date.now(),
): 'ready' | 'loading' | 'missing' {
  if (lines && lines.length > 0) return 'ready';
  const placed = Date.parse(order.$createdAt);
  if (!Number.isFinite(placed)) return 'loading';
  return now - placed > LINES_GRACE_MS ? 'missing' : 'loading';
}
