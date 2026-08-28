/**
 * Whether a shift the till REMEMBERS being open is safe to sell into.
 *
 * Everything else the till needs to open — the settings, the venue, the
 * catalogue, who is signed in — is safe to read from the device's memory when
 * the server cannot be reached, because none of it goes stale in a way that
 * costs money. A price read from an hour-old copy is an hour-old price.
 *
 * The open shift is not like that. It is the thing every sale is filed under,
 * and it is the one fact on the list that another device can change without
 * this one hearing. If the till restores yesterday's shift and rings sales
 * into it, the money lands outside the totals that were counted when that
 * shift was closed — which is exactly the "the figures do not add up" problem,
 * arriving quietly and a day late.
 *
 * So the remembered shift is trusted on a clock. Seen open a few minutes ago,
 * on a till whose network dropped mid-service: certainly still open, and
 * refusing to sell would be the wrong answer. Seen open last night, on a till
 * being switched on this morning: almost certainly closed, and the right
 * answer is to start with no shift and let somebody open one.
 *
 * Pure. The caller does the remembering; this decides what it is worth.
 */

/**
 * How long a remembered open shift may still be sold into.
 *
 * Long enough to cover a whole trading day's worth of a network that comes and
 * goes, short enough that it can never reach across a night. Anything the far
 * side of a close is not a dropped connection any more, it is a new day.
 */
export const SHIFT_TRUST_MS = 12 * 3600_000;

/** What the till kept about the shift it last saw open. */
export interface RememberedShift {
  /** When the till last had this confirmed by the server. */
  seenAt: number;
  /** Whether there was an open shift at all when it last looked. */
  wasOpen: boolean;
}

/**
 * May the till sell into what it remembers?
 *
 * A remembered CLOSED state is never restored as if it were open — "there was
 * no shift" is not something to fall back on, it is the ordinary state of a
 * till waiting to be opened, and the till reaches it anyway by having nothing.
 */
export function trustRememberedShift(
  kept: RememberedShift | null,
  now: number,
  window = SHIFT_TRUST_MS,
): boolean {
  if (!kept || !kept.wasOpen) return false;
  const age = now - kept.seenAt;
  // A stamp from the future is a device whose clock was corrected between the
  // two moments. It says nothing, so it is not treated as fresh.
  if (age < 0) return false;
  return age <= window;
}

/**
 * What to tell whoever is standing there, when the till has opened on what it
 * remembers rather than on what the server says.
 *
 * Said plainly and without alarm. Nothing is broken, sales are being taken and
 * will be sent, and the one thing worth knowing is that the totals on this
 * screen are the ones this device knows about — not the shop's.
 */
export function offlineBootWords(shiftRestored: boolean): string {
  const base = 'No connection, so the till has opened on what it last saw. Sales are being taken and '
    + 'will be sent on their own the moment the connection comes back.';
  return shiftRestored
    ? `${base} The shift shown is the one this device last saw open, and its totals only count what has `
      + 'been rung up here.'
    : `${base} There is no shift open on this device — open one and it will be sent along with the sales.`;
}
