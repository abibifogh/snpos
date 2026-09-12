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
 */
export function isGroupPath(pathname: string): boolean {
  const parts = (pathname || '').split('/').filter(Boolean);
  return parts[parts.length - 1] === GROUP_PATH;
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
