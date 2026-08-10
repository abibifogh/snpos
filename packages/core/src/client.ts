import { Client, Account, Databases, Storage, Teams, ID, Query, Permission, Role } from 'appwrite';
import { scopedQueries, scopedPayload, scopedPermissions } from './org';

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
export const storage = new Storage(client);
export const teams = new Teams(client);

const rawDb = new Databases(client);

/**
 * The database, with the current hotel applied to everything.
 *
 * One database holds every hotel, so a query that forgets to say whose rows it
 * wants is not a slow query — it is one hotel reading another's takings. There
 * are 117 places in this codebase that read data, and the honest assessment of
 * "remember to add a filter in all of them, and in everything written from
 * here on" is that it will be forgotten, once, quietly, in a year.
 *
 * So it is not remembered. Every read is filtered and every write is stamped
 * and permissioned here, in the one place they all pass through, and a call
 * site cannot opt out by accident because there is nothing to opt out of.
 *
 * `rawDb` is deliberately not exported. Reaching past this wrapper has to be a
 * decision somebody makes on purpose in this file, in view of this comment.
 */
export const db = {
  listDocuments: (databaseId: string, collectionId: string, queries: string[] = []) =>
    rawDb.listDocuments(databaseId, collectionId, scopedQueries(collectionId, queries)),

  getDocument: (databaseId: string, collectionId: string, documentId: string, queries?: string[]) =>
    rawDb.getDocument(databaseId, collectionId, documentId, queries),

  createDocument: (
    databaseId: string,
    collectionId: string,
    documentId: string,
    data: Record<string, unknown>,
    permissions?: string[],
  ) =>
    rawDb.createDocument(
      databaseId,
      collectionId,
      documentId,
      scopedPayload(collectionId, data),
      scopedPermissions(collectionId, permissions ?? []),
    ),

  // Update and delete are left alone on purpose. Both name one document by id,
  // and Appwrite will not hand over a document this session's team cannot read
  // — so the permissions written at creation are already the whole answer.
  updateDocument: (
    databaseId: string,
    collectionId: string,
    documentId: string,
    data?: Record<string, unknown>,
    permissions?: string[],
  ) => rawDb.updateDocument(databaseId, collectionId, documentId, data, permissions),

  deleteDocument: (databaseId: string, collectionId: string, documentId: string) =>
    rawDb.deleteDocument(databaseId, collectionId, documentId),
};

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
  /**
   * Appwrite's own words for this are "Missing "create" permission for the role
   * "users". Only ["any","guests"] scopes are allowed and ["users"] was given",
   * which a customer holding a menu cannot be expected to make anything of.
   *
   * It always means the same thing: this browser is talking to the server as a
   * stranger. Either the session expired, or it was never kept — private
   * browsing and blocked cookies both accept a sign-in and then remember none
   * of it. Reloading is the fix in the first case and the diagnosis in the
   * second, so it leads.
   */
  if (/permission for the role/i.test(msg)) {
    return (
      'Your session has ended. Reload the page and try again. ' +
      'If it keeps happening, private browsing or blocked cookies are the usual cause.'
    );
  }
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
