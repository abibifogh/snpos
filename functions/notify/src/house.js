/**
 * Who "the house" is, when the house has to be told something.
 *
 * A group booked, a group asked for a change, a group called the whole thing
 * off: three messages that must reach the people who run the place. Each of
 * them built its own recipient list, from the same two ingredients, in its own
 * slightly different way — and all of them could quietly come out empty.
 *
 * WHICH IS WHAT HAPPENED. The person who booked got their confirmation every
 * time; nobody here got anything, for bookings or for change requests. Two
 * unrelated code paths failing identically is not two bugs, it is one piece of
 * missing data, and it was this: `email` is optional on a staff profile, and
 * seed-admin.mjs — the script that creates the very first admin, the owner —
 * never wrote it. It had the address in its hand and put it in the Appwrite
 * account only. So the owner's profile said `role: admin` and nothing else
 * anybody could write to, and `profiles.map(p => p.email)` came back empty on
 * a system where everything looked correctly set up.
 *
 * So there are now three places an address can come from, tried in order, and
 * the reason is always recorded:
 *
 *   1. Whatever the owner typed under Features, Group ordering.
 *   2. The admin and manager staff profiles — their `email` field, and where
 *      that is blank, the Appwrite ACCOUNT the profile belongs to. The address
 *      exists there; it was only ever the copy that was missing.
 *   3. The restaurant's own from-address, which the mail provider has already
 *      verified, so it is certain to exist and certain to be read.
 *
 * The pure halves are separated from the halves that read a database, so the
 * parsing can be tested against every shape of bad data without Appwrite, and
 * the gathering can be tested with a fake one.
 */

/* ------------------------------------------------------------------ pure */

/**
 * A typed-in list of addresses, read generously.
 *
 * Somebody filling in a settings box types what they would type into an email
 * client: commas, semicolons, spaces, new lines, and sometimes a name in front
 * of the address. All of that is accepted, and anything that is not an address
 * is dropped rather than handed to the mail server, because one bad entry
 * makes the provider refuse the WHOLE message — which is a silent way to lose
 * every recipient to one person's typo.
 */
export function splitEmails(text) {
  return String(text ?? '')
    .split(/[,;\s]+/)
    .map((piece) => {
      // "Michael <michael@example.com>" is a perfectly ordinary thing to paste.
      const angled = /<([^>]+)>/.exec(piece);
      return (angled ? angled[1] : piece).trim().replace(/^[<"']+|[>"']+$/g, '');
    })
    .filter((piece) => looksLikeEmail(piece));
}

/** Good enough to keep the mail server from refusing the message. */
export const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? '').trim());

/**
 * The list, in order, with nobody twice.
 *
 * Case-insensitive on the comparison and original on the way out, so an owner
 * who typed Michael@ under settings and michael@ on their profile is one
 * person rather than two copies of the same email.
 */
