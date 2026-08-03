/**
 * The orders this phone has placed.
 *
 * A guest has no account and no way to sign in — that is the whole point of
 * ordering from a sticker on a table. So "my orders" can only mean "the ones
 * this device placed", kept on the device.
 *
 * Deliberately short-lived. This is a record of tonight, not a customer
 * history: somebody who scans the same table code next month should not be
 * shown a meal they have long forgotten, and there is no reason for a shared
 * phone to keep it either.
 */

const KEY = 'snpos-my-orders';
const KEEP_HOURS = 24;

export interface MyOrder {
  id: string;
  no: string;
  at: string;
  venueId: string;
}

export function myOrders(): MyOrder[] {
  try {
    const rows = JSON.parse(localStorage.getItem(KEY) || '[]') as MyOrder[];
    const cutoff = Date.now() - KEEP_HOURS * 3600_000;
    return rows
      .filter((r) => r.id && new Date(r.at).getTime() > cutoff)
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

export function rememberOrder(order: MyOrder): void {
  try {
    // Keyed by id so re-opening the same order does not add it twice, and
    // capped so a busy table cannot fill the device's storage.
    const rows = [order, ...myOrders().filter((r) => r.id !== order.id)].slice(0, 20);
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    // Private browsing, or storage full. The order is placed either way; only
    // the convenience of finding it again is lost.
  }
}

/**
 * The order the address is asking for, if any.
 *
 * Kept in the hash rather than in React state alone, so refreshing the page —
 * or locking the phone and coming back to it — lands on the same screen instead
 * of throwing the guest back to the menu with no way to find their order.
 */
export function orderIdFromHash(): string | null {
  const match = /^#\/order\/([A-Za-z0-9_-]+)/.exec(window.location.hash || '');
  return match ? match[1] : null;
}

export function showOrderInAddress(id: string | null): void {
  const next = id ? `#/order/${id}` : '#/';
  if (window.location.hash !== next) {
    // replaceState rather than pushing: the back button should take a guest
    // out of the app, not walk them backwards through their own order.
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}${next}`);
  }
}
