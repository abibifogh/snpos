/**
 * Who is off, and how many may be off at once.
 *
 * A rota has one hard constraint that nothing else in this system models: the
 * building has to be staffed. Everything else about time off is a
 * conversation — who is owed what, whose turn it is, whether a Tuesday matters
 * less than a Saturday — and none of it belongs in software. The floor being
 * empty on the twelfth does.
 *
 * So there is exactly one rule here: no more than a set number of people are
 * off on the same day. The number is the house's, because three is right for a
 * bar with nine staff and wrong for one with four.
 *
 * Two things this deliberately does NOT do:
 *
 *   It does not count only APPROVED leave. A request that is sitting there
 *   unanswered is a person who has told you they expect to be away, and four
 *   of those on one day is the same problem arriving a week later. A pending
 *   request holds its place; that is what makes the refusal honest at the
 *   moment somebody asks rather than at the moment somebody gets round to
 *   deciding.
 *
 *   It does not decide WHO gets the day. First asked, first held — and an
 *   admin can refuse any of them and free the place up. Ranking people by
 *   seniority or by how much leave they have left is a judgement about a
 *   person, and a screen that made it silently would be resented, correctly.
 *
 * Pure. Imports nothing at runtime.
 */

/** Off for a reason, or simply not available. Both take up a place. */
export type LeaveKind = 'leave' | 'unavailable';

export type LeaveStatus =
  /** Asked for, nobody has answered. Holds a place. */
  | 'requested'
  /** Agreed. Holds a place. */
  | 'approved'
  /** Turned down. Holds nothing. */
  | 'refused'
  /** Taken back by the person who asked. Holds nothing. */
  | 'withdrawn';

/** One person, one day. A range is several of these under one request id. */
export interface LeaveDay {
  $id?: string;
  /** Groups the days somebody asked for in one go. */
  request_id?: string;
  staff_id: string;
  staff_name?: string;
  /** The day itself, as YYYY-MM-DD. Local, because a rota is local. */
  day: string;
  kind?: LeaveKind;
  status?: LeaveStatus;
  reason?: string;
  /** Written at the moment of asking, so first-asked-first-held is decidable. */
  asked_at?: string;
  decided_by?: string;
  decided_at?: string;
  /**
   * Why it was refused, kept where the person who was refused can read it.
   *
   * A refusal with no reason on it is the thing this whole feature exists to
   * avoid: somebody goes looking for a manager to ask a question the screen
   * already knew the answer to.
   */
  decided_note?: string;
}

/**
 * How many people may be off on one day, when nobody has said.
 *
 * Three, which is what was asked for. It is a starting point and not a rule
 * about hospitality — see leaveCap, which is where the house's own number
 * wins.
 */
export const LEAVE_CAP_DEFAULT = 3;

/** The most a cap may be set to. Past this it is not a cap, it is off. */
export const LEAVE_CAP_MAX = 99;

/**
 * The house's number, made safe.
 *
 * A cap of nought would mean nobody may ever be off, which is not a rota
 * policy but a stuck screen, so it is not allowed — an admin who wants that
 * should turn the whole thing off rather than set it to nothing. Anything
 * unreadable falls back to the default rather than to no limit: a missing
 * setting must not quietly mean "unlimited", which is the failure that looks
 * like the feature working.
 */
export function leaveCap(setting?: number | string | null): number {
  const n = typeof setting === 'string' ? Number(setting.trim()) : setting;
  if (n === null || n === undefined || !Number.isFinite(n)) return LEAVE_CAP_DEFAULT;
  const whole = Math.floor(n as number);
  if (whole < 1) return 1;
  if (whole > LEAVE_CAP_MAX) return LEAVE_CAP_MAX;
  return whole;
}

/**
 * Does this row take up one of the day's places?
 *
 * Requested and approved do. Refused and withdrawn do not — a refusal that
 * went on holding a place would shrink the rota by one every time somebody
 * asked for a day they could not have.
 */
export const holdsAPlace = (row: Pick<LeaveDay, 'status'>): boolean =>
  (row.status ?? 'requested') === 'requested' || row.status === 'approved';

/** Everybody holding a place on one day. */
export const onDay = (rows: LeaveDay[], day: string): LeaveDay[] =>
  rows.filter((r) => r.day === day && holdsAPlace(r));

/** How many places are taken on one day. */
export const takenOnDay = (rows: LeaveDay[], day: string): number => onDay(rows, day).length;