export function dedupeEmails(addresses) {
  const seen = new Set();
  const out = [];
  for (const raw of addresses) {
    const address = String(raw ?? '').trim();
    if (!looksLikeEmail(address)) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

/**
 * Everyone to tell, and how we came to that answer.
 *
 * `why` is not decoration. When this comes back empty, or comes back as the
 * fallback alone, somebody has to be able to find out why without reading a
 * function's log — so the sentence travels with the list and is written onto
 * the notice row. See main.js.
 *
 * @typedef {object} StaffProfile
 * @property {string} [email]
 * @property {string} [user_id]
 * @property {string} [display_name]
 * @property {string} [role]
 * @property {boolean} [active]
 *
 * @param {object} [input]
 * @param {string} [input.configured]
 * @param {StaffProfile[]} [input.profiles]
 * @param {string} [input.fallback]
 * @returns {{ to: string[], usedFallback: boolean, why: string }}
 */
export function houseEmails({ configured = '', profiles = [], fallback = '' } = {}) {
  const named = splitEmails(configured);
  // A profile that has been switched off is not somebody to email about
  // tonight's booking. Absent means active, as it does everywhere else.
  const working = profiles.filter((p) => p && p.active !== false);
  const fromProfiles = dedupeEmails(working.map((p) => p.email));

  const to = dedupeEmails([...named, ...fromProfiles]);
  if (to.length > 0) {
    return {
      to,
      usedFallback: false,
      why: `${to.length} address${to.length === 1 ? '' : 'es'}: `
        + `${named.length} set under group ordering, ${fromProfiles.length} from staff profiles.`,
    };
  }

  if (looksLikeEmail(fallback)) {
    return {
      to: [String(fallback).trim()],
      usedFallback: true,
      why: `No admin or manager has an email address on their staff profile and nothing is set under `
        + `Admin, Features, Group ordering, so this went to ${fallback} instead. `
        + 'Put an address on the staff profiles, or name one under group ordering.',
    };
  }

  return {
    to: [],
    usedFallback: false,
    why: 'Nobody here could be told: no admin or manager has an email address on their staff profile, '
      + 'nothing is set under Admin, Features, Group ordering, and the restaurant has no from-address either.',
  };
}

/* ------------------------------------------------- the half that reads */

/**
 * The staff who should hear about a group, with their addresses filled in.
 *
 * Takes what it needs as arguments rather than reaching for a module-level
 * client, so the whole path can be driven by a test with a fake database and a
 * fake accounts service — which is the only way this was ever going to be
 * checked without booking a real party.
 *
 * THE ACCOUNT LOOKUP IS THE REPAIR. A profile with no `email` still knows
 * which Appwrite user it belongs to, and that user has an address, because
 * signing in is impossible without one. Copying it across at the moment of
 * sending fixes every profile written before the field was filled in —
 * including the owner's — with nobody having to edit anything.
 *
 * @param {object} input
 * @param {{ listDocuments: (db: string, table: string, queries: any[]) => Promise<{ documents?: StaffProfile[] }> }} input.db
 * @param {{ get: (id: string) => Promise<{ email?: string }> } | undefined} [input.users]
 * @param {string} input.DB_ID
 * @param {any} input.Query
 * @param {string} [input.configured]
 * @param {string} [input.fallback]
 * @param {(message: string) => unknown} [input.log]
 * @returns {Promise<{ to: string[], usedFallback: boolean, why: string }>}
 */
export async function houseRecipients({
  db, users, DB_ID, Query, configured = '', fallback = '', log = () => {},
}) {
  let profiles = [];
  try {
    const rows = await db.listDocuments(DB_ID, 'staff_profiles', [
      Query.equal('role', ['admin', 'manager']),
      Query.limit(50),
    ]);
    profiles = rows.documents ?? [];
  } catch (e) {
    // Said out loud rather than swallowed. A failing lookup and an empty one
    // produced the same silence, and they have completely different fixes.
    log(`Could not read the staff list, so only configured addresses will be used: ${e.message}`);
  }

  /*
    Fill in the blanks from the accounts.

    Only for profiles that have no usable address of their own, and only where
    there is a user to ask about — an invited profile has no account yet, and
    that is not a fault, it is somebody who has not accepted.
  */
  const filled = await Promise.all(profiles.map(async (p) => {
    if (looksLikeEmail(p.email) || !p.user_id || !users) return p;
    try {
      const account = await users.get(p.user_id);
      if (looksLikeEmail(account?.email)) {
        log(`${p.display_name || p.user_id} has no email on their staff profile; used the one on their `
          + 'sign-in account. Worth putting it on the profile.');
        return { ...p, email: account.email };
      }
    } catch (e) {
      log(`Could not read the account behind ${p.display_name || p.user_id}: ${e.message}`);
    }
    return p;
  }));

  return houseEmails({ configured, profiles: filled, fallback });
}

/* --------------------------------------------------- sending it to them */

/**
 * One message each, rather than one message to everybody.
 *
 * `to: list.join(',')` is how this was sent, and it is all-or-nothing at the
 * provider: ONE address it dislikes — a typo, a name pasted in, a mailbox that
 * has been closed, a domain that no longer resolves — and the whole message is
 * refused. Every other recipient loses it, and the log says one thing went
 * wrong rather than "three people were not told".
 *
 * That is the wrong trade for a message about money and a party of forty. So
 * each address is sent its own copy and each is reported on its own: one bad
 * address costs that address and nobody else.
 *
 * The cost is real and small — four recipients is four sends rather than one,
 * on a job with a sixty-second timeout and nothing else to do.
 *
 * @param {object} input
 * @param {string[]} input.to
 * @param {(address: string) => Promise<unknown>} input.send
 * @param {(message: string) => unknown} [input.log]
 * @returns {Promise<{ sent: string[], failed: { address: string, why: string }[], why: string }>}
 */
export async function sendToEach({ to = [], send, log = () => {} }) {
  const sent = [];
  const failed = [];

  for (const address of to) {
    try {
      await send(address);
      sent.push(address);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      failed.push({ address, why });
      log(`Could not send to ${address}: ${why}`);
    }
  }

  const why = failed.length === 0
    ? `Sent to ${sent.length} ${sent.length === 1 ? 'address' : 'addresses'}.`
    : `Sent to ${sent.length} of ${to.length}. Refused: ${
      failed.map((f) => `${f.address} (${f.why})`).join('; ')}`;

  return { sent, failed, why };
}
