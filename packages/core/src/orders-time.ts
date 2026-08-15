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
/**
 * How long a ticket ahead will occupy the stove.
 *
 * `prep_minutes` is the answer. The quoted wait is a last resort for rows
 * written before prep time was stored — and it is NOT usable at all on an
 * order placed before opening, because that quote contains the hour spent
 * waiting for the doors. Charging that hour as stove time would add it to
 * every order behind, and then again to every order behind those: four
 * pre-orders and the last one is quoted most of the afternoon.
 *
 * Fifteen minutes is the fallback of last resort either way. A guess that is
 * roughly a dish beats a number that is certainly a building being shut.
 */
function cookTimeOf(o: { prep_minutes?: number; eta_minutes?: number; placed_while_closed?: boolean }): number {
  if (o.prep_minutes) return o.prep_minutes;
  if (o.eta_minutes && !o.placed_while_closed) return o.eta_minutes;
  return 15;
}

export function queueMinutes(
  pending: {
    status: string;
    prep_minutes?: number;
    eta_minutes?: number;
    placed_while_closed?: boolean;
    accepted_at?: string;
    $createdAt: string;
  }[],
  now: number = Date.now(),
): number {
  let ahead = 0;
  for (const o of pending) {
    if (!COOKING.includes(o.status)) continue;
    const work = cookTimeOf(o);
    const started = o.accepted_at ? Date.parse(o.accepted_at) : NaN;
    const elapsed = Number.isFinite(started) ? Math.max(0, (now - started) / 60_000) : 0;
    ahead += Math.max(0, work - elapsed);
  }
  return Math.round(ahead);
}

/**
 * How long a ticket had, from the moment it was placed.
 *
 * One definition, read by the screen that shows the Late pill and by whatever
 * decides to make a noise. Two copies of this rule is two answers to "is this
 * late", and the one that goes wrong is always the one nobody is looking at.
 *
 * The wait the customer was QUOTED, which is the cooking time plus everything
 * that was already on the pass in front of them. Not the cooking time alone.
 *
 * Those two used to be different numbers here, and the clock had already been
 * moved to start when the order was placed — so a ticket was timed from the
 * moment somebody pressed send and judged against the minutes its own food
 * takes, with the twenty minutes it spent queueing behind four other orders
 * counted against the kitchen and given to nobody. On a quiet pass they are
 * the same figure and it looked right. On a busy one every ticket went red
 * through no fault of the cook, which is precisely when a red ticket needed to
 * mean something.
 *
 * Late now means the promise was broken: the customer was told about half an
 * hour, and half an hour has gone. That is the only definition of late that a
 * customer would recognise, and it is the one the kitchen is actually working
 * to.
 *
 * `prep_minutes` is still the right answer for "how long is this dish", and
 * the ticket says both — see the countdown, which shows the budget and names
 * the cooking time inside it.
 */