/** Every day from one to the other, inclusive. Plain strings, no timezone. */
export function daysInRange(from: string, to: string, max = 366): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out: string[] = [];
  for (let t = start; t <= end && out.length < max; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** The day as somebody would say it out loud. */
export function dayWords(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

/** A day somebody asked for and cannot have, and why. */
export interface RefusedDay {
  day: string;
  reason: string;
}

export interface LeaveCheck {
  /** The days that can be taken. */
  allowed: string[];
  /** The days that cannot, each with the reason to show. */
  refused: RefusedDay[];
}

/**
 * Which of these days this person may have, and why not for the rest.
 *
 * The reason is the entire point. "Request refused" sends somebody to find a
 * manager to ask a question the screen already knew the answer to, and on a
 * rota that question is asked by everybody, every time.
 *
 * Names are shown or not depending on who is looking. A manager needs to know
 * WHO is already off to judge whether to make room; another waiter does not
 * need a list of their colleagues' business, and giving them one is how a
 * useful screen becomes one people are careful around.
 */
export function checkLeave(opts: {
  days: string[];
  staffId: string;
  /** Every leave row already filed for the days being asked about. */
  existing: LeaveDay[];
  cap: number;
  /** May the person looking see who else is off? */
  showNames?: boolean;
}): LeaveCheck {
  const allowed: string[] = [];
  const refused: RefusedDay[] = [];

  for (const day of [...new Set(opts.days)].sort()) {
    const held = onDay(opts.existing, day);

    // Already asked for this day. Not a cap problem, and telling somebody the
    // day is full when the person filling it is them is nonsense.
    const mine = held.find((r) => r.staff_id === opts.staffId);
    if (mine) {
      refused.push({
        day,
        reason: mine.status === 'approved'
          ? `You are already off on ${dayWords(day)}.`
          : `You have already asked for ${dayWords(day)} and it is still waiting for an answer.`,
      });
      continue;
    }

    if (held.length >= opts.cap) {
      const others = held.map((r) => r.staff_name).filter(Boolean) as string[];
      const who = opts.showNames && others.length > 0
        ? ` (${others.join(', ')})`
        : '';
      refused.push({
        day,
        reason: `${dayWords(day)} is full: ${held.length} ${held.length === 1 ? 'person is' : 'people are'} `
          + `already off or waiting for an answer${who}, and at most ${opts.cap} can be off on one day. `
          + 'Pick another day, or ask a manager whether one of those can be moved.',
      });
      continue;
    }

    allowed.push(day);
  }

  return { allowed, refused };
}

/**
 * What to say when nothing at all could be booked.
 *
 * Its own sentence, because a list of per-day refusals with no summary reads
 * as a screen that did something, and this one did nothing.
 */
export function nothingBookedWords(check: LeaveCheck): string | null {
  if (check.allowed.length > 0 || check.refused.length === 0) return null;
  return check.refused.length === 1
    ? 'That day could not be booked.'
    : `None of those ${check.refused.length} days could be booked.`;
}

/** What to say when some of it went through and some did not. */
export function partlyBookedWords(check: LeaveCheck): string | null {
  if (check.allowed.length === 0 || check.refused.length === 0) return null;
  return `${check.allowed.length} of ${check.allowed.length + check.refused.length} days went through. `
    + `${check.refused.length} could not — see below.`;
}

/**
 * Why a request cannot even be looked at, or null.
 *
 * Checked before the cap, because a request with no days in it or a date in
 * the past is a different mistake with a different fix, and reporting it as a
 * full rota would send somebody hunting for a day that is not the problem.
 */
export function requestProblem(opts: {
  days: string[];
  todayDay: string;
  /** How far ahead leave may be booked. Absent means no limit. */
  maxAheadDays?: number;
}): string | null {
  if (opts.days.length === 0) return 'Pick the day, or the first and last day, you want off.';
  const sorted = [...opts.days].sort();
  if (sorted[0] < opts.todayDay) {
    return 'That is in the past. Time already taken is recorded by a manager rather than requested.';
  }
  if (opts.maxAheadDays !== undefined) {
    const ahead = (Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`)
      - Date.parse(`${opts.todayDay}T00:00:00Z`)) / 86_400_000;
    if (ahead > opts.maxAheadDays) {
      return `That is more than ${opts.maxAheadDays} days ahead. Book it nearer the time.`;
    }
  }
  return null;
}

/** One line per day for the admin's view of a stretch of the rota. */
export interface DayLoad {
  day: string;
  taken: number;
  cap: number;
  full: boolean;
  people: { staffId: string; name: string; status: LeaveStatus; kind: LeaveKind }[];
}

/**
 * The rota's shape over a stretch of days.
 *
 * Days with nobody off are included on purpose. A list that shows only the
 * busy days answers "who is off" and not "can I let somebody off on the
 * fourteenth", and the second is the question an admin actually opens this
 * with.
 */
export function dayLoads(rows: LeaveDay[], days: string[], cap: number): DayLoad[] {
  return days.map((day) => {
    const held = onDay(rows, day);
    return {
      day,
      taken: held.length,
      cap,
      full: held.length >= cap,
      people: held.map((r) => ({
        staffId: r.staff_id,
        name: r.staff_name || 'Somebody no longer named',
        status: (r.status ?? 'requested') as LeaveStatus,
        kind: (r.kind ?? 'leave') as LeaveKind,
      })),
    };
  });
}

/** How a day reads on the admin's list. */
export function loadWords(load: DayLoad): string {
  if (load.taken === 0) return `Nobody off. Room for ${load.cap}.`;
  if (load.full) return `Full: ${load.taken} of ${load.cap}. Nobody else can be booked off.`;
  return `${load.taken} of ${load.cap} off. Room for ${load.cap - load.taken} more.`;
}

/**
 * Whether raising or lowering the cap would leave days already over it.
 *
 * Lowering it does not cancel anybody's leave — that is somebody's plan, and
 * software that quietly unbooked it would be worse than the overbooking — so
 * the days that are now over are named and left for a person to sort out.
 */
export function overCapDays(rows: LeaveDay[], days: string[], cap: number): DayLoad[] {
  return dayLoads(rows, days, cap).filter((d) => d.taken > cap);
}

export function capChangeWords(over: DayLoad[]): string | null {
  if (over.length === 0) return null;
  const list = over.slice(0, 5).map((d) => `${dayWords(d.day)} (${d.taken})`).join(', ');
  return `${over.length} ${over.length === 1 ? 'day is' : 'days are'} already over the new limit: ${list}`
    + `${over.length > 5 ? ', and more' : ''}. Nobody has been unbooked — leave already agreed is somebody's `
    + 'plan. Refuse the ones you want back and the days will come under the limit.';
}
