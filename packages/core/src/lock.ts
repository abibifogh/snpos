/**
 * Locking a till on purpose.
 *
 * The idle screen next door is a screensaver: it appears when nothing has
 * happened and any touch dismisses it. That is the right behaviour for a
 * counter between customers, and it is not a lock — it keeps a bright menu off
 * the panel, not people out of the till.
 *
 * This is the other thing. Somebody steps away from an open shift with a
 * drawer under it and presses a button, and getting back in costs a PIN. Same
 * face, so nobody has to learn a second screen; entirely different door.
 *
 * TWO RULES SHAPE IT.
 *
 * A lock nobody can open is a broken till, not a secure one. If no member of
 * staff has a PIN set, locking would strand whoever is standing there with a
 * shift open and a queue in front of them, and the only way back would be to
 * clear the browser's storage. So it is refused, and says why.
 *
 * And it survives a reload. A lock that a refresh clears is a lock that
 * anybody clears, since reloading a page is not a skill. Which means the
 * locked state lives on the device, not in a variable.
 *
 * Pure. Nothing here reads or writes; the caller owns the storage.
 */

export interface Unlocker {
  $id: string;
  display_name: string;
  pin_hash?: string;
  active?: boolean;
}

/** Where a device remembers that it is locked. Per venue and per side. */
export const lockKey = (venueId: string, module: string): string =>
  `snpos.locked.${venueId}.${module}`;

/**
 * Who could open this till again.
 *
 * Anybody on the staff with a PIN, not only whoever locked it. A till is a
 * place rather than a person's laptop: the whole reason it gets locked is that
 * somebody is walking away from it, and the person who comes back is often the
 * next one on. A lock only its owner could open would be worked around within
 * a day by not locking it.
 */
export const unlockers = (staff: Unlocker[]): Unlocker[] =>
  staff.filter((s) => s.active !== false && !!s.pin_hash);

/**
 * Why this till must not be locked, or nothing.
 *
 * The one case that matters is nobody having a PIN. Refused rather than
 * warned about: a warning here is dismissed by the person who then cannot get
 * back in, and the cost lands on whoever is holding the queue.
 */
export function lockProblem(staff: Unlocker[]): string | null {
  if (unlockers(staff).length === 0) {
    return 'Nobody has a PIN set, so a locked till could not be opened again. '
      + 'Set PINs under Staff in the admin app first.';
  }
  return null;
}

/** The longest a PIN can be. Matches what the staff form accepts. */
export const PIN_MAX = 6;

/** Add a digit, ignoring anything that is not one and stopping at the limit. */
export function pushDigit(entry: string, digit: string): string {
  if (!/^[0-9]$/.test(digit)) return entry;
  return entry.length >= PIN_MAX ? entry : entry + digit;
}

export const dropDigit = (entry: string): string => entry.slice(0, -1);

/**
 * Whether this is even worth checking against a stored PIN.
 *
 * Four digits is the shortest the staff form allows, so anything below that
 * cannot match and hashing it would only be a slower way of saying no. It also
 * keeps the pad from flashing "wrong PIN" at somebody who is still typing.
 */
export const PIN_MIN = 4;
export const worthChecking = (entry: string): boolean => entry.length >= PIN_MIN;

/**
 * How long to make somebody wait after wrong guesses.
 *
 * A four-digit PIN is ten thousand combinations, which a person cannot work
 * through but a bored teenager with a tablet can make a dent in. Backing off
 * after a few tries costs an honest mistyped entry nothing — the first three
 * are free — and turns the rest into an evening's work.
 *
 * Not a lockout. A till that refuses everybody for ten minutes is a till that
 * cannot take money for ten minutes, which is a worse outcome than the thing
 * being defended against.
 */
export function waitAfter(wrongTries: number): number {
  if (wrongTries < 3) return 0;
  // 2, 4, 8… seconds, capped so it never becomes a refusal.
  return Math.min(30_000, 2_000 * 2 ** (wrongTries - 3));
}

/** What to say under the pad, given how it is going. */
export function lockMessage(opts: { wrongTries: number; waitingMs: number }): string | null {
  if (opts.waitingMs > 0) {
    const secs = Math.ceil(opts.waitingMs / 1000);
    return `Wait ${secs} second${secs === 1 ? '' : 's'} and try again.`;
  }
  if (opts.wrongTries > 0) return 'That PIN was not recognised.';
  return null;
}
