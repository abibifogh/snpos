/**
 * Working out WHICH of the three it is, instead of listing all three.
 *
 * The "could not reach Appwrite" message names three causes — the device is
 * offline, the project is paused or over its limits, or Appwrite itself is
 * having trouble — because the browser genuinely cannot tell them apart from a
 * failed request. That is honest, and it is also three rounds of guessing for
 * somebody standing at a dead till who wants to open up.
 *
 * The browser cannot tell them apart from THAT request. It can tell them apart
 * by asking a different question, and the answers are cheap:
 *
 *   - Does this device think it has a network at all?
 *   - Can anything reach the Appwrite server, at the plainest possible level —
 *     not a query, not a login, just "is there a server there"?
 *
 * Those two, plus the failure already in hand, pin it down:
 *
 *   NO NETWORK        → the tablet. Wifi, the router, the data bundle.
 *   NETWORK, NO SERVER → between here and Appwrite. Their outage, or something
 *                        in the middle: a captive portal, a filtered network.
 *   SERVER ANSWERS     → the wire is fine and the project is refusing. Paused,
 *                        over its plan limits, or the request itself was bad.
 *
 * The third is the one worth separating hardest, because it is the only one
 * where nothing about the shop's own equipment or line is wrong and every
 * minute spent restarting a router is a minute wasted.
 *
 * Pure. The caller does the probing; this decides what the answers mean.
 */

export type Reach =
  /** The device says it has no network at all. */
  | 'device-offline'
  /** There is a network, but nothing answered at Appwrite's address. */
  | 'no-server'
  /** Something answered. The wire is fine; the project or the request is not. */
  | 'server-answers'
  /** The check itself could not be made. */
  | 'unknown';

export interface ReachProbe {
  /** What the browser says about having a network. Pessimistic; see below. */
  online: boolean;
  /**
   * Whether anything at all answered at Appwrite's address.
   *
   * Deliberately the plainest question available: not a query, not a login,
   * just whether a request to that host completes. A login can fail for a
   * dozen reasons that say nothing about the wire, and every one of them would
   * be reported here as an outage.
   *
   * Null when the probe could not be run.
   */
  answered: boolean | null;
}

/**
 * What the two answers add up to.
 *
 * `online` is trusted only when it says NO. Browsers report true for any
 * network at all — a wifi with no route out, a captive portal that has not
 * been signed into — so a true here means "worth asking further", never "the
 * internet is fine".
 */
export function diagnose(probe: ReachProbe): Reach {
  if (!probe.online) return 'device-offline';
  if (probe.answered === null) return 'unknown';
  return probe.answered ? 'server-answers' : 'no-server';
}

/**
 * What to do about it, in the order it should be done.
 *
 * One answer, not a list. The whole point of asking is to stop handing
 * somebody three possibilities and a shrug.
 */
export function reachWords(reach: Reach, host = 'the server'): string {
  switch (reach) {
    case 'device-offline':
      return 'This device has no network. It is not Appwrite and it is nothing to do with the till — check '
        + 'the wifi, the router, or the data on this tablet. Everything comes back on its own once it is '
        + 'connected.';
    case 'no-server':
      return `This device is on a network, but nothing answered at ${host}. Either Appwrite is down, or `
        + 'something between here and it is blocking the way — a guest wifi that wants signing into, or a '
        + 'network that filters where it can reach. Try this device on a phone hotspot: if it works there, '
        + 'the fault is the network in the building.';
    case 'server-answers':
      return `${host} answered, so the connection is fine and nothing on this device or your network is `
        + 'wrong. The project itself is refusing the request — the usual cause is an Appwrite project that '
        + 'has been paused, or one that has gone over its plan limits. Open the Appwrite console and look '
        + 'at the project.';
    default:
      return 'The check could not be made, which usually means the network dropped part-way through. '
        + 'Try it again.';
  }
}

/** A short label for the result, for a badge beside the words. */
export const reachLabel = (reach: Reach): string =>
  reach === 'device-offline' ? 'This device is offline'
    : reach === 'no-server' ? 'Cannot reach Appwrite'
      : reach === 'server-answers' ? 'Appwrite is answering'
        : 'Could not check';

/** Whether the answer points at the shop's own equipment rather than at Appwrite. */
export const isOursToFix = (reach: Reach): boolean =>
  reach === 'device-offline' || reach === 'no-server';
