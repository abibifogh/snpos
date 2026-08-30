import { Client, Account, Databases, Storage, Teams, ID, Query, Permission, Role } from 'appwrite';
import { chunk, QUERY_VALUES_MAX } from './reading';
import { scopedQueries, scopedPayload, scopedPermissions } from './org';
// What to say when nothing comes back at all. Pure, so both sentences can be
// checked without a browser in front of them.
import { looksUnreachable, unreachableMessage } from './unreachable';

/**
 * One Appwrite client per app, configured from build-time env vars.
 *
 * These values are public by design, they identify the project, they do not
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

/**
 * Where Appwrite lives, so a screen can say which host it could not reach.
 *
 * Public by design — it identifies the project and grants nothing.
 */
export const APPWRITE_ENDPOINT: string = endpoint;

/** Just the host, for a sentence somebody reads. */
export const appwriteHost = (): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
};

/**
 * Is there a server at Appwrite's address at all?
 *
 * THE PLAINEST QUESTION AVAILABLE, and deliberately so. Not a query, not a
 * login, not a health check that needs a key — just whether a request to that
 * host completes. A login can fail for a dozen reasons that say nothing about
 * the wire, and reporting any of them as an outage would send somebody to
 * restart a router over a paused project.
 *
 * `no-cors` because the answer is not read. The response is opaque and
 * useless, which is fine: it RESOLVING means bytes went there and came back,
 * and it THROWING means they did not. That is the whole question, and asking
 * it this way needs no permissions and no cooperation from the other end.
 *
 * Timed out rather than left hanging. A request that never returns is the same
 * outcome as a refused one for the person waiting, and a check with no
 * deadline is a spinner somebody watches instead of an answer.
 */
export async function probeAppwrite(timeoutMs = 8_000): Promise<boolean | null> {
  if (typeof fetch !== 'function') return null;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  try {
    await fetch(endpoint, { mode: 'no-cors', cache: 'no-store', signal: stop.signal });
    return true;
  } catch {
    /*
      Not told apart from an abort on purpose.

      A timeout and a refusal both mean nothing usable came back, and inventing
      a third answer here would only put another branch in front of somebody
      who wants to know whether to check the wifi.
    */
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const client = new Client().setEndpoint(endpoint).setProject(project);
export const account = new Account(client);
export const storage = new Storage(client);
export const teams = new Teams(client);

const rawDb = new Databases(client);

/**
 * The database, with the current hotel applied to everything.
 *
 * One database holds every hotel, so a query that forgets to say whose rows it
 * wants is not a slow query; it is one hotel reading another's takings. There
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
  //, so the permissions written at creation are already the whole answer.
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
/**
 * Whether Appwrite has ever answered this browser from this address.
 *
 * Not statistics. A "could not reach" message has to guess between an address
 * that was never registered and a service that has stopped answering, and it
 * used to ask the person to work that out — which sends an owner whose app has
 * been running for months to check a platform list where the entry is already
 * there.
 *
 * KEPT ON THE DEVICE, and that is the whole point of it.
 *
 * It began as a variable, reset by every page load, on the reasoning that by
 * the time anything can fail a read has already succeeded. That is true
 * everywhere except the one screen where this message matters most: the sign-in
 * page, where NOTHING has been read yet. So a till that has been selling for
 * months, reloaded on a morning when the wifi is down, was told its address had
 * never worked and sent to register a platform that has been registered since
 * the day it was set up — while the actual cause, sitting in the same sentence,
 * read as an afterthought.
 *
 * Per hostname, because that is what the claim is about. The staging address
 * having worked says nothing about the live one.
 *
 * Every read and write of it is wrapped: a browser with site data blocked
 * throws on the accessor itself, and the honest fallback is "we do not know",
 * which is the message that names both causes.
 */
const REACHED_KEY = 'snpos.reached';

const hostKey = (): string => {
  try {
    return `${REACHED_KEY}.${window.location.hostname}`;
  } catch {
    return REACHED_KEY;
  }
};

let everReached = ((): boolean => {
  try {
    return window.localStorage.getItem(hostKey()) === '1';
  } catch {
    return false;
  }
})();

/** Called wherever a request comes back, so the error text can stop guessing. */
export const noteReachable = () => {
  if (everReached) return;
  everReached = true;
  try {
    window.localStorage.setItem(hostKey(), '1');
  } catch {
    // Nothing to do. The message is a shade less specific on this device and
    // nothing else about the app changes, which is not worth a failed write
    // reaching anybody.
  }
};
export const hasReachedAppwrite = () => everReached;

export async function listAll<T>(collectionId: string, queries: string[] = []): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await db.listDocuments(DB_ID, collectionId, [...queries, Query.limit(100), Query.offset(offset)]);
    noteReachable();
    out.push(...(page.documents as unknown as T[]));
    if (page.documents.length < 100 || out.length >= page.total) return out;
  }
}

