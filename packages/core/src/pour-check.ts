/**
 * Whether anything at all takes this off the shelf when a drink is sold.
 *
 * A bar count reports a difference between what should be there and what is.
 * That number is only worth reading if the "should be" side is alive — and
 * there are three ways for it to be quietly dead, none of which says a word:
 *
 *   NO RECIPE      Nothing links the drink somebody rang up to the bottle it
 *                  came out of. The sale is recorded, the money is right, and
 *                  the shelf is never touched. The count then reports the whole
 *                  night's sales as a shortage, every night, for ever.
 *   NOTHING SELLS IT
 *                  The stock item exists and no drink on the menu consumes it.
 *                  Sometimes right — a thing bought for the kitchen and stored
 *                  behind the bar — and sometimes a drink nobody finished
 *                  setting up.
 *   NOT MARKED BAR The drink is not on the bar's side of the business, so the
 *                  bar's pour skips it. Usually a drink added before the bar
 *                  existed, which reads perfectly normally on every screen.
 *
 * A shortage from any of these looks exactly like a shortage from over-pouring
 * or from theft, and the difference matters enormously: one is a conversation
 * with a bartender and the other is ten minutes in the admin screen. So the
 * count says which it is looking at, rather than leaving somebody to work it
 * out from a number that cannot tell them.
 *
 * Pure. Imports nothing at runtime.
 */

/** A recipe row, as far as this question is concerned. */
export interface PourRow {
  menu_item_id?: string;
  addon_option_id?: string;
  ingredient_id: string;
  qty_per_unit?: number;
}

/** A drink, as far as this question is concerned. */
export interface PourItem {
  $id: string;
  name: string;
  active?: boolean;
  /** Absent has always meant the kitchen. The bar's pour wants it said. */
  module?: string;
}

export type PourState =
  /** Something on the menu takes this off the shelf. The count is trustworthy. */
  | 'pours'
  /** A drink names this, but the drink is not on the bar's side. */
  | 'not-on-the-bar'
  /** Nothing on the menu names this ingredient at all. */
  | 'nothing-sells-it';

/**
 * What happens to this stock item when the thing it is in gets sold.
 *
 * A single drink that pours it is enough for 'pours': the question is whether
 * the shelf moves at all, not whether every route to it is wired up.
 */
export function pourState(
  ingredientId: string,
  recipes: PourRow[],
  items: PourItem[],
): PourState {
  const names = recipes.filter((r) => r.ingredient_id === ingredientId && (r.qty_per_unit ?? 0) > 0);
  if (names.length === 0) return 'nothing-sells-it';

  const byId = new Map(items.map((i) => [i.$id, i]));
  for (const r of names) {
    // An add-on's recipe pours through whatever dish it was added to, so it
    // counts on its own: there is no single menu item to look up.
    if (r.addon_option_id) return 'pours';
    const item = r.menu_item_id ? byId.get(r.menu_item_id) : undefined;
    if (!item) continue;
    if (item.active === false) continue;
    // Exactly what the server checks before it pours. Absent is NOT bar here,
    // because absent has always meant the kitchen.
    if (item.module === 'bar') return 'pours';
  }

  // Something names it, but nothing that the bar's pour will ever act on.
  return names.some((r) => r.menu_item_id && byId.has(r.menu_item_id))
    ? 'not-on-the-bar'
    : 'nothing-sells-it';
}

/** A short badge for the count sheet. Null where everything is as it should be. */
export const pourLabel = (state: PourState): string | null =>
  state === 'pours' ? null
    : state === 'not-on-the-bar' ? 'Not set to the bar'
      : 'Nothing sells this';

/**
 * The sentence explaining what the difference beside it actually means.
 *
 * Written to be read by whoever is holding the clipboard, and to end with the
 * thing to go and do.
 */
export function pourWords(state: PourState, name: string): string | null {
  switch (state) {
    case 'not-on-the-bar':
      return `${name} is used by a drink, but that drink is not set to the bar, so selling it takes nothing `
        + 'off this shelf. Open the drink in Drinks & cocktails and set which side of the business it belongs '
        + 'to. Until then any difference here is just what has been sold.';
    case 'nothing-sells-it':
      return `Nothing on the menu is set to use ${name}, so no sale has ever taken any of it off the shelf. `
        + 'If it is sold as a drink, open it in Drinks & cocktails and say how much of this each one uses. '
        + 'If it is only stored here, this is nothing to worry about — but the difference below is not a '
        + 'shortage, it is simply what has gone.';
    default:
      return null;
  }
}

/**
 * How much of the shortage on this sheet is explained by nothing being wired
 * up, rather than by anything having gone missing.
 *
 * The number worth putting at the top. A sheet reporting nine hundred cedis
 * short is alarming; the same sheet saying eight hundred of it is four drinks
 * nobody finished setting up is a job, not an incident.
 */
export function unexplainedByWiring(
  rows: { ingredientId: string; expected: number; countedText?: string; unitCost: number }[],
  state: (ingredientId: string) => PourState,
): { lines: number; value: number } {
  let lines = 0;
  let value = 0;
  for (const row of rows) {
    if (state(row.ingredientId) === 'pours') continue;
    const counted = Number((row.countedText ?? '').trim());
    if (!(row.countedText ?? '').trim() || !Number.isFinite(counted)) continue;
    const diff = counted - row.expected;
    if (diff >= 0) continue;
    lines += 1;
    value += Math.abs(diff) * row.unitCost;
  }
  return { lines, value: Math.round(value) };
}
