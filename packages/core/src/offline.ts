import { db, DB_ID } from './client';

/**
 * Trading through a dropped connection.
 *
 * A till that stops working when the internet does is a till that stops working
 * on the worst night of the year. Mobile data drops, routers reboot mid-service,
 * and none of that is a reason to stop taking orders.
 *
 * The shape of the solution matters more than the code. Three rules:
 *
 *   1. Writes are never lost and never silently dropped. A write that cannot
 *      reach the server is put in a queue on the device and replayed, in the
 *      order it was made, the moment the connection returns.
 *   2. Ids are decided by the device, not the server. Appwrite's ID.unique()
 *      already generates client-side, so an order created offline has the same
 *      id it will have online, which means its items can reference it, and a
 *      replay cannot create the same row twice.
 *   3. Nothing pretends. If something is queued rather than saved, the person
 *      standing there is told, and told how many are waiting.
 *
 * What this does not do is let one device see another device's offline work.
 * Two tills out of contact will both take order 12; that is unavoidable without
 * a server, and it is why order numbers are settled centrally on arrival.
 */

const QUEUE_KEY = 'snpos-write-queue';
const SNAPSHOT_PREFIX = 'snpos-snapshot:';
const REJECTED_KEY = 'snpos-write-rejected';

export type QueuedOp =
  | { kind: 'create'; collection: string; id: string; data: Record<string, unknown>; permissions?: string[] }
  | { kind: 'update'; collection: string; id: string; data: Record<string, unknown> };

export interface QueuedWrite {
  /** Ordering is the whole point: an order must land before its items. */
  seq: number;
  at: string;
  op: QueuedOp;
  /** How many times replay has been tried, so a poison row cannot loop for ever. */
  tries: number;
  lastError?: string;
}

let seqCounter = Date.now();

function readQueue(): QueuedWrite[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') as QueuedWrite[];
  } catch {
    return [];
  }
}

function writeQueue(rows: QueuedWrite[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(rows));
  } catch {
    // Storage full or blocked. Nothing useful to do here, and throwing would
    // lose the write that is being saved rather than the ones already safe.
  }
  notify();
}

export const queueLength = (): number => readQueue().length;

type Listener = (n: number) => void;
const listeners = new Set<Listener>();
const notify = () => {
  const n = queueLength();
  for (const l of listeners) l(n);
};

/** Tells you how many writes are waiting, whenever that changes. */
export function onQueueChange(fn: Listener): () => void {
  listeners.add(fn);
  fn(queueLength());
  return () => listeners.delete(fn);
}

/**
 * Is this failure the network, or is it the request?
 *
 * Queueing a write the server actively refused, a validation error, a missing
 * permission, would mean retrying it for ever and telling the user it is
 * "waiting to send" when it is never going to send. Only connection failures
 * are queued; everything else is a real error and is thrown.
 */
export function isOffline(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e ?? '');

  // What a browser says when the request never reached a server at all.
  if (/failed to fetch|networkerror|network request failed|load failed|the internet connection appears|err_internet_disconnected/i.test(message)) {
    return true;
  }
  // Appwrite reports a transport failure as code 0; anything else is an answer.
  if ((e as { code?: number })?.code === 0) return true;

  // navigator.onLine is checked last and only when there is nothing else to go
  // on. Checking it first was a bug: a server that answered, even to refuse, 
  // is not offline, and treating a validation error as one meant queueing a
  // write that could never be accepted and stalling every write behind it.
  if (!message && typeof navigator !== 'undefined' && navigator.onLine === false) return true;

  return false;
}

/** Put a write on the queue, in order. */
export function enqueue(op: QueuedOp): void {
  const rows = readQueue();
  rows.push({ seq: (seqCounter += 1), at: new Date().toISOString(), op, tries: 0 });
  writeQueue(rows);
}

/**
 * Create a document, or queue it if there is no connection.
 *
 * Returns what the document will be once it lands, so the screen can carry on
 * as though it had; the id is already decided, so nothing downstream has to
 * wait to find out what it is.
 */
export async function createOrQueue<T>(
  collection: string,
  id: string,
  data: Record<string, unknown>,
  permissions?: string[],
): Promise<T> {
  try {
    return (await db.createDocument(DB_ID, collection, id, data, permissions)) as unknown as T;
  } catch (e) {
    if (!isOffline(e)) throw e;
    enqueue({ kind: 'create', collection, id, data, permissions });
    // A stand-in with the id it will really have. Marked so anything reading it
    // knows it has not been confirmed yet.
    return {
      $id: id,
      $createdAt: new Date().toISOString(),
      $updatedAt: new Date().toISOString(),
      ...data,
      _queued: true,
    } as unknown as T;
  }
}

