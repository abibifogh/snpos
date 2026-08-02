import { client, DB_ID } from './client';

/**
 * Subscribe to changes on a collection.
 *
 * Returns the unsubscribe function; callers must call it on unmount or a
 * long-lived kitchen screen accumulates duplicate handlers and starts alarming
 * several times per order.
 */
export function subscribeCollection<T>(
  collectionId: string,
  handler: (payload: T, events: string[]) => void,
): () => void {
  return client.subscribe(`databases.${DB_ID}.collections.${collectionId}.documents`, (message) => {
    handler(message.payload as T, message.events);
  });
}

export const isCreate = (events: string[]): boolean => events.some((e) => e.endsWith('.create'));
export const isUpdate = (events: string[]): boolean => events.some((e) => e.endsWith('.update'));
export const isDelete = (events: string[]): boolean => events.some((e) => e.endsWith('.delete'));