export function dueMinutes(
  order: { eta_minutes?: number; prep_minutes?: number; $createdAt: string },
  lines: { due_at?: string; prep_minutes?: number }[] = [],
): number {
  // What they were told, which the server re-checks against the real queue a
  // moment after the order lands.
  if (order.eta_minutes) return order.eta_minutes;
  // Orders from before the wait was stored, and any the server never reached.
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
 * Food already cooked is not late, and the clock on it stops.
 *
 * The kitchen was asked to have it ready by a time and it was ready by that
 * time; whatever happens next is the collection, and a cook standing at a pass
 * can do nothing about a customer who has not come for their food. A Late tag
 * that stays on a finished plate is the kitchen being marked down for
 * somebody else's delay, and it crowds out the tags that are still theirs to
 * act on. What IS worth showing on a finished ticket is whether it has been
 * paid for — see the pills on the ticket head.
 *
 * Anything else — waiting to be accepted, cancelled, paid — is not this
 * question. A ticket nobody has acknowledged has its own alarm.
 */
export function isOverdue(
  order: { status: string; $createdAt: string },
  dueMins: number,
  now: number = Date.now(),
): boolean {
  if (!COOKING.includes(order.status) || order.status === 'PENDING') return false;
  const placed = Date.parse(order.$createdAt);
  return Number.isFinite(placed) && now > placed + dueMins * 60_000;
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
  order: { $createdAt: string; subtotal?: number },
  lines: { line_total?: number }[] | undefined,
  now: number = Date.now(),
): 'ready' | 'loading' | 'missing' | 'partial' {
  const placed = Date.parse(order.$createdAt);
  const settled = Number.isFinite(placed) && now - placed > LINES_GRACE_MS;

  if (lines && lines.length > 0) {
    if (linesComplete(order, lines)) return 'ready';
    // Some of them arrived and some did not. Still ordinary for a moment;
    // a lasting fault after that, and a dangerous one, because a ticket that
    // looks whole is a ticket somebody cooks.
    return settled ? 'partial' : 'loading';
  }

  if (!Number.isFinite(placed)) return 'loading';
  return settled ? 'missing' : 'loading';
}

/**
 * Are these all of the order's lines, or only the ones that had been written
 * when somebody asked?
 *
 * An order and its lines are separate writes that land within a moment of each
 * other but not together. A read landing in that moment comes back with some
 * of them, and nothing about that answer says it is incomplete: a ticket with
 * two of three dishes on it looks exactly like an order for two dishes. The
 * cook makes two, the customer is charged for three, and the only person who
 * finds out is the one waiting for the third.
 *
 * The order already carries the answer. `subtotal` is the sum of the line
 * totals, worked out from the whole cart before anything was written, so it is
 * a figure the lines have to add up to. If they do not, some are missing.
 *
 * `>=` rather than exactly equal: a line voided at the till stays on the
 * ticket while the order's subtotal drops, and that must not read as an order
 * that is for ever incomplete. Missing lines can only ever make the sum too
 * small, because no line is worth less than nothing.
 *
 * An order whose subtotal is zero, or absent on an old row, has nothing to
 * check against and is taken at face value.
 */
export function linesComplete(
  order: { subtotal?: number },
  lines: { line_total?: number }[] | undefined,
): boolean {
  if (!lines || lines.length === 0) return false;
  if (!order.subtotal || order.subtotal <= 0) return true;
  return lines.reduce((sum, l) => sum + (l.line_total ?? 0), 0) >= order.subtotal;
}

/* ----------------------------------------------- what was chosen on a line */

/**
 * The options picked on one line, as words a cook can read.
 *
 * Stored as JSON on the line because a line can carry any number of them and
 * a column per option is not a thing. Read here rather than in each screen,
 * for two reasons.
 *
 * The first is that every screen was doing `JSON.parse` inline, unguarded,
 * inside a render. One line with a value that is not JSON — an old row, a
 * half-finished write, anything hand-edited — and the parse throws inside the
 * render, which does not blank the ticket, it blanks the whole kitchen
 * screen. A cook watching every ticket disappear because one of them has a
 * malformed field is a much worse failure than a missing option.
 *
 * The second is that "no onions" and "extra chicken" are cooking instructions,
 * not decoration, and where they are read from should be one place that every
 * screen agrees on.
 */
export function addonNames(raw?: string): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((a) => {
        if (typeof a === 'string') return a;
        const name = (a as { name?: unknown })?.name;
        return typeof name === 'string' ? name : '';
      })
      .filter((n) => n !== '');
  } catch {
    // A line whose options cannot be read is not a line to cook blind. The
    // caller shows the marker below instead of quietly showing nothing.
    return [];
  }
}

/**
 * Were there options that could not be read?
 *
 * Silence and "no options" look identical on a ticket, and only one of them is
 * safe. Something was chosen; if it cannot be turned into words, the cook
 * needs to be told to ask rather than left to assume the dish is plain.
 */
export function addonsUnreadable(raw?: string): boolean {
  if (!raw) return false;
  return addonNames(raw).length === 0;
}

