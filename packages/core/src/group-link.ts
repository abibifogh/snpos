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
 * There is no ambiguity to worry about: this app's hash means one other thing,
 * which is #/order/<id>.
 */
export function isGroupPath(pathname: string, hash: string = ''): boolean {
  const parts = (pathname || '').split('/').filter(Boolean);
  if (parts[parts.length - 1] === GROUP_PATH) return true;
  const routed = (hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  return routed.length === 1 && routed[0] === GROUP_PATH;
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
