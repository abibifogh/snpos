import { Client, Account, Databases, Storage, Teams, ID, Query, Permission, Role } from 'appwrite';

/**
 * One Appwrite client per app, configured from build-time env vars.
 *
 * These values are public by design — they identify the project, they do not
 * grant access. All real authorisation happens through sessions and the
 * collection permissions set during provisioning.
 */
const endpoint = import.meta.env.VITE_APPWRITE_ENDPOINT;
const project = import.meta.env.VITE_APPWRITE_PROJECT;

if (!endpoint || !project) {
  throw new Error(
    'Missing VITE_APPWRITE_ENDPOINT or VITE_APPWRITE_PROJECT. Copy .env.example to .env at the repo root.',
  );
}

export const DB_ID = import.meta.env.VITE_DB_ID || 'snpos';

export const client = new Client().setEndpoint(endpoint).setProject(project);
export const account = new Account(client);
export const db = new Databases(client);
export const storage = new Storage(client);
export const teams = new Teams(client);

export { ID, Query, Permission, Role };

/**
 * Read every row, not just the first page.
 *
 * Appwrite returns 25 documents by default. Silently truncating a menu at 25
 * items is the kind of bug that only shows up once a real menu is loaded.
 */
export async function listAll<T>(collectionId: string, queries: string[] = []): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await db.listDocuments(DB_ID, collectionId, [...queries, Query.limit(100), Query.offset(offset)]);
    out.push(...(page.documents as unknown as T[]));
    if (page.documents.length < 100 || out.length >= page.total) return out;
  }
}

/**
 * Write a document, dropping fields the database has never heard of.
 *
 * Appwrite refuses an entire document when one attribute is unknown. That is
 * the right call for a typo, and the wrong one for a field added in this
 * release against a database that has not been provisioned since the last one:
 * a new option nobody has switched on yet takes the whole save down with it,
 * and the failure names a field the person saving has never heard of either.
 *
 * So the unknown fields are shed one at a time and the rest is saved. What was
 * dropped comes back, for the caller to mention if it matters — a note that is
 * missing is worth saying out loud; a field the admin never filled in is not.
 */
export async function saveDropping(
  collectionId: string,
  id: string | null,
  payload: Record<string, unknown>,
): Promise<{ id: string; dropped: string[] }> {
  const body = { ...payload };
  const dropped: string[] = [];

  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      const doc = id
        ? await db.updateDocument(DB_ID, collectionId, id, body)
        : await db.createDocument(DB_ID, collectionId, ID.unique(), body);
      return { id: doc.$id, dropped };
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const unknown = /unknown attribute:?\s*"?([A-Za-z0-9_]+)"?/i.exec(raw);
      if (!unknown || !(unknown[1] in body)) throw e;
      dropped.push(unknown[1]);
      delete body[unknown[1]];
    }
  }
  throw new Error(`Could not save to ${collectionId}.`);
}

/**
 * Turn an Appwrite failure into something a person can act on.
 *
 * The browser reports a blocked cross-origin request as an ordinary network
 * failure — it cannot see the response at all — so "could not reach the
 * server" and "this address is not registered in Appwrite" look identical from
 * here. Since the second is by far the most common cause during setup, the
 * message names it rather than leaving someone to check their wifi.
 */
export function humanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);

  if (/Invalid credentials/i.test(msg)) return 'That email and password combination was not recognised.';
  if (/User .*not found/i.test(msg)) return 'No account exists for that email address.';
  if (/missing scopes|not authorized|unauthorized/i.test(msg)) return 'Your account does not have permission to do that.';
  if (/Document with the requested ID could not be found/i.test(msg)) return 'That record no longer exists — it may have been deleted.';
  if (/already exists/i.test(msg)) return 'Something with that name or code already exists.';
  if (/Rate limit/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';

  if (/Network|fetch failed|Failed to fetch|Load failed|NetworkError/i.test(msg)) {
    return (
      `Could not reach Appwrite from ${window.location.hostname}. ` +
      'The usual cause is that this address is not registered: in the Appwrite console open ' +
      'Settings → Platforms and add a Web app with hostname ' +
      `"${window.location.hostname}". Otherwise check your connection.`
    );
  }

  return msg;
}
