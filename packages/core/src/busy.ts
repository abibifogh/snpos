/**
 * What to do when more is coming in than can go out.
 *
 * A kitchen at capacity has two problems and they are different. The first is
 * that every quote it gives is now wrong: a customer told twenty minutes
 * while nineteen tickets are waiting has been told a number nobody could
 * meet, and the pass spends the evening explaining it. The second is that
 * past some point another ticket does not make the kitchen slower, it makes
 * the whole service fail — every order late, none of them recoverable.
 *
 * So there are two thresholds and not one. Busy quotes longer. Paused stops
 * taking orders from phones, and only from phones: a person standing at the
 * counter is somebody staff can speak to, and refusing them through a screen
 * while they are looking at you is not a thing this system will do.
 *
 * ## Counted, not remembered
 *
 * The level is worked out from the tickets actually waiting, every time it is
 * asked for. Nothing writes "we are busy now" and nothing has to write "we
 * are not any more" — which is the failure that matters, because the second
 * write is the one a kitchen in the weeds never gets round to.
 *
 * ## Except when somebody says otherwise
 *
 * A cook can see things the ticket count cannot: a fryer down, three people
 * off, a coach party at the door. So the level can be set by hand, and a hand
 * beats the count.
 *
 * That override LAPSES. Somebody pausing at eight on Friday and going home
 * would otherwise have the ordering page dead all Saturday with no sign of
 * why, and the person who could explain it is not at work. It holds for as
 * long as it is set for and then the count takes over again.
 *
 * Pure. Imports nothing at runtime.
 */

export type BusyLevel = 'normal' | 'busy' | 'paused';

export interface BusyConfig {
  /** Whether the ticket count may trip the level on its own. */
  autoTrip: boolean;
  /** Tickets waiting at which quotes get longer. */
  busyAt: number;
  /** Tickets waiting at which orders from phones stop. */
  pauseAt: number;
  /** Added to every quote while busy. */
  extraMinutes: number;
  /** Whether pausing actually holds orders, or only says so. */
  holdWhenPaused: boolean;
  /** What the customer reads. */
  guestMessage: string;
  /** How long a level set by hand lasts before the count takes over again. */
  overrideMinutes: number;
}

export const BUSY_DEFAULTS: BusyConfig = {
  autoTrip: true,
  busyAt: 12,
  pauseAt: 20,
  extraMinutes: 15,
  holdWhenPaused: true,
  guestMessage: 'The kitchen is very busy, your order may take a little longer.',
  overrideMinutes: 60,
};

/** A level somebody set by hand, and when they set it. */
export interface BusyOverride {
  level: BusyLevel;
  at: string;
  by?: string;
}

const RANK: Record<BusyLevel, number> = { normal: 0, busy: 1, paused: 2 };

/** Whether a hand-set level still stands, or has lapsed back to the count. */
export function overrideLive(
  override: BusyOverride | null | undefined,
  cfg: BusyConfig,
  now: number = Date.now(),
): boolean {
  if (!override) return false;
  const at = Date.parse(override.at);
  if (!Number.isFinite(at)) return false;
  // Nought or less means it never lapses, for a kitchen that would rather
  // decide for itself when to start taking orders again.
  if (cfg.overrideMinutes <= 0) return true;
  return now - at < cfg.overrideMinutes * 60_000;
}

/** When a hand-set level gives way to the ticket count, or null if it does not. */
export function overrideEnds(
  override: BusyOverride | null | undefined,
  cfg: BusyConfig,
): Date | null {
  if (!override || cfg.overrideMinutes <= 0) return null;
  const at = Date.parse(override.at);
  return Number.isFinite(at) ? new Date(at + cfg.overrideMinutes * 60_000) : null;
}

/** What the tickets waiting say on their own. */
export function busyFromQueue(waiting: number, cfg: BusyConfig): BusyLevel {
  if (!cfg.autoTrip) return 'normal';
  if (cfg.pauseAt > 0 && waiting >= cfg.pauseAt) return 'paused';
  if (cfg.busyAt > 0 && waiting >= cfg.busyAt) return 'busy';
  return 'normal';
}

/**
 * The level in force.
 *
 * A hand-set level wins while it stands, in both directions: a cook who says
 * "we are fine" with fourteen tickets up has looked at them and knows they
 * are fourteen salads, and a screen that argued back would be a screen the
 * kitchen learns to ignore.
 */
export function busyLevel(input: {
  waiting: number;
  cfg: BusyConfig;
  override?: BusyOverride | null;
  now?: number;
}): BusyLevel {
  const { waiting, cfg, override, now } = input;
  if (overrideLive(override, cfg, now)) return override!.level;
  return busyFromQueue(waiting, cfg);
}

/** Whether orders from phones are held at this level. */
export const holdsOrders = (level: BusyLevel, cfg: BusyConfig): boolean =>
  level === 'paused' && cfg.holdWhenPaused;

/**
 * Minutes added to a quote.
 *
 * Added while paused too, for a business that has chosen to keep taking
 * orders at that level: the kitchen is worse off than busy, not better, and
 * quoting the ordinary wait then would be the one promise certain to break.
 */
export const extraMinutes = (level: BusyLevel, cfg: BusyConfig): number =>
  (level === 'normal' ? 0 : Math.max(0, Math.round(cfg.extraMinutes || 0)));

/**
 * What the customer is told, or nothing.
 *
 * Nothing at all when the kitchen is coping. A restaurant that tells every
 * guest it is busy is a restaurant whose guests stop reading the notice.
 */
export function guestWords(level: BusyLevel, cfg: BusyConfig): string {
  if (level === 'normal') return '';
  if (holdsOrders(level, cfg)) {
    return `${cfg.guestMessage} We have stopped taking orders from phones for a few minutes — please order at the counter.`;
  }
  return cfg.guestMessage;
}

/** The word on the kitchen screen for the level it is in. */
export const LEVEL_WORDS: Record<BusyLevel, string> = {
  normal: 'Keeping up',
  busy: 'Busy',
  paused: 'Not taking orders',
};

/**
 * What the pass is told, and why.
 *
 * Which of the two set it matters more than the level does. A cook looking at
 * "Not taking orders" needs to know whether that is the count doing its job
 * or a manager who decided it half an hour ago, because only one of those
 * goes away on its own.
 */
export function staffWords(input: {
  waiting: number;
  cfg: BusyConfig;
  override?: BusyOverride | null;
  now?: number;
}): string {
  const { waiting, cfg, override, now } = input;
  const level = busyLevel(input);
  if (overrideLive(override, cfg, now)) {
    const ends = overrideEnds(override, cfg);
    const until = ends
      ? ` until ${ends.getHours().toString().padStart(2, '0')}:${ends.getMinutes().toString().padStart(2, '0')}`
      : '';
    return `${LEVEL_WORDS[level]}, set by hand${until}.`;
  }
  if (level === 'normal') {
    return waiting === 1 ? '1 ticket waiting.' : `${waiting} tickets waiting.`;
  }
  const at = level === 'paused' ? cfg.pauseAt : cfg.busyAt;
  return `${LEVEL_WORDS[level]}: ${waiting} tickets waiting, and ${at} is the line.`;
}

/** How to colour it. */
export const levelTone = (level: BusyLevel): 'ok' | 'warn' | 'danger' =>
  (level === 'paused' ? 'danger' : level === 'busy' ? 'warn' : 'ok');

/** Whether one level is worse than another, for anything that has to compare them. */
export const worseThan = (a: BusyLevel, b: BusyLevel): boolean => RANK[a] > RANK[b];