/**
 * The whole wait to quote when the kitchen may not be open yet.
 *
 * Someone ordering at noon from a kitchen that opens at one is not waiting
 * twenty minutes, they are waiting eighty, and quoting them the cooking time
 * alone is a promise that breaks itself an hour before anybody starts cooking.
 * So the closed stretch is counted, and it is counted from the moment the
 * kitchen opens rather than from the moment they pressed send.
 *
 * The two halves are capped differently, on purpose.
 *
 * The hour cap exists because "about ninety-five minutes" is a number nobody
 * believes or plans around — it is a queue estimate, and a queue estimate that
 * long is really an admission that the kitchen does not know. Waiting for
 * opening time is not that. "We open at one, yours will be ready about twenty
 * past" is exact, it is checkable against the door, and a customer can plan
 * their morning around it. Capping that at an hour would turn a precise
 * statement into a wrong one.
 *
 * Uncapped, both halves, and that is the change: this is what the KITCHEN
 * counts down to, and the kitchen's own schedule is not a promise to anybody.
 * Four pre-orders deep, the true time is doors plus everyone ahead plus this
 * order, and judging a cook against a capped figure they were never going to
 * beat is how every ticket on a busy pass goes red through nobody's fault.
 *
 * The cap belongs on the way OUT, in front of the customer, where the reason
 * for it lives — see customerWait. So the two now differ on purpose: the
 * kitchen is given the real schedule, and the customer is given a
 * conservative figure that says "or later" rather than a precise one that is
 * wrong.
 *
 * Takes the closed stretch as a number rather than reading the calendar
 * itself. `minutesUntilOpen` lives with the opening hours, where that question
 * belongs, and keeping it there is what lets this file go on importing nothing.
 */
export function waitIncludingOpening(kitchenMinutes: number, closedMinutes = 0): number {
  return Math.max(0, Math.round(closedMinutes)) + Math.max(1, Math.round(kitchenMinutes));
}

/**
 * What to put in front of this order's customer.
 *
 * Two figures now differ on purpose. `eta_minutes` is the kitchen's real
 * schedule; this is what somebody is told, and the hour cap lives here.
 *
 * The cap is applied to the KITCHEN's share only. Waiting for the doors is
 * added whole, because "we open at one, yours about twenty past" is exact and
 * checkable against the door — the cap exists for queue estimates, which past
 * an hour stop being something anybody believes or plans around.
 *
 * `orLater` is the honest half of capping. Four pre-orders deep the true wait
 * runs past the cap, and quoting a precise time we already know we will miss
 * is worse than saying "about two hours, possibly longer". A number that is
 * quietly wrong costs more than one that admits its own edges.
 *
 * `minutes` is null when there is no estimate at all, so a caller can leave
 * the whole line out rather than print something made up.
 */
export function customerWait(order: {
  eta_minutes?: number;
  opening_wait_minutes?: number;
  placed_while_closed?: boolean;
}): { minutes: number | null; orLater: boolean } {
  if (!order.eta_minutes || order.eta_minutes <= 0) return { minutes: null, orLater: false };

  const doors = Math.max(0, Math.round(order.opening_wait_minutes ?? 0));
  if (doors <= 0) {
    // The ordinary case, unchanged: one capped figure, no caveat.
    return { minutes: shownEta(order.eta_minutes), orLater: false };
  }

  const kitchen = Math.max(1, order.eta_minutes - doors);
  return {
    minutes: doors + Math.min(MAX_ETA_MINUTES, kitchen),
    orLater: kitchen > MAX_ETA_MINUTES,
  };
}

/** The figure alone, for callers that only need a number. */
export const quotedWait = (order: {
  eta_minutes?: number;
  opening_wait_minutes?: number;
  placed_while_closed?: boolean;
}): number | null => customerWait(order).minutes;

/**
 * A wait, in words somebody reads once and acts on.
 *
 * "80 minutes" is arithmetic homework; "1 hour 20 minutes" is a time you can
 * hold in your head against the clock on the wall. Only matters now that a
 * wait can run past an hour at all, which before this it could not.
 */
export function formatWait(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} minute${total === 1 ? '' : 's'}`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  const hourPart = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rest === 0 ? hourPart : `${hourPart} ${rest} minute${rest === 1 ? '' : 's'}`;
}
