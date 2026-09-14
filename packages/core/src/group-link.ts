/**
 * The address a group ordering link lives at.
 *
 * It used to be the ordinary menu with an unguessable token on the end —
 * .../menu/?g=8f3c1a… — which is private, and unreadable, and impossible to
 * give out over a telephone. A front desk hands this link to hotels and
 * events people, and "the menu slash group" is something a person can say out
 * loud and another person can type.
 *
 * THE TRADE IS REAL AND IS THE OWNER'S TO MAKE. A guessable address is a
 * public one: anybody who tries it sees the group menu and its prices. What it
 * does not give them is the ability to book — a booking still needs a contact
 * name, a reservation reference where one is required, and a group large
 * enough, and every one of those is checked when it is sent. The token link
 * keeps working for anybody who would rather hand out something private.
 *
 * Pure. Imports nothing at runtime.
 */

/** The last part of the address that means "the group menu". */
export const GROUP_PATH = 'group';

/**
 * Is this address the group menu?
 *
 * Matched on the final segment so it holds wherever the site is served from:
 * /menu/group on a domain of its own, /snpos/menu/group on github.io, and
 * either of them with a trailing slash, which is what a browser adds when it
 * asks a folder for its index.
 *
 * THE HASH COUNTS TOO, and not as a nicety. This site is served by GitHub
 * Pages, which answers an address with no file behind it from one 404 page at
 * the root — and that page's job is to hand the rest of the address back to
 * the app as a hash, since an app that routes on hashes is the only kind a
 * static host can serve deep links for. So /menu/group arrives as /menu/#/group
 * whenever the real page is missing: before this deploy has run, on a browser
 * holding the old 404 in its cache, or from any link somebody saved in that
 * form. It is the same address and it opens the same menu.
 *
 * Matched on the FIRST segment of the hash rather than on the whole of it,
 * because the group menu is a place a guest stays rather than a page they
 * pass through: they open an order they have just placed, come back out of
 * it, and must land where they were. So #/group/order/<id> is still the group
 * menu, with an order open on top of it. See orderHash.
 */
export function isGroupPath(pathname: string, hash: string = ''): boolean {
  const parts = (pathname || '').split('/').filter(Boolean);
  if (parts[parts.length - 1] === GROUP_PATH) return true;
  const routed = (hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  return routed[0] === GROUP_PATH;
}

/**
 * The address to write when a guest opens an order, or comes back out of one.
 *
 * The group segment is kept through both, which it was not: opening an order
 * from the group menu wrote #/order/<id> over the top of #/group, and coming
 * back out wrote #/ — so the back arrow landed a hotel that had just booked
 * forty covers on the ordinary dinner menu, with no way back to their own
 * prices but to be sent the link again.
 *
 * The path is checked as well as the hash because the group menu is served at
 * a real address too (/menu/group). Where the path already says it, the hash
 * has nothing to add and saying it twice would be noise in somebody's address
 * bar.
 */
export function orderHash(id: string | null, pathname: string, hash: string = ''): string {
  const parts = (pathname || '').split('/').filter(Boolean);
  const onPath = parts[parts.length - 1] === GROUP_PATH;
  const prefix = !onPath && isGroupPath(pathname, hash) ? `/${GROUP_PATH}` : '';
  return id ? `#${prefix}/order/${id}` : `#${prefix}/`;
}

/** The order an address is asking for, wherever the group segment sits. */
export function orderIdInHash(hash: string): string | null {
  const match = new RegExp(`^#(?:/${GROUP_PATH})?/order/([A-Za-z0-9_-]+)`).exec(hash || '');
  return match ? match[1] : null;
}

/**
 * The address to hand somebody, given where the menu lives.
 *
 * Built from the menu's own base so it is right on a custom domain and right
 * in a repository subfolder, without either being written down twice.
 */
export function groupLink(menuBase: string): string {
  return `${(menuBase || '').replace(/\/+$/, '')}/${GROUP_PATH}`;
}