export async function updateOrQueue<T>(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<T> {
  try {
    return (await db.updateDocument(DB_ID, collection, id, data)) as unknown as T;
  } catch (e) {
    if (!isOffline(e)) throw e;
    enqueue({ kind: 'update', collection, id, data });
    return { $id: id, ...data, _queued: true } as unknown as T;
  }
}

/**
 * Send everything that is waiting, oldest first.
 *
 * Stops at the first connection failure rather than carrying on: the rest of
 * the queue depends on order, and pushing later writes past an earlier one that
 * has not landed is how an order's items arrive before the order does.
 */
export async function flushQueue(): Promise<{ sent: number; failed: number; remaining: number }> {
  let rows = readQueue().sort((a, b) => a.seq - b.seq);
  let sent = 0;
  let failed = 0;

  while (rows.length > 0) {
    const next = rows[0];
    try {
      if (next.op.kind === 'create') {
        await db.createDocument(DB_ID, next.op.collection, next.op.id, next.op.data, next.op.permissions);
      } else {
        await db.updateDocument(DB_ID, next.op.collection, next.op.id, next.op.data);
      }
      rows = rows.slice(1);
      sent += 1;
    } catch (e) {
      if (isOffline(e)) break; // still down; try again on the next reconnect

      // Already there. A replay that was interrupted after the server accepted
      // it but before the queue was updated is a success, not a failure.
      const message = e instanceof Error ? e.message : String(e);
      if (/already exists/i.test(message)) {
        rows = rows.slice(1);
        sent += 1;
        continue;
      }

      // A genuine refusal. Retried a few times in case it is transient, then
      // dropped from the queue and reported, a row that can never be accepted
      // must not block every write behind it for ever.
      next.tries += 1;
      next.lastError = message;
      if (next.tries >= 3) {
        rows = rows.slice(1);
        failed += 1;
        keepRejected(next);
        console.error('[snpos] giving up on a queued write', next.op, message);
      } else {
        rows = [...rows.slice(1), next];
      }
    }
    writeQueue(rows);
  }

  writeQueue(rows);
  return { sent, failed, remaining: rows.length };
}

/**
 * Keep a copy of something worth reading offline.
 *
 * The menu, the settings, the open orders. Small, and the difference between a
 * kitchen screen that still shows tonight's tickets and one showing a spinner.
 */
/**
 * A write the server would not take, kept rather than thrown away.
 *
 * These are rare and always a bug, a field that no longer exists, a permission
 * that changed. Dropping one silently would mean a real order quietly ceasing
 * to exist, so it is kept where somebody can find it and re-enter it by hand.
 */
function keepRejected(row: QueuedWrite): void {
  try {
    const kept = JSON.parse(localStorage.getItem(REJECTED_KEY) || '[]') as QueuedWrite[];
    kept.push(row);
    localStorage.setItem(REJECTED_KEY, JSON.stringify(kept.slice(-50)));
  } catch {
    // Nothing sensible left to do.
  }
}

/** Writes the server refused, for somebody to look at. */
export function rejectedWrites(): QueuedWrite[] {
  try {
    return JSON.parse(localStorage.getItem(REJECTED_KEY) || '[]') as QueuedWrite[];
  } catch {
    return [];
  }
}

export function clearRejectedWrites(): void {
  try {
    localStorage.removeItem(REJECTED_KEY);
  } catch {
    // Nothing sensible left to do.
  }
}

export function remember<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`${SNAPSHOT_PREFIX}${key}`, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // Not worth failing a successful load over.
  }
}

export function recall<T>(key: string, maxAgeMs = 7 * 86400_000): T | null {
  try {
    const raw = localStorage.getItem(`${SNAPSHOT_PREFIX}${key}`);
    if (!raw) return null;
    const { at, value } = JSON.parse(raw) as { at: number; value: T };
    return Date.now() - at > maxAgeMs ? null : value;
  } catch {
    return null;
  }
}

/**
 * Read from the server, remembering the answer; fall back to what was
 * remembered when the server cannot be reached.
 */
export async function loadWithFallback<T>(key: string, load: () => Promise<T>): Promise<T> {
  try {
    const fresh = await load();
    remember(key, fresh);
    return fresh;
  } catch (e) {
    const cached = recall<T>(key);
    if (cached !== null && isOffline(e)) return cached;
    throw e;
  }
}

/**
 * Watch the connection and drain the queue when it returns.
 *
 * `online` alone is not enough; a device can be on a wifi network that has no
 * route out, and report itself perfectly online, so the queue is also retried
 * on a slow timer whenever anything is waiting.
 */
export function startOfflineSync(): () => void {
  const attempt = () => {
    if (queueLength() === 0) return;
    void flushQueue().catch(() => undefined);
  };

  window.addEventListener('online', attempt);
  const timer = window.setInterval(attempt, 30_000);
  attempt();

  return () => {
    window.removeEventListener('online', attempt);
    window.clearInterval(timer);
  };
}
