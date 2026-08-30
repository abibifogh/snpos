/**
 * What to say when the app cannot reach Appwrite at all.
 *
 * The browser reports one thing — the request did not complete — for several
 * unrelated causes, and it cannot tell them apart. So the message has to name
 * them, and the ORDER it names them in is the whole of its usefulness: a person
 * standing at a dead till works down the list from the top, and whichever cause
 * is printed first is the one they spend their morning on.
 *
 * That order depends on one fact the app already knows and used to throw away:
 * whether Appwrite has ever answered this device from this address.
 *
 *   - IT NEVER HAS. Then the likeliest cause by a long way is that the address
 *     was never registered with the project, which is the first thing anybody
 *     misses when setting a new one up.
 *
 *   - IT HAS. Then the address is registered — an address does not quietly
 *     unregister itself — and printing that step first sends an owner to a
 *     platform list to find the entry already there. Do that once and the
 *     message is never read carefully again.
 *
 * Split out of client.ts so both sentences can be checked without a browser or
 * a database. Pure; the caller supplies the hostname.
 */

/**
 * Does this look like the network failing rather than Appwrite refusing?
 *
 * A refusal comes back with a status and a reason, and is worth repeating
 * as-is. This is the other case: nothing came back at all.
 */
export const looksUnreachable = (message: string): boolean =>
  /Network|fetch failed|Failed to fetch|Load failed|NetworkError/i.test(message);

/**
 * What to say, given what is actually known.
 *
 * `online` is the browser's own answer and it is FREE — no probe, no waiting,
 * available at the moment the failure is caught. It is also trustworthy in one
 * direction only: a browser saying it has no network at all is certain, while
 * a browser saying it has one only means it is attached to something, which
 * may be a wifi with no route out or a guest network waiting to be signed
 * into. So a false is an answer and a true is not.
 *
 * That one bit removes almost every reading of this message in practice. A
 * tablet losing its wifi is far and away the commonest cause, and it was being
 * handed a list of three possibilities headed by an Appwrite project and an
 * outage — so somebody stood at a working till reading about plan limits when
 * the router had rebooted.
 */
export function unreachableMessage(
  hostname: string,
  everReached: boolean,
  online?: boolean,
): string {
  const where = hostname || 'this address';

  /*
    KNOWN, so say it and say nothing else.

    No list, no ordering, no mention of Appwrite: none of it is relevant when
    the device is not on a network, and every extra sentence is one more thing
    for somebody to go and check that cannot possibly be wrong.
  */
  if (online === false) {
    return (
      'The internet is down on this device. Nothing is wrong with the till or with the system — check the '
      + 'wifi, the router, or the data on this tablet. Anything already rung up is kept here and sends '
      + 'itself the moment the connection is back, so carry on serving.'
    );
  }

  if (everReached) {
    /*
      The address is known good, so it is not mentioned as something to fix —
      only as the reason the rest of the list is what it is. Ordered by what
      actually goes wrong: a tablet loses wifi far more often than a project
      gets suspended, and both far more often than Appwrite has an outage.
    */
    /*
      The device believes it is on a network, so the wifi is named first but
      not as a certainty — a network with no route out reports itself as
      perfectly online, and that is the likeliest thing on this branch.
    */
    return (
      'Cannot reach the system just now. This device thinks it is online, so either the connection is not '
      + 'really working — a wifi with no internet behind it, or one waiting to be signed into — or the '
      + `service itself is having trouble. It has answered this device from ${where} before, so nothing is `
      + 'set up wrongly and there is nothing to register. Anything already rung up is kept here and sends '
      + 'itself when the connection comes back.'
    );
  }

  return (
    `Could not reach Appwrite from ${where}. `
    + 'If this address has never worked: it needs registering, in the Appwrite console under '
    + `Settings → Platforms, as a Web app with hostname "${where}". `
    + 'If it worked until now: check whether the project is paused or over its plan limits, '
    + 'whether Appwrite itself is having trouble, and whether this device is online.'
  );
}
