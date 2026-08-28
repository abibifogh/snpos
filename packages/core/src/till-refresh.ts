/**
 * Keeping a till's catalogue up to date without anybody reloading it.
 *
 * A till is signed in once and left running. It loads the menu at boot and
 * then holds that copy for as long as the tab stays open — which, on a tablet
 * that lives on a counter, is weeks. So a price put up in the office is a
 * price the shop floor keeps charging the old version of, a new product cannot
 * be sold at all, and a piece taken off the menu goes on being rung up. The
 * only fix on offer was "reload the page", which is a thing somebody has to
 * know to do and has no reason to think of.
 *
 * Two things watch for changes, because either one alone is wrong:
 *
 *   - THE LIVE CONNECTION, which is instant and drops silently. A websocket
 *     that has quietly died looks exactly like a shop where nothing has
 *     changed, and the till would go on being confidently out of date.
 *   - A LOOK ON A TIMER, which cannot be instant and cannot lie. It is the
 *     same net the kitchen screen and the order-wake already keep under
 *     themselves, for the same reason.
 *
 * What the timer must NOT be is a full reload of the catalogue every few
 * minutes. Read allowance is not an abstract concern here — it took the whole
 * system down one morning — and a shop with six tills reloading two hundred
 * products all day would be paying, continuously, to learn that nothing has
 * happened. So the look asks the cheapest possible question instead: what is
 * the newest change stamp in the catalogue. One row. Only if that has moved is
 * the menu actually fetched again.
 *
 * Pure. Nothing here reads or writes; the caller owns the clock and the
 * database.
 */

/**
 * The collections a till's screen is drawn from.
 *
 * Prices and names live on the products, the sizes carry their own prices, the
 * categories decide what appears and in what order, and the join rows decide
 * which products sit under which heading. A change to any of them changes what
 * the person at the counter sees, and watching only the products would leave a
 * basket moved to a new shelf invisible until somebody reloaded.
 *
 * Being taken off the menu is not on this list because it does not need to be:
 * it is written onto the product itself, so it arrives with everything else.
 */
export const CATALOGUE_COLLECTIONS = [
  'menu_items',
  'product_variants',
  'categories',
  'menu_item_categories',
] as const;

/**
 * How long to wait after a change before fetching anything.
 *
 * A bulk upload writes two hundred rows and fires two hundred events. Without
 * this the till would fetch the whole catalogue two hundred times, mid-upload,
 * arriving at a half-written menu on most of those attempts. Waiting for the
 * writing to stop and then looking once is both cheaper and more correct.
 *
 * Two and a half seconds is long enough to swallow a bulk write and short
 * enough that a single price correction reaches the counter while the person
 * who made it is still looking at the screen.
 */
export const SETTLE_MS = 2_500;

/**
 * How often to ask whether anything changed, when nothing has said so.
 *
 * Ten minutes, and the number was three until a shop started seeing "could
 * not reach Appwrite" on and off through a day. Whether that was the cause is
 * not established — a paused project or a plan limit reached by everything
 * else the business does are likelier — but this is the one part of it under
 * this system's control, and buying insurance against it costs nothing worth
 * having.
 *
 * Nothing is lost by the change. THE LIVE CONNECTION IS THE FAST PATH: a price
 * put up in the office reaches the counter in seconds through it, and always
 * did. This look exists only for the case where that connection has quietly
 * died, which is rare, and ten minutes of being out of date in that rare case
 * is a far better trade than four reads every three minutes on every till in
 * the building, all day, to be told nothing has happened.
 *
 * The tab coming back to the front still looks immediately, which covers the
 * moment somebody actually picks the till up.
 */
export const LOOK_EVERY_MS = 600_000;

/**
 * The newest change stamp in a set of rows.
 *
 * Appwrite stamps every document with `$updatedAt`, so "has the catalogue
 * moved" is answerable without reading the catalogue. A row with no stamp
 * contributes nothing rather than an empty string that would sort below
 * everything and hide a real change.
 */
export function newestStamp(rows: { $updatedAt?: string }[]): string {
  let newest = '';
  for (const row of rows) {
    const at = row.$updatedAt ?? '';
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * Should the till fetch the catalogue again?
 *
 * NEVER on the first look. Everything is new to a screen that has just loaded
 * its menu, and a till that reloaded on its first tick would reload once at
 * boot for nothing, on every till, every time anybody signs in.
 *
 * A stamp that has gone BACKWARDS is also a change: a product deleted takes
 * the newest stamp with it, and the shop floor should stop offering something
 * that no longer exists just as promptly as it starts offering something new.
 */
export function catalogueMoved(seen: string, now: string): boolean {
  if (!seen) return false;
  if (!now) return false;
  return now !== seen;
}

/**
 * Is this a moment to go and look?
 *
 * A till in a background tab is a till nobody is reading, and a shop that
 * leaves six of them open on a back-office machine should not pay for six
 * catalogues an hour to keep screens nobody can see correct. It looks again
 * the moment the tab is brought back, which is the moment it starts to matter.
 */
export const worthLooking = (hidden: boolean, online: boolean): boolean => !hidden && online;
