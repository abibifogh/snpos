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

export function unreachableMessage(hostname: string, everReached: boolean): string {
  const where = hostname || 'this address';

  if (everReached) {
    /*
      The address is known good, so it is not mentioned as something to fix —
      only as the reason the rest of the list is what it is. Ordered by what
      actually goes wrong: a tablet loses wifi far more often than a project
      gets suspended, and both far more often than Appwrite has an outage.
    */
    return (
      `Could not reach Appwrite. It has answered this device from ${where} before, so the address is set up `
      + 'correctly and nothing needs registering — something has changed since. In the order worth checking: '
      + 'is this device online, is the Appwrite project paused or over its plan limits, and is Appwrite itself '
      + 'having trouble. Nothing was saved, so it is safe to try again.'
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