/**
 * Is there at least one row like this?
 *
 * One row, not all of them. Several screens were answering a yes-or-no
 * question by fetching an entire table and looking at its length — the
 * dashboard read every order, every receipt and every notice ever written
 * purely to decide whether to show a warning that the background jobs had
 * never run.
 *
 * Returns the total as well, because "is there any" and "how many" are the
 * same query and the caller usually wants one of them.
 */
export async function anyExists(
  collectionId: string,
  queries: string[] = [],
): Promise<{ any: boolean; total: number }> {
  const page = await db.listDocuments(DB_ID, collectionId, [...queries, Query.limit(1)]);
  noteReachable();
  return { any: page.total > 0, total: page.total };
}

/**
 * Rows created inside a window, narrowed by the database rather than here.
 *
 * The screens that needed this were reading an entire table and filtering it
 * in the browser afterwards, which reads a year of history to show a week of
 * it — and reads it again every time the page is opened.
 *
 * `$createdAt` on purpose: it is what those screens were already filtering on,
 * so the window means exactly what it meant before. Anything that should be
 * grouped by a different date (a journal entry carries the date the money
 * moved, not the day the row was written) must say so itself.
 */
export async function listCreatedBetween<T>(
  collectionId: string,
  fromIso: string,
  toIso: string,
  extra: string[] = [],
): Promise<T[]> {
  return listAll<T>(collectionId, [
    ...extra,
    Query.greaterThanEqual('$createdAt', fromIso),
    Query.lessThanEqual('$createdAt', toIso),
  ]);
}

/**
 * The children of rows already found: an order's lines, an order's payments.
 *
 * Asked for by their parents' ids rather than by fetching the whole table and
 * matching afterwards. Chunked, because one query cannot carry four hundred
 * ids and Appwrite rejects an over-long one outright — so a busy month would
 * fail while a quiet one worked, which gets reported as "broken sometimes".
 *
 * No ids means no queries. Sending an empty list matches everything on some
 * databases and nothing on others, and neither is what was asked for.
 */
export async function listByIds<T>(
  collectionId: string,
  field: string,
  ids: string[],
  extra: string[] = [],
): Promise<T[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const batches = chunk(unique, QUERY_VALUES_MAX);
  const pages = await Promise.all(
    batches.map((batch) => listAll<T>(collectionId, [...extra, Query.equal(field, batch)])),
  );
  return pages.flat();
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
 * dropped comes back, for the caller to mention if it matters, a note that is
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
 * A write whose failure is counted rather than swallowed.
 *
 * There are places here where one failed write genuinely must not stop the
 * run: a stocktake of forty items, a shift close half-way through settling
 * the shelf. Throwing would leave the job abandoned in the middle, which is
 * worse than finishing it imperfectly, so those calls end in `.catch(() =>
 * undefined)` and carry on.
 *
 * The cost of that was paid twice, by the same people, before anybody saw it.
 * A stocktake wrote two rows the database refused for an unknown value in a
 * fixed list; both were swallowed, the screen said the count was done, and
 * every stocktake for weeks corrected nothing and explained nothing. The
 * feature had never worked and looked exactly like a feature that worked.
 *
 * So a swallowed write is still counted. `ok` says whether it landed, and the
 * caller adds up what did not and tells somebody — a job that half worked has
 * to say which half, or it is indistinguishable from one that worked.
 */
export async function tryWrite(work: Promise<unknown>): Promise<boolean> {
  try {
    await work;
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn an Appwrite failure into something a person can act on.
 *
 * The browser reports a blocked cross-origin request as an ordinary network
 * failure — it cannot see the response at all — so "the server is down",
 * "this device is offline" and "this address is not registered in Appwrite"
 * arrive here as the same thing, and nothing can tell them apart from inside
 * the page.
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
   * stranger. Either the session expired, or it was never kept, private
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
  if (/Document with the requested ID could not be found/i.test(msg)) return 'That record no longer exists; it may have been deleted.';
  if (/already exists/i.test(msg)) return 'Something with that name or code already exists.';
  if (/Rate limit/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';

  /*
    Several causes, and the browser cannot tell them apart. Which one to print
    first depends on whether Appwrite has ever answered this device from here —
    see unreachable.ts, where both sentences live so they can be checked
    without a browser.
  */
  if (looksUnreachable(msg)) {
    let host = '';
    try {
      host = window.location.hostname;
    } catch {
      // Not in a browser. The message still reads correctly without a name.
    }
    /*
      Asked here rather than inside the message, so the sentence stays pure and
      testable. Free and instant: no probe, no waiting, and it settles the
      commonest cause outright — see unreachableMessage, which trusts a false
      and never a true.
    */
    let online: boolean | undefined;
    try {
      online = window.navigator.onLine;
    } catch {
      // Not in a browser, or a browser that will not say. Left undefined, and
      // the message goes back to naming the possibilities in order.
    }
    return unreachableMessage(host, everReached, online);
  }

  return msg;
}
